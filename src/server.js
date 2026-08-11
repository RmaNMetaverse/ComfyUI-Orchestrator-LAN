/**
 * The web UI's back end: a small JSON API plus a server-sent-events stream that
 * pushes log lines and progress to the browser while a run is going.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

import { clientFor, ComfyClient } from './client.js';
import {
  COLLECT_DEFAULTS, ConfigError, emptyFleet, loadFleet, normalizeJob, resolveAssignments, saveFleet,
} from './config.js';
import { DEFAULT_PORTS, scan } from './discover.js';
import { FleetSupervisor } from './fleet.js';
import { APP_ROOT, FLEET_PATH, JOBS_DIR, PUBLIC_DIR, UI_STATE_PATH, WORKFLOW_DIR } from './paths.js';
import { pick } from './picker.js';
import { checkMachine, describeMissing, summarize } from './preflight.js';
import { assetNames, safeName } from './runner.js';
import { Workflow, WorkflowError } from './workflow.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const LOG_LIMIT = 3000;

let cachedVersion = null;
function appVersion() {
  if (cachedVersion === null) {
    try {
      cachedVersion = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version || '?';
    } catch {
      cachedVersion = '?';
    }
  }
  return cachedVersion;
}

/* ------------------------------------------------------------ run state */

const run = {
  runner: null,
  runId: null,
  busy: false,
  kind: null, // 'run' | 'check'
  log: [],
  manifest: null,
  progress: null,
};

const listeners = new Set();

/**
 * One supervisor for the whole server. It owns the machines and their queues, so work
 * carries on between requests and several machines can be busy with different things.
 */
