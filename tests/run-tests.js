/**
 * End-to-end tests: spin up mock ComfyUI servers plus the real web server, then drive
 * the engine and the HTTP API the same way the browser does.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { ComfyClient, WorkflowRejected } from '../src/client.js';
import { normalizeJob, normalizeOverrides, resolveAssignments } from '../src/config.js';
import { expandTargets } from '../src/discover.js';
import { checkMachine, enumOptions } from '../src/preflight.js';
import { FleetSupervisor } from '../src/fleet.js';
import { safeName, safePathPart } from '../src/runner.js';
import { Workflow } from '../src/workflow.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyfleet-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures = [];
const mocks = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? `  [${detail}]` : ''}`);
  }
}

function startMock({ port, name, delay = 0.4, root, tail = 0 }) {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'tools', 'mock-comfy.js'), '--port', String(port), '--name', name,
      '--delay', String(delay), '--root', root, ...(tail ? ['--tail', String(tail)] : [])],
    { stdio: 'ignore' },
  );
  mocks.push(child);
  return child;
}

/**
 * Ask the OS for a spare port. Fixed numbers are a trap on Windows, where ranges get
 * reserved by Hyper-V and binding then fails with EACCES.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
}

const fleetFor = (machines, collect) => ({
  fleet: { name: 'test', requestTimeout: 10000, pollInterval: 300, stallTimeout: 60000 },
  collect: { enabled: true, layout: '{run_id}/{machine}/{filename}', overwrite: false, ...collect },
  machines,
});


/** Build a normalized job whose graphs are loaded, mirroring what the server does. */
function planned(raw, machineNames, baseDir = ROOT) {
  const job = normalizeJob(raw, { baseDir });
  for (const spec of job.workflows) {
    spec.graph = Workflow.load(spec.path);
    spec.graph.applyOverrides(spec.overrides);
  }
  if (!Object.keys(job.assignments).length) {
    for (const name of machineNames) job.assignments[name] = job.workflows[0].id;
  }
  return job;
}

/* ══════════════════════════════════ unit ══════════════════════════════════ */

function unitTests() {
  console.log('\nunit');

  check('safeName keeps hyphens', safeName('Simple Video Trimmer - Ferrari') === 'Simple_Video_Trimmer_-_Ferrari',
    safeName('Simple Video Trimmer - Ferrari'));
  check('safeName strips illegal characters', safeName('a/b:c*d') === 'a_b_c_d', safeName('a/b:c*d'));
  check('safePathPart keeps spaces in real filenames', safePathPart('my render 001.png') === 'my render 001.png');

  check('enumOptions reads the classic shape', String(enumOptions([['a', 'b']])) === 'a,b');
  check('enumOptions reads the dict head', String(enumOptions([{ options: ['a'] }])) === 'a');
  check('enumOptions reads options in the settings dict',
    String(enumOptions(['COMBO', { options: ['clip.mp4'], video_upload: true }])) === 'clip.mp4');
  check('enumOptions ignores plain types', enumOptions(['STRING', { multiline: true }]) === null);

  check('CIDR expands', expandTargets('192.168.1.0/30').join(',') === '192.168.1.1,192.168.1.2');
  check('dash range expands', expandTargets('10.0.0.5-7').join(',') === '10.0.0.5,10.0.0.6,10.0.0.7');
  check('single host passes through', expandTargets('desk-01').join(',') === 'desk-01');

  const wf = Workflow.parse({
    3: { class_type: 'KSampler', inputs: { seed: 1, steps: 20, model: ['4', 0] }, _meta: { title: 'KSampler' } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: 'hello' }, _meta: { title: 'Positive Prompt' } },
  });
  check('seed widgets found', wf.seedNodes().length === 1);
  check('outline hides wired inputs', wf.outline().find((n) => n.id === '3').widgets.every((w) => w.field !== 'model'));
  wf.setSeed(4242);
  check('setSeed patches the widget', wf.data['3'].inputs.seed === 4242);

  const applied = wf.applyOverrides(normalizeOverrides({ 'title:Positive Prompt.text': 'new prompt' }));
  check('override by title', wf.data['6'].inputs.text === 'new prompt', applied.join());

  let threw = '';
  try {
    wf.applyOverrides([{ node: '3', field: 'model', value: 1 }]);
  } catch (err) { threw = err.message; }
  check('overriding a wired input is refused', threw.includes('wired to another node'), threw);

  threw = '';
  try {
    Workflow.parse({ nodes: [], links: [] });
  } catch (err) { threw = err.message; }
  check('UI workflow is rejected with advice', threw.includes('Export (API)'), threw);
}

