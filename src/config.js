/**
 * Fleet and job configuration.
 *
 * The Node port keeps configuration in JSON so the tool has zero runtime
 * dependencies - it runs on a bare Node install with nothing to `npm install`.
 */

import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_OUTPUT_DIR, FLEET_PATH } from './paths.js';

export class ConfigError extends Error {}

const MACHINE_DEFAULTS = {
  port: 8000,
  scheme: 'http',
  enabled: true,
  slots: 2,
  note: '',
};

export const FLEET_DEFAULTS = {
  name: 'studio',
  requestTimeout: 20000, // ms for ordinary API calls
  pollInterval: 2000, // ms between completion polls
  stallTimeout: 1800000, // ms before a task is written off
};

export const COLLECT_DEFAULTS = {
  enabled: true,
  destination: DEFAULT_OUTPUT_DIR,
  layout: '{run_id}/{machine}/{filename}',
  overwrite: false,
};

export function baseUrl(machine) {
  return `${machine.scheme || 'http'}://${machine.host}:${machine.port}`;
}

function normalizeMachine(raw, index) {
  if (typeof raw === 'string') raw = parseShorthand(raw);
  if (!raw || typeof raw !== 'object') throw new ConfigError(`bad machine entry: ${JSON.stringify(raw)}`);
  if (!raw.host) throw new ConfigError(`machine entry ${index + 1} has no "host"`);
  const port = Number(raw.port ?? MACHINE_DEFAULTS.port);
  if (!Number.isFinite(port) || port <= 0) throw new ConfigError(`machine ${raw.host}: invalid port`);
  return {
    name: String(raw.name || raw.host),
    host: String(raw.host).trim(),
    port,
    scheme: raw.scheme || MACHINE_DEFAULTS.scheme,
    enabled: raw.enabled !== false,
    slots: Math.max(1, Number(raw.slots ?? MACHINE_DEFAULTS.slots) || 1),
    note: raw.note ? String(raw.note) : '',
  };
}

function parseShorthand(text) {
  const parts = String(text).trim().split(/\s+/);
  const [name, addr] = parts.length === 2 ? parts : [null, parts[0]];
  const [host, port] = addr.split(':');
  return { host, ...(name ? { name } : {}), ...(port ? { port: Number(port) } : {}) };
}

export function emptyFleet() {
  return {
    fleet: { ...FLEET_DEFAULTS },
    collect: { ...COLLECT_DEFAULTS },
    machines: [],
  };
}

export function loadFleet(file = FLEET_PATH) {
  if (!fs.existsSync(file)) return emptyFleet();
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
  return normalizeFleet(raw);
}

export function normalizeFleet(raw) {
  const machines = (raw.machines || []).map(normalizeMachine);
  const seen = new Set();
  for (const machine of machines) {
    const key = machine.name.toLowerCase();
    if (seen.has(key)) throw new ConfigError(`duplicate machine name: ${machine.name}`);
    seen.add(key);
  }
  return {
    fleet: { ...FLEET_DEFAULTS, ...(raw.fleet || {}) },
    collect: { ...COLLECT_DEFAULTS, ...(raw.collect || {}) },
    machines,
  };
}

export function saveFleet(config, file = FLEET_PATH) {
  const normalized = normalizeFleet(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

export function enabledMachines(config, only = null) {
  let picked = config.machines.filter((m) => m.enabled);
  if (only && only.length) {
    const wanted = new Set(only.map((n) => n.toLowerCase()));
    picked = picked.filter((m) => wanted.has(m.name.toLowerCase()) || wanted.has(m.host.toLowerCase()));
    const found = new Set(picked.flatMap((m) => [m.name.toLowerCase(), m.host.toLowerCase()]));
    const missing = [...wanted].filter((n) => !found.has(n));
    if (missing.length) throw new ConfigError(`unknown machine(s): ${missing.join(', ')}`);
  }
  return picked;
}

/* ------------------------------------------------------------------ jobs */

export const JOB_DEFAULTS = {
  name: 'job',
  workflow: '',
  assets: [],
  mode: 'shard', // shard | mirror
  count: 1,
  seed: 'random', // number | 'random' | 'keep'
  overrides: [],
  collectDestination: null,
};

export function normalizeJob(raw, { baseDir = null } = {}) {
  const job = { ...JOB_DEFAULTS, ...(raw || {}) };
  if (!job.workflow) throw new ConfigError('the job has no "workflow"');
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(baseDir || process.cwd(), p));
  job.workflow = resolve(String(job.workflow));
  job.assets = (Array.isArray(job.assets) ? job.assets : [job.assets])
    .filter(Boolean)
    .map((p) => resolve(String(p)));
  if (!['shard', 'mirror'].includes(job.mode)) throw new ConfigError('mode must be "shard" or "mirror"');
  job.count = Math.max(1, Number(job.count) || 1);
  job.overrides = normalizeOverrides(job.overrides);
  if (!job.name || job.name === JOB_DEFAULTS.name) {
    job.name = path.basename(job.workflow).replace(/\.json$/i, '') || 'job';
  }
  return job;
}

export function loadJob(file) {
  if (!fs.existsSync(file)) throw new ConfigError(`job file not found: ${file}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
  return normalizeJob(raw, { baseDir: path.dirname(path.resolve(file)) });
}

/**
 * Overrides select a node by id, by its title in the graph, or by class.
 * Accepts the list form, or the shorthand map { "6.text": "hello" }.
 */
export function normalizeOverrides(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw)) {
    return Object.entries(raw).map(([key, value]) => overrideFromKey(key, value));
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new ConfigError(`bad override: ${JSON.stringify(entry)}`);
    const selectors = ['node', 'title', 'class'].filter((k) => entry[k] !== undefined && entry[k] !== null && entry[k] !== '');
    if (selectors.length !== 1) {
      throw new ConfigError(`an override needs exactly one of node/title/class: ${JSON.stringify(entry)}`);
    }
    if (!entry.field) throw new ConfigError(`override is missing "field": ${JSON.stringify(entry)}`);
    // `!= null` on purpose: an already-normalized override carries explicit nulls for the
    // selectors it does not use, and String(null) would turn those into the text "null".
    return {
      node: entry.node != null ? String(entry.node) : null,
      title: entry.title != null ? String(entry.title) : null,
      class: entry.class != null ? String(entry.class) : null,
      field: String(entry.field),
      value: entry.value,
    };
  });
}

function overrideFromKey(key, value) {
  const dot = key.lastIndexOf('.');
  if (dot <= 0) throw new ConfigError(`override key must look like "<node>.<field>": ${key}`);
  let selector = key.slice(0, dot);
  const field = key.slice(dot + 1);
  if (selector.endsWith('.inputs')) selector = selector.slice(0, -'.inputs'.length);
  if (selector.startsWith('title:')) return { node: null, title: selector.slice(6), class: null, field, value };
  if (selector.startsWith('class:')) return { node: null, title: null, class: selector.slice(6), field, value };
  return { node: selector, title: null, class: null, field, value };
}

export function describeOverride(override) {
  const target = override.node ? override.node : override.title ? `title:${override.title}` : `class:${override.class}`;
  return `${target}.${override.field}`;
}
