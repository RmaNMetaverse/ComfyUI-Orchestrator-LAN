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
import { fileURLToPath } from 'node:url';

import { ComfyClient, WorkflowRejected } from '../src/client.js';
import { normalizeJob, normalizeOverrides } from '../src/config.js';
import { expandTargets } from '../src/discover.js';
import { checkMachine, enumOptions } from '../src/preflight.js';
import { Runner, safeName, safePathPart } from '../src/runner.js';
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

function startMock({ port, name, delay = 0.4, root }) {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'tools', 'mock-comfy.js'), '--port', String(port), '--name', name, '--delay', String(delay), '--root', root],
    { stdio: 'ignore' },
  );
  mocks.push(child);
  return child;
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

/* ════════════════════════════════ engine ═════════════════════════════════ */

async function engineTests() {
  console.log('\nengine (against mock ComfyUI)');

  const rootA = path.join(TMP, 'mockA');
  const rootB = path.join(TMP, 'mockB');
  startMock({ port: 8841, name: 'MOCK-A', delay: 0.3, root: rootA });
  startMock({ port: 8842, name: 'MOCK-B', delay: 0.8, root: rootB });
  await waitFor('http://127.0.0.1:8841/system_stats');
  await waitFor('http://127.0.0.1:8842/system_stats');

  const machines = [
    { name: 'MOCK-A', host: '127.0.0.1', port: 8841, scheme: 'http', slots: 2, enabled: true, note: '' },
    { name: 'MOCK-B', host: '127.0.0.1', port: 8842, scheme: 'http', slots: 2, enabled: true, note: '' },
  ];
  const clients = machines.map((m) => new ComfyClient({ ...m, timeout: 10000 }));

  const info = await clients[0].ping();
  check('ping reports the GPU', info.gpu.includes('4090'), info.gpu);

  // ---- a normal sharded run
  const workflowPath = path.join(ROOT, 'workflows', 'example_api.json');
  const workflow = Workflow.load(workflowPath);
  const dest = path.join(TMP, 'out');
  const job = normalizeJob({ name: 'shardrun', workflow: workflowPath, mode: 'shard', count: 6, seed: 1000 });
  const lines = [];
  const runner = new Runner({
    fleet: fleetFor(machines, { destination: dest }), job, workflow, clients,
    runId: 'run-shard', log: (l) => lines.push(l), collect: true, destRoot: dest,
  });
  await runner.uploadAssets();
  runner.buildTasks();
  const manifest = await runner.run();

  check('all tasks succeeded', manifest.tasksSucceeded === 6, JSON.stringify(manifest.failures));
  check('every output was collected', manifest.filesCollected === 6, String(manifest.filesCollected));
  check('the faster machine took more work',
    (manifest.machines['MOCK-A']?.success || 0) > (manifest.machines['MOCK-B']?.success || 0),
    JSON.stringify(manifest.machines));
  check('files landed in per-machine folders',
    fs.existsSync(path.join(dest, 'run-shard', 'MOCK-A')) && fs.existsSync(path.join(dest, 'run-shard', 'MOCK-B')));
  check('seeds were distinct per task', new Set(runner.results.map((r) => r.seed)).size === 6);

  // ---- mirror mode
  const mirrorJob = normalizeJob({ name: 'mirror', workflow: workflowPath, mode: 'mirror', count: 2, seed: 7 });
  const mirrorRunner = new Runner({
    fleet: fleetFor(machines, { destination: dest }), job: mirrorJob, workflow,
    clients: machines.map((m) => new ComfyClient({ ...m, timeout: 10000 })),
    runId: 'run-mirror', log: () => {}, collect: false, destRoot: dest,
  });
  await mirrorRunner.uploadAssets();
  mirrorRunner.buildTasks();
  const mirrorManifest = await mirrorRunner.run();
  check('mirror runs the count on every machine', mirrorManifest.tasksTotal === 4, String(mirrorManifest.tasksTotal));
  check('mirror gives each machine the same number', mirrorManifest.machines['MOCK-A'].success === 2
    && mirrorManifest.machines['MOCK-B'].success === 2, JSON.stringify(mirrorManifest.machines));

  // ---- a workflow the machine will refuse (the reported LoadVideo failure)
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
    report.missingValues[0]?.options?.includes('some-other-clip.mp4'), JSON.stringify(report.missingValues[0]?.options));
  check('the machine itself is still reported reachable', report.reachable === true);

  let rejection = null;
  try {
    await soloClient.submit(trimmer.data);
  } catch (err) { rejection = err; }
  check('submit raises WorkflowRejected', rejection instanceof WorkflowRejected, String(rejection));
  check('the rejection names the node and reason',
    String(rejection?.message).includes('node 1 (LoadVideo)') && String(rejection.message).includes('Invalid video file'),
    String(rejection?.message));

  const rejectLines = [];
  const rejectRunner = new Runner({
    fleet: fleetFor([machines[0]], { destination: dest, enabled: false }),
    job: normalizeJob({ name: 'trim', workflow: trimmerPath, mode: 'shard', count: 2, seed: 'random' }),
    workflow: trimmer, clients: [new ComfyClient({ ...machines[0], timeout: 10000 })],
    runId: 'run-reject', log: (l) => rejectLines.push(l), collect: false, destRoot: dest,
  });
  await rejectRunner.uploadAssets();
  rejectRunner.buildTasks();
  const rejectManifest = await rejectRunner.run();
  const rejectLog = rejectLines.join('\n');
  check('a refused workflow is not blamed on the machine', !rejectLog.includes('dropped out'), rejectLog);
  check('the log says the workflow was refused', rejectLog.includes('refused this workflow'), rejectLog);
  check('the log blames the workflow', rejectLog.includes('the problem is the workflow itself'), rejectLog);
  check('tasks that never ran are counted as failed', rejectManifest.tasksFailed === 2, String(rejectManifest.tasksFailed));

  // ---- the same job works once the file is uploaded as an asset
  const asset = path.join(TMP, 'AI-Godal-Normal.mp4');
  fs.writeFileSync(asset, Buffer.alloc(2048));
  const fixedJob = normalizeJob({ name: 'trim2', workflow: trimmerPath, assets: [asset], mode: 'shard', count: 2, seed: 'random' });
  const fixedRunner = new Runner({
    fleet: fleetFor([machines[0]], { destination: dest }), job: fixedJob, workflow: trimmer,
    clients: [new ComfyClient({ ...machines[0], timeout: 10000 })],
    runId: 'run-fixed', log: () => {}, collect: false, destRoot: dest,
  });
  await fixedRunner.uploadAssets();
  fixedRunner.buildTasks();
  const fixedManifest = await fixedRunner.run();
  check('the run works once the input file is uploaded', fixedManifest.tasksSucceeded === 2,
    JSON.stringify(fixedManifest.failures));

  // ---- a combo the machine cannot enumerate must not block the run
  const videoPath = path.join(TMP, 'savevideo_api.json');
  fs.writeFileSync(videoPath, JSON.stringify({
    92: {
      class_type: 'SaveVideo',
      inputs: { video: ['1', 0], filename_prefix: 'out', format: 'auto', codec: 'auto' },
      _meta: { title: 'Save Video' },
    },
  }));
  const videoWf = Workflow.load(videoPath);
  const videoReport = await checkMachine(new ComfyClient({ ...machines[0], timeout: 10000 }), videoWf, new Set());
  check('an empty combo is not treated as a missing value', videoReport.missingValues.length === 0,
    JSON.stringify(videoReport.missingValues));
  check('the machine stays usable', videoReport.ok === true, JSON.stringify(videoReport));

  // ---- but an empty *file* list still counts as missing
  const emptyInputWf = Workflow.parse({
    1: { class_type: 'LoadVideo', inputs: { file: 'nowhere.mp4' }, _meta: { title: 'Load Video' } },
  });
  const emptyInputReport = await checkMachine(
    new ComfyClient({ ...machines[1], timeout: 10000 }), emptyInputWf, new Set());
  check('a missing input file is still caught', emptyInputReport.missingValues.length === 1,
    JSON.stringify(emptyInputReport.missingValues));
  check('it is labelled as an input file', emptyInputReport.missingValues[0]?.kind === 'input',
    emptyInputReport.missingValues[0]?.kind);

  // ---- a machine that dies mid-run
  const rootC = path.join(TMP, 'mockC');
  const dying = startMock({ port: 8843, name: 'MOCK-C', delay: 0.5, root: rootC });
  await waitFor('http://127.0.0.1:8843/system_stats');
  const withDying = [...machines, { name: 'MOCK-C', host: '127.0.0.1', port: 8843, scheme: 'http', slots: 2, enabled: true, note: '' }];
  const dyingRunner = new Runner({
    fleet: fleetFor(withDying, { destination: dest }),
    job: normalizeJob({ name: 'resilient', workflow: workflowPath, mode: 'shard', count: 14, seed: 500 }),
    workflow, clients: withDying.map((m) => new ComfyClient({ ...m, timeout: 5000 })),
    runId: 'run-dying', log: () => {}, collect: false, destRoot: dest,
  });
  await dyingRunner.uploadAssets();
  dyingRunner.buildTasks();
  setTimeout(() => dying.kill(), 900);
  const dyingManifest = await dyingRunner.run();
  check('work is requeued when a machine dies', dyingManifest.tasksSucceeded === 14,
    `${dyingManifest.tasksSucceeded}/14 ${JSON.stringify(dyingManifest.failures)}`);
  check('the dead machine is reported offline', dyingManifest.offline.includes('MOCK-C'), JSON.stringify(dyingManifest.offline));
}