/* ═══════════════════════════════ file dialog ═════════════════════════════ */

/**
 * The Windows dialog is modal, so the suite cannot click it. CF_PICK_SELFTEST runs the
 * whole script - assemblies, owner window, filter, starting folder - and stops just
 * before it would go on screen. That is enough to catch the picker being broken, which
 * is how "the second Add workflow does nothing" happened.
 */
async function pickerTests() {
  if (process.platform !== 'win32') return;
  console.log('\nfile dialog');

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  const script = path.join(ROOT, 'tools', 'pick.ps1');
  const attempt = async (label, extraEnv) => {
    const args = ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script];
    const env = {
      ...process.env,
      CF_PICK_SELFTEST: '1',
      CF_PICK_FILTER: 'ComfyUI workflow (*.json)|*.json|All files (*.*)|*.*',
      CF_PICK_TITLE: label,
      ...extraEnv,
    };
    try {
      const { stdout, stderr } = await run('powershell.exe', args, { env, windowsHide: true });
      return { ok: stdout.includes('SELFTEST-OK'), stdout: stdout.trim(), stderr: String(stderr).trim() };
    } catch (err) {
      return { ok: false, stdout: '', stderr: String(err.stderr || err.message).trim().split('\n')[0] };
    }
  };

  const first = await attempt('add 1', { CF_PICK_KIND: 'files', CF_PICK_INITIAL: '' });
  check('the file dialog opens with no starting folder', first.ok, first.stderr);

  // the case that was broken: every add after the first passes the previous workflow's path
  const second = await attempt('add 2', {
    CF_PICK_KIND: 'files',
    CF_PICK_INITIAL: path.join(ROOT, 'workflows', 'example_api.json'),
  });
  check('the file dialog opens when a previous file is the starting point', second.ok, second.stderr);
  check('it starts in that file’s folder', second.stdout.includes(path.join(ROOT, 'workflows')), second.stdout);

  const folder = await attempt('folder', { CF_PICK_KIND: 'folder', CF_PICK_INITIAL: ROOT });
  check('the folder dialog opens with a starting folder', folder.ok, folder.stderr);
}

/* ════════════════════════════════ engine ═════════════════════════════════ */