const fleet = new FleetSupervisor({
  log: (line) => pushLog(line),
  onChange: (snapshot) => broadcast({ type: 'fleet', ...snapshot }),
});
try {
  fleet.configure(loadFleet());
} catch {
  /* a broken config is reported through /api/state instead */
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

function pushLog(line) {
  const entry = { line: String(line), at: Date.now() };
  run.log.push(entry);
  if (run.log.length > LOG_LIMIT) run.log.splice(0, run.log.length - LOG_LIMIT);
  broadcast({ type: 'log', ...entry });
}

/* -------------------------------------------------------------- helpers */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

function readUiState() {
  try {
    return JSON.parse(fs.readFileSync(UI_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeUiState(state) {
  fs.mkdirSync(path.dirname(UI_STATE_PATH), { recursive: true });
  fs.writeFileSync(UI_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function clientsFor(config, names) {
  const wanted = names?.length ? new Set(names) : null;
  return config.machines
    .filter((m) => m.enabled && (!wanted || wanted.has(m.name)))
    .map((m) => clientFor(m, { timeout: config.fleet.requestTimeout }));
}

/**
 * Build everything a run or a check needs from what the browser sent.
 * Throws ConfigError / WorkflowError with a message meant for a human.
 */
function prepare(payload) {
  const config = loadFleet();
  const collect = {
    ...COLLECT_DEFAULTS,
    ...config.collect,
    ...(payload.collect || {}),
  };

  const job = normalizeJob(
    {
      name: payload.name || 'job',
      workflows: payload.workflows,
      // still accepted so older saved jobs and scripts keep working
      workflow: payload.workflow,
      assets: payload.assets,
      overrides: payload.overrides,
      assignments: payload.assignments || {},
      mode: payload.mode || 'shard',
      count: payload.count || 1,
      seed: payload.seed ?? 'random',
      collectDestination: collect.destination,
    },
    { baseDir: WORKFLOW_DIR },
  );

  // Load each graph once and apply its own overrides, so a bad override is reported
  // before anything is queued anywhere.
  const applied = [];
  for (const spec of job.workflows) {
    spec.graph = Workflow.load(spec.path);
    for (const line of spec.graph.applyOverrides(spec.overrides)) {
      applied.push(`[${spec.name}] ${line}`);
    }
  }

  const clients = clientsFor(config, payload.machines);
  if (!clients.length) throw new ConfigError('No machines are selected. Add one on the Machines tab and switch it on.');

  // A single workflow with nothing assigned runs everywhere - that is the obvious intent
  // and keeps the simple case simple.
  if (!Object.keys(job.assignments).length) {
    if (job.workflows.length > 1) {
      throw new ConfigError('Assign a workflow to each machine on the Machines tab before running.');
    }
    for (const client of clients) job.assignments[client.name] = job.workflows[0].id;
  }

  const { unassigned } = resolveAssignments(job, clients.map((c) => c.name));
  const usable = clients.filter((c) => job.assignments[c.name]);
  if (!usable.length) {
    throw new ConfigError('No machine has a workflow assigned. Pick one for each machine on the Machines tab.');
  }

  return { config: { ...config, collect }, job, clients: usable, applied, unassigned };
}

/* ------------------------------------------------------------- actions */

/** Check every machine against the workflow it is actually going to run. */
function checkAssigned(job, clients) {
  return Promise.all(
    clients.map(async (client) => {
      const spec = job.workflows.find((w) => w.id === job.assignments[client.name]);
      const report = await checkMachine(client, spec.graph, assetNames(spec));
      return { ...report, workflow: spec.name };
    }),
  );
}

async function startCheck(payload) {
  const { job, clients } = prepare(payload);
  run.busy = true;
  run.kind = 'check';
  broadcast({ type: 'busy', busy: true, kind: 'check' });
  pushLog('');
  pushLog(`checking ${clients.length} machine(s) against the workflow each one will run ...`);

  try {
    const reports = await checkAssigned(job, clients);
    for (const report of [...reports].sort((a, b) => a.machine.localeCompare(b.machine))) {
      if (!report.reachable) {
        pushLog(`  ! ${report.machine}: ${report.error}`);
        continue;
      }
      if (report.ok) {
        pushLog(`  + ${report.machine}: ready for '${report.workflow}' (ComfyUI ${report.comfyuiVersion}, ${report.gpu})`);
        continue;
      }
      pushLog(`  ! ${report.machine}: not ready for '${report.workflow}'`);
      for (const cls of report.missingClasses) pushLog(`      missing custom node: ${cls}`);
      for (const missing of report.missingValues) pushLog(`      ${describeMissingLine(missing)}`);
    }
    const { ready, blocked } = summarize(reports);
    pushLog(`${ready.length} ready, ${blocked.length} not ready`);
    broadcast({ type: 'check', reports });
    return reports;
  } finally {
    run.busy = false;
    run.kind = null;
    broadcast({ type: 'busy', busy: false });
  }
}

/** Advice that matches what actually went wrong, rather than one catch-all sentence. */
function hintsFor(reports) {
  const missing = reports.flatMap((r) => r.missingValues);
  const hints = [];
  if (missing.some((m) => m.kind === 'input')) {
    hints.push("add the input files listed above under Input files, or put them in that machine's ComfyUI\\input folder");
  }
  if (missing.some((m) => m.kind === 'model')) {
    hints.push('copy the missing models to the same relative path under ComfyUI\\models on that machine');
  }
  if (missing.some((m) => m.kind === 'setting')) {
    hints.push('that machine\'s ComfyUI is missing an option this workflow uses - it is usually an older or newer build, or a custom node version difference');
  }
  if (reports.some((r) => r.missingClasses.length)) {
    hints.push('install the missing custom nodes with ComfyUI Manager and restart ComfyUI on that machine');
  }
  hints.push('to run anyway, switch off "Check machines before running" on the Output tab');
  return hints;
}

const describeMissingLine = describeMissing;

/**
 * Register the workflows the browser sent and queue work on the chosen machines.
 * Returns immediately: the supervisor keeps running in the background, and other
 * machines carry on with whatever they were already doing.
 */
async function startWork(payload) {
  const { config, job, clients, applied } = prepare(payload);

  if (config.collect.enabled) {
    try {
      fs.mkdirSync(config.collect.destination, { recursive: true });
    } catch (err) {
      throw new ConfigError(
        `Cannot write to the output location ${config.collect.destination}: ${err.message}. ` +
          'Pick a different folder on the Output tab.',
      );
    }
  }

  fleet.configure(config);
  for (const spec of job.workflows) fleet.setWorkflow(spec);
  for (const line of applied) pushLog(`override: ${line}`);

  if (payload.preflight !== false) {
    const reports = await checkAssigned(job, clients);
    const { ready } = summarize(reports);
    for (const report of reports) {
      if (report.ok) continue;
      pushLog(`  ! skipping ${report.machine} ('${report.workflow}'):`);
      if (report.error) pushLog(`      ${report.error}`);
      for (const cls of report.missingClasses) pushLog(`      custom node not installed: ${cls}`);
      for (const missing of report.missingValues) pushLog(`      ${describeMissing(missing)}`);
    }
    if (!ready.length) {
      pushLog('nothing started - no machine passed the check');
      for (const hint of hintsFor(reports)) pushLog(`hint: ${hint}`);
      throw new ConfigError('No machine passed the check. See the log for what is missing.');
    }
    clients.splice(0, clients.length, ...clients.filter((c) => ready.includes(c.name)));
  }

  // One batch per workflow, carrying each machine's own generation count.
  const batches = [];
  const byWorkflow = new Map();
  for (const client of clients) {
    const id = job.assignments[client.name];
    if (!id) continue;
    if (!byWorkflow.has(id)) byWorkflow.set(id, []);
    byWorkflow.get(id).push(client.name);
  }
  for (const [workflowId, machines] of byWorkflow) {
    // machines can each ask for a different number of generations
    const groups = new Map();
    for (const machine of machines) {
      const count = Math.max(1, Number(payload.counts?.[machine]) || job.count);
      if (!groups.has(count)) groups.set(count, []);
      groups.get(count).push(machine);
    }
    for (const [count, group] of groups) {
      batches.push(fleet.enqueue({ workflowId, machines: group, count, seed: job.seed }));
    }
  }
  return { batches: batches.map((b) => ({ id: b.id, total: b.total, machines: b.machines })) };
}

/* ---------------------------------------------------------------- routes */

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/state' && req.method === 'GET') {
    let config;
    let configError = null;
    try {
      config = loadFleet();
      // If the config was broken when the server started (or was fixed on disk since),
      // pick it up now rather than staying empty until someone presses Save.
      if (!fleet.workers.size && config.machines.length) fleet.configure(config);
    } catch (err) {
      config = emptyFleet();
      configError = err.message;
    }
    return sendJson(res, 200, {
      config,
      ui: readUiState(),
      configError,
      fleet: fleet.snapshot(),
      busy: run.busy,
      kind: run.kind,
      log: run.log.slice(-400),
      platform: process.platform,
      version: appVersion(),
      paths: { fleet: FLEET_PATH, workflows: WORKFLOW_DIR, jobs: JOBS_DIR },
    });
  }

  if (route === '/api/fleet' && req.method === 'PUT') {
    const body = await readBody(req);
    const saved = saveFleet(body);
    fleet.configure(saved); // machines added or removed take effect straight away
    return sendJson(res, 200, { config: saved, fleet: fleet.snapshot() });
  }

  if (route === '/api/ui' && req.method === 'PUT') {
    const body = await readBody(req);
    writeUiState(body);
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/status' && req.method === 'POST') {
    const config = loadFleet();
    const results = await Promise.all(
      config.machines.map(async (machine) => {
        const client = clientFor(machine, { timeout: 8000 });
        try {
          const info = await client.ping();
          return { name: machine.name, online: true, ...info };
        } catch (err) {
          return { name: machine.name, online: false, error: err.message };
        }
      }),
    );
    return sendJson(res, 200, { machines: results });
  }

  if (route === '/api/discover' && req.method === 'POST') {
    const body = await readBody(req);
    const ports = (body.ports || DEFAULT_PORTS).map(Number).filter(Boolean);
    const found = await scan(body.range, { ports, timeout: Number(body.timeout) || 1500 });
    return sendJson(res, 200, { found });
  }

  if (route === '/api/workflow' && req.method === 'POST') {
    const body = await readBody(req);
    let workflow;
    let file = body.path || '';
    if (body.data) {
      // dropped into the browser: keep a copy so runs and job files can refer to it
      workflow = Workflow.parse(body.data);
      fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
      // Drop the extension the browser gave us before adding our own, or a dropped
      // "trimmer.json" is saved as "trimmer.json.json".
      const base = safeName(String(body.name || 'dropped').replace(/\.json$/i, ''), 'workflow');
      file = path.join(WORKFLOW_DIR, `${base}.json`);
      fs.writeFileSync(file, `${JSON.stringify(body.data, null, 2)}\n`, 'utf8');
      workflow.source = file;
    } else {
      workflow = Workflow.load(file);
    }
    return sendJson(res, 200, {
      path: file,
      name: path.basename(file),
      nodeCount: workflow.nodes().length,
      classCount: workflow.classTypes().size,
      seedWidgets: workflow.seedNodes().length,
      assetRefs: [...new Set(workflow.assetRefs().map((r) => r.value))],
      outline: workflow.outline(),
    });
  }

  if (route === '/api/check' && req.method === 'POST') {
    const body = await readBody(req);
    const reports = await startCheck(body);
    return sendJson(res, 200, { reports });
  }

  if (route === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await startWork(body));
  }

  if (route === '/api/machine' && req.method === 'POST') {
    const body = await readBody(req);
    const { machine, action } = body;
    if (!machine || !action) return sendJson(res, 400, { error: 'machine and action are required' });
    if (action === 'pause') fleet.pause(machine);
    else if (action === 'resume') fleet.resume(machine);
    else if (action === 'stop') await fleet.stop(machine);
    else return sendJson(res, 400, { error: `unknown action "${action}"` });
    return sendJson(res, 200, { ok: true, fleet: fleet.snapshot() });
  }

  if (route === '/api/cancel' && req.method === 'POST') {
    pushLog('stopping every machine ...');
    await fleet.stopAll();
    return sendJson(res, 200, { ok: true, fleet: fleet.snapshot() });
  }

  if (route === '/api/free' && req.method === 'POST') {
    const config = loadFleet();
    const body = await readBody(req).catch(() => ({}));
    const results = await Promise.all(
      clientsFor(config, body.machines).map(async (client) => {
        try {
          await client.freeMemory();
          return `  ${client.name}: models unloaded, VRAM freed`;
        } catch (err) {
          return `  ${client.name}: ${err.message}`;
        }
      }),
    );
    results.forEach(pushLog);
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/pick' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const paths = await pick({
        kind: body.kind || 'file',
        filter: body.filter || 'any',
        initial: body.initial || '',
        title: body.title || 'Select',
      });
      return sendJson(res, 200, { paths, cancelled: paths.length === 0 });
    } catch (err) {
      // No dialog available (headless server, or the UI opened from another machine):
      // the browser falls back to letting the person type a path.
      return sendJson(res, 200, { paths: [], unavailable: true, error: err.message });
    }
  }

  if (route === '/api/open' && req.method === 'POST') {
    const body = await readBody(req);
    const target = String(body.path || '');
    if (!target) return sendJson(res, 400, { error: 'no path' });
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch {
      /* opening is best effort */
    }
    const command = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${command} "${target}"`, () => {});
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/job' && req.method === 'POST') {
    // Save the current setup as a job file that `cf run` can use later.
    const body = await readBody(req);
    const { job } = prepare(body);
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    const file = path.join(JOBS_DIR, `${safeName(job.name)}.json`);
    fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    pushLog(`job saved to ${file} - run it later with:  cf run "${file}"`);
    return sendJson(res, 200, { path: file });
  }

  return sendJson(res, 404, { error: `no route ${route}` });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  listeners.add(res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);
  req.on('close', () => {
    clearInterval(heartbeat);
    listeners.delete(res);
  });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(requested).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    // no-store, not no-cache: this is served from the same machine, so there is nothing to
    // gain from caching, and a stale index.html/app.js after an update is very confusing.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/api/events') return handleEvents(req, res);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      return serveStatic(req, res, url);
    } catch (err) {
      const known = err instanceof ConfigError || err instanceof WorkflowError;
      if (!known) console.error(err);
      return sendJson(res, known ? 400 : 500, { error: err.message || String(err) });
    }
  });
}

export function startWeb({ port = 8787, host = '127.0.0.1', open = false } = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const shown = host === '0.0.0.0' ? localAddress() : host;
      console.log(`\n  ComfyFleet is running:  http://${shown}:${port}\n`);
      if (host === '0.0.0.0') {
        console.log('  Reachable from other machines on this network. The API has no password,');
        console.log('  so only do this on a trusted internal network.\n');
      }
      console.log('  Press Ctrl+C to stop.\n');
      if (open) {
        const command = process.platform === 'win32' ? 'start ""' : process.platform === 'darwin' ? 'open' : 'xdg-open';
        exec(`${command} http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, () => {});
      }
      resolve(server);
    });
  });
}

function localAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return 'localhost';
}

export { ComfyClient };
