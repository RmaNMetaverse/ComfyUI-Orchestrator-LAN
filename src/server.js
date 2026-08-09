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
  COLLECT_DEFAULTS, ConfigError, emptyFleet, loadFleet, normalizeJob, normalizeOverrides, saveFleet,
} from './config.js';
import { DEFAULT_PORTS, scan } from './discover.js';
import { FLEET_PATH, JOBS_DIR, PUBLIC_DIR, UI_STATE_PATH, WORKFLOW_DIR } from './paths.js';
import { pick } from './picker.js';
import { checkMachine, describeMissing, summarize } from './preflight.js';
import { assetNames, Runner, safeName, writeManifest } from './runner.js';
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
      name: payload.name || (payload.workflow ? path.basename(payload.workflow).replace(/\.json$/i, '') : 'job'),
      workflow: payload.workflow,
      assets: payload.assets || [],
      mode: payload.mode || 'shard',
      count: payload.count || 1,
      seed: payload.seed ?? 'random',
      overrides: normalizeOverrides(payload.overrides || []),
      collectDestination: collect.destination,
    },
    { baseDir: WORKFLOW_DIR },
  );

  const workflow = Workflow.load(job.workflow);
  const applied = workflow.applyOverrides(job.overrides);

  const clients = clientsFor(config, payload.machines);
  if (!clients.length) throw new ConfigError('No machines are selected. Add one on the Machines tab and switch it on.');

  return { config: { ...config, collect }, job, workflow, clients, applied };
}

/* ------------------------------------------------------------- actions */