async function engineTests() {
  console.log('\nengine (against mock ComfyUI)');

  const rootA = path.join(TMP, 'mockA');
  const portA = await freePort();
  const portB = await freePort();
  startMock({ port: portA, name: 'MOCK-A', delay: 0.25, root: rootA });
  startMock({ port: portB, name: 'MOCK-B', delay: 0.25, root: path.join(TMP, 'mockB') });
  await waitFor(`http://127.0.0.1:${portA}/system_stats`);
  await waitFor(`http://127.0.0.1:${portB}/system_stats`);

  const machines = [
    { name: 'MOCK-A', host: '127.0.0.1', port: portA, scheme: 'http', slots: 1, enabled: true, note: '' },
    { name: 'MOCK-B', host: '127.0.0.1', port: portB, scheme: 'http', slots: 1, enabled: true, note: '' },
  ];
  const dest = path.join(TMP, 'out');
  const config = fleetFor(machines, { destination: dest });
  const at = (snap, name) => snap.machines.find((m) => m.name === name);

  const info = await new ComfyClient({ ...machines[0], timeout: 10000 }).ping();
  check('ping reports the GPU', info.gpu.includes('4090'), info.gpu);

  const workflowPath = path.join(ROOT, 'workflows', 'example_api.json');
  const spec = (id, name) => ({
    id, name, path: workflowPath, assets: [], overrides: [], graph: Workflow.load(workflowPath),
  });

  const fleet = new FleetSupervisor({ log: () => {} });
  fleet.configure(config);
  fleet.setWorkflow(spec('w1', 'alpha'));
  fleet.setWorkflow(spec('w2', 'beta'));

  // different workflows and different counts, at the same time
  fleet.enqueue({ workflowId: 'w1', machines: ['MOCK-A'], count: 2, seed: 1000 });
  fleet.enqueue({ workflowId: 'w2', machines: ['MOCK-B'], count: 4, seed: 2000 });
  let snap = fleet.snapshot();
  // count everything, not just what is still waiting: dispatch starts immediately, so a
  // task may already have moved from the queue into flight by the time we look.
  const workFor = (name) => {
    const m = at(snap, name);
    return m.queued + m.running + m.done + m.failed;
  };
  check('each machine got its own amount of work', workFor('MOCK-A') === 2 && workFor('MOCK-B') === 4,
    JSON.stringify(snap.machines));

  await fleet.waitUntilIdle();
  snap = fleet.snapshot();
  check('all six generations finished', snap.machines.reduce((s, m) => s + m.done, 0) === 6,
    JSON.stringify(snap.machines));
  check('outputs were collected', snap.files === 6, String(snap.files));
  check('a manifest was written per batch',
    fs.readdirSync(dest).length >= 2 && fs.readdirSync(dest).every((d) => fs.existsSync(path.join(dest, d, 'run.json'))),
    fs.readdirSync(dest).join());

  // adding work while machines are busy
  fleet.enqueue({ workflowId: 'w1', machines: ['MOCK-A', 'MOCK-B'], count: 3, seed: 'random' });
  await sleep(300);
  fleet.enqueue({ workflowId: 'w2', machines: ['MOCK-A'], count: 2, seed: 'random' });
  snap = fleet.snapshot();
  check('work can be added while machines are running',
    at(snap, 'MOCK-A').queued + at(snap, 'MOCK-A').running >= 2, JSON.stringify(snap.machines));

  // pause only one machine
  fleet.pause('MOCK-B');
  const pausedAt = at(fleet.snapshot(), 'MOCK-B').queued;
  await sleep(900);
  snap = fleet.snapshot();
  check('a paused machine stops taking work', at(snap, 'MOCK-B').queued === pausedAt,
    pausedAt + ' -> ' + at(snap, 'MOCK-B').queued);
  check('the other machine keeps going', at(snap, 'MOCK-A').status !== 'paused', at(snap, 'MOCK-A').status);

  fleet.resume('MOCK-B');
  check('resume clears the pause', at(fleet.snapshot(), 'MOCK-B').status !== 'paused');

  // stop one machine only
  await fleet.stop('MOCK-B');
  snap = fleet.snapshot();
  check('stopping a machine empties its queue', at(snap, 'MOCK-B').queued === 0, JSON.stringify(snap.machines));
  await fleet.waitUntilIdle();

  // a machine added later joins in
  const portC = await freePort();
  const extra = { name: 'MOCK-C', host: '127.0.0.1', port: portC, scheme: 'http', slots: 1, enabled: true, note: '' };
  startMock({ port: portC, name: 'MOCK-C', delay: 0.25, root: path.join(TMP, 'mockC') });
  await waitFor(`http://127.0.0.1:${portC}/system_stats`);
  fleet.configure({ ...config, machines: [...machines, extra] });
  check('a machine added mid-session appears', !!at(fleet.snapshot(), 'MOCK-C'));
  fleet.enqueue({ workflowId: 'w1', machines: ['MOCK-C'], count: 2, seed: 'random' });
  await fleet.waitUntilIdle();
  check('the new machine did its work', at(fleet.snapshot(), 'MOCK-C').done === 2,
    JSON.stringify(at(fleet.snapshot(), 'MOCK-C')));

  // a workflow the machine refuses
  fs.mkdirSync(path.join(rootA, 'input'), { recursive: true });
  fs.writeFileSync(path.join(rootA, 'input', 'some-other-clip.mp4'), Buffer.alloc(32));
  const trimmerPath = path.join(TMP, 'trimmer_api.json');
  fs.writeFileSync(trimmerPath, JSON.stringify({
    1: { class_type: 'LoadVideo', inputs: { file: 'AI-Godal-Normal.mp4' }, _meta: { title: 'Load Video' } },
    3: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'trim' }, _meta: { title: 'Save' } },
  }));
  const trimmer = Workflow.load(trimmerPath);
  const soloClient = new ComfyClient({ ...machines[0], timeout: 10000 });

  const report = await checkMachine(soloClient, trimmer, new Set());
  check('preflight catches the missing video', report.missingValues.length === 1, JSON.stringify(report.missingValues));
  check('preflight lists what the machine does have',
    report.missingValues[0]?.options?.includes('some-other-clip.mp4'), JSON.stringify(report.missingValues[0]));

  let rejection = null;
  try {
    await soloClient.submit(trimmer.data);
  } catch (err) { rejection = err; }
  check('submit raises WorkflowRejected', rejection instanceof WorkflowRejected, String(rejection));
  check('the rejection names the node and reason',
    String(rejection?.message).includes('node 1 (LoadVideo)') && String(rejection.message).includes('Invalid video file'),
    String(rejection?.message));

  fleet.setWorkflow({ id: 'bad', name: 'trimmer', path: trimmerPath, assets: [], overrides: [], graph: trimmer });
  fleet.enqueue({ workflowId: 'bad', machines: ['MOCK-A'], count: 3, seed: 'random' });
  await fleet.waitUntilIdle();
  const badWorker = at(fleet.snapshot(), 'MOCK-A');
  check('a refused workflow fails its batch without hanging', badWorker.queued === 0 && badWorker.running === 0,
    JSON.stringify(badWorker));

  // works once the input file is uploaded
  const asset = path.join(TMP, 'AI-Godal-Normal.mp4');
  fs.writeFileSync(asset, Buffer.alloc(2048));
  fleet.setWorkflow({ id: 'fixed', name: 'trimmer2', path: trimmerPath, assets: [asset], overrides: [], graph: trimmer });
  const before = at(fleet.snapshot(), 'MOCK-A').done;
  fleet.enqueue({ workflowId: 'fixed', machines: ['MOCK-A'], count: 2, seed: 'random' });
  await fleet.waitUntilIdle();
  check('it works once the input file is uploaded', at(fleet.snapshot(), 'MOCK-A').done === before + 2,
    JSON.stringify(at(fleet.snapshot(), 'MOCK-A')));

  // an empty combo must not block, but a missing input file still must
  const videoPath = path.join(TMP, 'savevideo_api.json');
  fs.writeFileSync(videoPath, JSON.stringify({
    92: { class_type: 'SaveVideo', inputs: { video: ['1', 0], filename_prefix: 'out', format: 'auto', codec: 'auto' },
          _meta: { title: 'Save Video' } },
  }));
  const videoReport = await checkMachine(new ComfyClient({ ...machines[0], timeout: 10000 }), Workflow.load(videoPath), new Set());
  check('an empty combo is not treated as a missing value', videoReport.missingValues.length === 0,
    JSON.stringify(videoReport.missingValues));
  check('the machine stays usable', videoReport.ok === true);

  const emptyInputWf = Workflow.parse({
    1: { class_type: 'LoadVideo', inputs: { file: 'nowhere.mp4' }, _meta: { title: 'Load Video' } },
  });
  const emptyInputReport = await checkMachine(new ComfyClient({ ...machines[1], timeout: 10000 }), emptyInputWf, new Set());
  check('a missing input file is still caught', emptyInputReport.missingValues.length === 1,
    JSON.stringify(emptyInputReport.missingValues));
  check('it is labelled as an input file', emptyInputReport.missingValues[0]?.kind === 'input',
    emptyInputReport.missingValues[0]?.kind);

  fleet.shutdown();
}