/* ════════════════════════════════ web api ════════════════════════════════ */

async function webTests() {
  console.log('\nweb API');

  const fleetPath = path.join(ROOT, 'config', 'nodes.json');
  const uiPath = path.join(ROOT, 'config', 'ui-state.json');
  const backup = fs.existsSync(fleetPath) ? fs.readFileSync(fleetPath) : null;
  const uiBackup = fs.existsSync(uiPath) ? fs.readFileSync(uiPath) : null;

  const server = spawn(process.execPath, [path.join(ROOT, 'bin', 'cf.js'), 'web', '--port', '8788'], { stdio: 'ignore' });
  mocks.push(server);
  const restore = () => {
    // the web tests write to the real config files - always put them back
    if (backup) fs.writeFileSync(fleetPath, backup);
    if (uiBackup) fs.writeFileSync(uiPath, uiBackup);
    else fs.rmSync(uiPath, { force: true });
  };
  process.once('exit', restore);
  try {
    await runWebChecks(server);
  } finally {
    server.kill();
    restore();
  }
}

async function runWebChecks() {
  await waitFor('http://127.0.0.1:8788/api/state');

  const base = 'http://127.0.0.1:8788';
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
    body: fleetFor([{ name: 'MOCK-A', host: '127.0.0.1', port: 8841, slots: 2, enabled: true, note: 'test' }],
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

  const badWorkflow = await call('/api/workflow', { method: 'POST', body: { data: { nodes: [], links: [] } } });
  check('a UI workflow is refused with advice', badWorkflow.status === 400 && badWorkflow.data.error.includes('Export (API)'),
    JSON.stringify(badWorkflow.data));

  // The picker opens a real Explorer dialog, so it is not driven from here - but the old
  // in-page browser must be gone, and the route has to exist.
  const gone = await call(`/api/browse?path=${encodeURIComponent(ROOT)}&only=dirs`);
  check('the in-page file browser is gone', gone.status === 404, JSON.stringify(gone.data));
  const badPick = await call('/api/pick', { method: 'GET' });
  check('/api/pick is registered', badPick.status === 404 ? false : true, JSON.stringify(badPick.data));

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

  const started = await call('/api/run', {
    method: 'POST',
    body: {
      workflow: path.join(ROOT, 'workflows', 'example_api.json'),
      mode: 'shard', count: 4, seed: 'random', preflight: true,
      machines: ['MOCK-A'],
      overrides: [{ title: 'Positive Prompt', field: 'text', value: 'from the web ui' }],
      collect: { enabled: true, destination: path.join(TMP, 'webout'), layout: '{run_id}/{machine}/{filename}', overwrite: false },
    },
  });
  check('/api/run starts a run', started.status === 200 && !!started.data.runId, JSON.stringify(started.data));

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !events.some((e) => e.type === 'done')) await sleep(200);
  const done = events.find((e) => e.type === 'done');
  check('the run finishes and reports through SSE', !!done?.manifest, JSON.stringify(done || {}).slice(0, 200));
  check('all four tasks succeeded', done?.manifest?.tasksSucceeded === 4, JSON.stringify(done?.manifest?.failures));
  check('files were collected to the chosen folder', done?.manifest?.filesCollected === 4);
  check('progress events were streamed', events.some((e) => e.type === 'progress' && e.total === 4));
  check('log lines were streamed', events.some((e) => e.type === 'log' && e.line.includes('=== run')));
  check('the override was applied', events.some((e) => e.type === 'log' && e.line.includes('override: 6.text')));
  check('busy toggled off at the end', events.filter((e) => e.type === 'busy').at(-1)?.busy === false);

  const outFiles = fs.readdirSync(path.join(TMP, 'webout', started.data.runId, 'MOCK-A'));
  check('the run folder holds the images', outFiles.filter((f) => f.endsWith('.png')).length === 4, outFiles.join());
  check('a manifest was written', fs.existsSync(path.join(TMP, 'webout', started.data.runId, 'run.json')));

  const rejected = await call('/api/run', { method: 'POST', body: { workflow: '', machines: ['MOCK-A'] } });
  check('a run without a workflow is refused politely', rejected.status === 400 && !!rejected.data.error, JSON.stringify(rejected.data));

  stream.catch(() => {});
}

/* ═══════════════════════════════════ go ══════════════════════════════════ */

try {
  unitTests();
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