async function startCheck(payload) {
  const { job, workflow, clients } = prepare(payload);
  run.busy = true;
  run.kind = 'check';
  broadcast({ type: 'busy', busy: true, kind: 'check' });
  pushLog('');
  pushLog(`checking ${clients.length} machine(s) for the nodes and files this workflow needs ...`);

  try {
    const uploads = assetNames(job);
    const reports = await Promise.all(clients.map((c) => checkMachine(c, workflow, uploads)));
    for (const report of [...reports].sort((a, b) => a.machine.localeCompare(b.machine))) {
      if (!report.reachable) {
        pushLog(`  ! ${report.machine}: ${report.error}`);
        continue;
      }
      if (report.ok) {
        pushLog(`  + ${report.machine}: ready (ComfyUI ${report.comfyuiVersion}, ${report.gpu})`);
        continue;
      }
      pushLog(`  ! ${report.machine}: not ready`);
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

async function startRun(payload) {
  const { config, job, workflow, clients, applied } = prepare(payload);

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

  const runId = `${timestamp()}-${safeName(job.name)}`;
  run.runId = runId;
  run.busy = true;
  run.kind = 'run';
  run.manifest = null;
  broadcast({ type: 'busy', busy: true, kind: 'run', runId });

  pushLog('');
  pushLog(`=== run ${runId} ===`);
  pushLog(`mode ${job.mode}, count ${job.count}, seed ${job.seed}, ${clients.length} machine(s)`);
  for (const line of applied) pushLog(`override: ${line}`);

  // Kick the actual work off in the background; the browser follows via SSE.
  (async () => {
    let ticker = null;
    try {
      let usable = clients;
      if (payload.preflight !== false) {
        pushLog('preflight ...');
        const uploads = assetNames(job);
        const reports = await Promise.all(clients.map((c) => checkMachine(c, workflow, uploads)));
        const { ready } = summarize(reports);
        for (const report of reports) {
          if (report.ok) continue;
          pushLog(`  ! skipping ${report.machine}:`);
          if (report.error) pushLog(`      ${report.error}`);
          for (const cls of report.missingClasses) pushLog(`      custom node not installed: ${cls}`);
          for (const missing of report.missingValues) pushLog(`      ${describeMissingLine(missing)}`);
        }
        usable = clients.filter((c) => ready.includes(c.name));
        if (!usable.length) {
          pushLog('no usable machines - nothing to run');
          for (const hint of hintsFor(reports)) pushLog(`hint: ${hint}`);
          return;
        }
      }

      const runner = new Runner({
        fleet: config,
        job,
        workflow,
        clients: usable,
        runId,
        log: pushLog,
        collect: config.collect.enabled,
        destRoot: config.collect.destination,
      });
      run.runner = runner;

      ticker = setInterval(() => {
        run.progress = runner.progress();
        broadcast({ type: 'progress', ...run.progress });
      }, 500);

      await runner.uploadAssets();
      runner.buildTasks();
      const manifest = await runner.run();
      run.manifest = manifest;

      pushLog('');
      pushLog(
        `Done in ${manifest.elapsedSeconds}s - ${manifest.tasksSucceeded}/${manifest.tasksTotal} ok, ` +
          `${manifest.tasksFailed} failed, ${manifest.filesCollected} file(s) collected`,
      );
      for (const [machine, stats] of Object.entries(manifest.machines).sort()) {
        const attempts = Math.max(1, stats.success + stats.failed);
        pushLog(
          `  ${machine}: ${stats.success} ok, ${stats.failed} failed, ` +
            `avg ${(stats.seconds / attempts).toFixed(0)}s per task`,
        );
      }
      for (const failure of manifest.failures) {
        pushLog(`  ! task ${failure.task} on ${failure.machine}: ${failure.detail}`);
      }
      for (const err of manifest.collectErrors) pushLog(`  ! download failed: ${err}`);

      if (config.collect.enabled) {
        const file = writeManifest(manifest, config.collect.destination, runId);
        pushLog(`outputs: ${path.join(config.collect.destination, runId)}`);
        if (!file) pushLog('  ! could not write run.json - is the output location writable?');
      }
      broadcast({ type: 'done', manifest });
    } catch (err) {
      pushLog(`run failed: ${err.message}`);
      broadcast({ type: 'done', manifest: null, error: err.message });
    } finally {
      if (ticker) clearInterval(ticker);
      if (run.runner) {
        run.progress = run.runner.progress();
        broadcast({ type: 'progress', ...run.progress });
      }
      run.runner = null;
      run.busy = false;
      run.kind = null;
      broadcast({ type: 'busy', busy: false });
    }
  })();

  return { runId };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---------------------------------------------------------------- routes */

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (route === '/api/state' && req.method === 'GET') {
    let config;
    let configError = null;
    try {
      config = loadFleet();
    } catch (err) {
      config = emptyFleet();
      configError = err.message;
    }
    return sendJson(res, 200, {
      config,
      ui: readUiState(),
      configError,
      busy: run.busy,
      kind: run.kind,
      runId: run.runId,
      progress: run.progress,
      log: run.log.slice(-400),
      platform: process.platform,
      paths: { fleet: FLEET_PATH, workflows: WORKFLOW_DIR, jobs: JOBS_DIR },
    });
  }

  if (route === '/api/fleet' && req.method === 'PUT') {
    const body = await readBody(req);
    const saved = saveFleet(body);
    return sendJson(res, 200, { config: saved });
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
    if (run.busy) return sendJson(res, 409, { error: 'Something is already running.' });
    const body = await readBody(req);
    const reports = await startCheck(body);
    return sendJson(res, 200, { reports });
  }

  if (route === '/api/run' && req.method === 'POST') {
    if (run.busy) return sendJson(res, 409, { error: 'A run is already going.' });
    const body = await readBody(req);
    const started = await startRun(body);
    return sendJson(res, 200, started);
  }

  if (route === '/api/cancel' && req.method === 'POST') {
    if (!run.runner) return sendJson(res, 200, { ok: true, note: 'nothing running' });
    pushLog('stopping - clearing the queue on every machine ...');
    await run.runner.abort();
    return sendJson(res, 200, { ok: true });
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
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
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