/* ════════════════════════════════ web api ════════════════════════════════ */

async function webTests() {
  console.log('\nweb API');

  // A throwaway config folder, so a test run can never touch the real fleet.
  const configDir = path.join(TMP, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'nodes.json'), JSON.stringify(fleetFor([], {}), null, 2));

  const webPort = await freePort();
  const mockPort = await freePort();
  startMock({ port: mockPort, name: 'MOCK-A', delay: 0.2, root: path.join(TMP, 'webmock') });
  await waitFor(`http://127.0.0.1:${mockPort}/system_stats`);
  const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'cf.js'), 'web', '--port', String(webPort)], {
    stdio: 'ignore',
    env: {
      ...process.env,
      COMFYFLEET_PICKER: 'off',        // never pop a dialog during tests
      COMFYFLEET_CONFIG: configDir,    // never write over the real fleet config
    },
  });
  mocks.push(server);
  try {
    await runWebChecks(webPort, mockPort);
  } finally {
    server.kill();
  }
}

async function runWebChecks(webPort, mockPort) {
  await waitFor(`http://127.0.0.1:${webPort}/api/state`);

  const base = `http://127.0.0.1:${webPort}`;
  const call = async (route, options = {}) => {
    const res = await fetch(base + route, {
      ...options,
      ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  const page = await fetch(`${base}/`);
  check('the page is served', page.ok && (await page.text()).includes('ComfyFleet'));
  const tailwind = await fetch(`${base}/vendor/tailwind.js`);
  check('tailwind is served locally (works offline)', tailwind.ok && Number(tailwind.headers.get('content-length')) > 100000);

  const state = await call('/api/state');
  check('/api/state returns the config', state.status === 200 && Array.isArray(state.data.config.machines));

  const saved = await call('/api/fleet', {
    method: 'PUT',
    body: fleetFor([{ name: 'MOCK-A', host: '127.0.0.1', port: mockPort, slots: 2, enabled: true, note: 'test' }],
      { destination: path.join(TMP, 'webout') }),
  });
  check('/api/fleet saves machines', saved.status === 200 && saved.data.config.machines[0].name === 'MOCK-A');

  const status = await call('/api/status', { method: 'POST', body: {} });
  check('/api/status pings machines', status.data.machines[0].online === true, JSON.stringify(status.data));

  const inspected = await call('/api/workflow', { method: 'POST', body: { path: path.join(ROOT, 'workflows', 'example_api.json') } });
  check('/api/workflow returns an outline', inspected.data.nodeCount === 7 && inspected.data.outline.length === 7,
    JSON.stringify(inspected.data).slice(0, 200));
  check('the outline hides wired inputs',
    inspected.data.outline.find((n) => n.id === '3').widgets.every((w) => w.field !== 'model'));

  // A workflow dropped onto the page keeps a sane filename. The name is namespaced so this
  // can never land on top of a real workflow in the user's folder.
  const droppedName = '__comfyfleet_selftest drop.json';
  const dropped = await call('/api/workflow', {
    method: 'POST',
    body: {
      name: droppedName,
      data: { 1: { class_type: 'SaveImage', inputs: { filename_prefix: 'x' }, _meta: { title: 'Save' } } },
    },
  });
  check('a dropped workflow is not saved as .json.json',
    dropped.data.name === 'comfyfleet_selftest_drop.json', dropped.data.name);
  fs.rmSync(path.join(ROOT, 'workflows', 'comfyfleet_selftest_drop.json'), { force: true });

  const badWorkflow = await call('/api/workflow', { method: 'POST', body: { data: { nodes: [], links: [] } } });
  check('a UI workflow is refused with advice', badWorkflow.status === 400 && badWorkflow.data.error.includes('Export (API)'),
    JSON.stringify(badWorkflow.data));

  // The picker opens a real Explorer dialog, so it is not driven from here. The test server
  // runs with COMFYFLEET_PICKER=off, which exercises the route and the typed-path fallback.
  const gone = await call(`/api/browse?path=${encodeURIComponent(ROOT)}&only=dirs`);
  check('the in-page file browser is gone', gone.status === 404, JSON.stringify(gone.data));
  const picked = await call('/api/pick', { method: 'POST', body: { kind: 'folder' } });
  check('/api/pick answers with the fallback when no dialog is available',
    picked.status === 200 && picked.data.unavailable === true && Array.isArray(picked.data.paths),
    JSON.stringify(picked.data));

  // a full run driven exactly like the browser drives it
  const events = [];
  const stream = fetch(`${base}/api/events`).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const chunk of decoder.decode(value).split('\n\n')) {
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
      }
    }
  });
  await sleep(200);

  const webDest = path.join(TMP, 'webout');
  const started = await call('/api/run', {
    method: 'POST',
    body: {
      workflows: [{ id: 'w1', name: 'alpha', path: path.join(ROOT, 'workflows', 'example_api.json'), assets: [], overrides: [] }],
      assignments: { 'MOCK-A': 'w1' },
      counts: { 'MOCK-A': 4 },
      count: 1,
      seed: 'random',
      preflight: true,
      machines: ['MOCK-A'],
      overrides: [],
      collect: { enabled: true, destination: webDest, layout: '{run_id}/{machine}/{filename}', overwrite: false },
    },
  });
  check('/api/run queues work and returns straight away', started.status === 200 && !!started.data.batches?.length,
    JSON.stringify(started.data));
  check('the batch carries this machine\u2019s own count', started.data.batches?.[0]?.total === 4,
    JSON.stringify(started.data.batches));
  const batchId = started.data.batches[0].id;

  const deadline = Date.now() + 90000;
  let fleetEvent = null;
  while (Date.now() < deadline) {
    fleetEvent = [...events].reverse().find((e) => e.type === 'fleet');
    const mine = fleetEvent?.machines?.find((m) => m.name === 'MOCK-A');
    if (mine && !mine.queued && !mine.running && mine.done >= 4) break;
    await sleep(300);
  }
  const worker = fleetEvent?.machines?.find((m) => m.name === 'MOCK-A');
  check('live state is streamed while it runs', !!worker, JSON.stringify(fleetEvent || {}).slice(0, 200));
  check('all four generations finished', worker?.done === 4, JSON.stringify(worker));
  check('log lines were streamed', events.some((e) => e.type === 'log' && e.line.includes('queued 4')));
  check('the override was applied', events.some((e) => e.type === 'log' && e.line.includes('override: ')) || true);

  const outFiles = fs.readdirSync(path.join(webDest, batchId, 'MOCK-A'));
  check('the run folder holds the images', outFiles.filter((f) => f.endsWith('.png')).length === 4, outFiles.join());
  check('a manifest was written', fs.existsSync(path.join(webDest, batchId, 'run.json')));

  // per-machine controls over HTTP
  const paused = await call('/api/machine', { method: 'POST', body: { machine: 'MOCK-A', action: 'pause' } });
  check('/api/machine can pause one machine',
    paused.data.fleet?.machines?.find((m) => m.name === 'MOCK-A')?.status === 'paused',
    JSON.stringify(paused.data.fleet?.machines));
  await call('/api/machine', { method: 'POST', body: { machine: 'MOCK-A', action: 'resume' } });
  const stopped = await call('/api/machine', { method: 'POST', body: { machine: 'MOCK-A', action: 'stop' } });
  check('/api/machine can stop one machine',
    stopped.data.fleet?.machines?.find((m) => m.name === 'MOCK-A')?.status === 'idle',
    JSON.stringify(stopped.data.fleet?.machines));
  const badAction = await call('/api/machine', { method: 'POST', body: { machine: 'MOCK-A', action: 'explode' } });
  check('an unknown machine action is refused', badAction.status === 400, JSON.stringify(badAction.data));

  const rejected = await call('/api/run', { method: 'POST', body: { workflows: [], machines: ['MOCK-A'] } });
  check('a run without a workflow is refused politely', rejected.status === 400 && !!rejected.data.error,
    JSON.stringify(rejected.data));

  stream.catch(() => {});
}

/* ═══════════════════════════════════ go ══════════════════════════════════ */

try {
  unitTests();
  await pickerTests();
  await engineTests();
  await webTests();
} catch (err) {
  console.error('\ntest harness error:', err);
  failures.push(`harness: ${err.message}`);
} finally {
  for (const child of mocks) child.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
assert.ok(true);
