#!/usr/bin/env node
/** Command line front end: cf web | status | discover | check | run | cancel | free */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { clientFor } from '../src/client.js';
import { ConfigError, enabledMachines, loadFleet, loadJob } from '../src/config.js';
import { DEFAULT_PORTS, scan } from '../src/discover.js';
import { checkMachine, formatReport, summarize } from '../src/preflight.js';
import { FleetSupervisor } from '../src/fleet.js';
import { assetNames } from '../src/runner.js';
import { startWeb } from '../src/server.js';
import { Workflow, WorkflowError } from '../src/workflow.js';

const log = (msg = '') => console.log(msg);

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const [key, inline] = item.slice(2).split('=');
      if (inline !== undefined) args.flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.flags[key] = argv[++i];
      else args.flags[key] = true;
    } else {
      args._.push(item);
    }
  }
  return args;
}

const splitList = (value) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : null);

function clients(config, only) {
  return enabledMachines(config, splitList(only)).map((m) => clientFor(m, { timeout: config.fleet.requestTimeout }));
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------- commands */

async function cmdWeb(args) {
  const port = Number(args.flags.port) || 8787;
  const host = args.flags.host || '127.0.0.1';
  const open = args.flags.open !== undefined && args.flags.open !== 'false';
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

  // Double-clicking the starter twice should not be an error: if ComfyFleet is already
  // up on this port, just show it rather than failing to bind.
  if (await alreadyRunning(url)) {
    log(`ComfyFleet is already running at ${url}`);
    if (open) openInBrowser(url);
    return 0;
  }

  try {
    await startWeb({ port, host, open });
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      log(`Something else is already using port ${port}.`);
      log(`Start on another port with:  node bin/cf.js web --port ${port + 1}`);
      return 1;
    }
    throw err;
  }
  return new Promise(() => {}); // stay up until Ctrl+C
}

async function alreadyRunning(url) {
  try {
    const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const data = await response.json();
    return Array.isArray(data?.config?.machines); // it answered like ComfyFleet, not something else
  } catch {
    return false;
  }
}

function openInBrowser(url) {
  const command = process.platform === 'win32' ? 'start ""'
    : process.platform === 'darwin' ? 'open'
      : 'xdg-open';
  execSync(`${command} ${url}`, { stdio: 'ignore' });
}

async function cmdStatus(args) {
  const config = loadFleet();
  const list = clients(config, args.flags.only);
  log(`Fleet '${config.fleet.name}' - ${list.length} machine(s)\n`);
  const rows = await Promise.all(
    list.map(async (client) => {
      try {
        return { client, info: await client.ping() };
      } catch (err) {
        return { client, error: err };
      }
    }),
  );
  const pad = (text, width) => String(text).slice(0, width).padEnd(width);
  const header = `${pad('MACHINE', 14)} ${pad('ADDRESS', 24)} ${pad('STATUS', 9)} ${'QUEUE'.padStart(5)}  ${pad('GPU', 28)} ${'VRAM FREE'.padStart(10)}  VERSION`;
  log(header);
  log('-'.repeat(header.length));
  let online = 0;
  for (const { client, info, error } of rows.sort((a, b) => a.client.name.localeCompare(b.client.name))) {
    if (error) {
      log(`${pad(client.name, 14)} ${pad(client.baseUrl, 24)} ${pad('OFFLINE', 9)} ${'-'.padStart(5)}  ${pad('-', 28)} ${'-'.padStart(10)}  -`);
      if (args.flags.verbose || args.flags.v) log(`    ${error.message}`);
      continue;
    }
    online += 1;
    log(
      `${pad(client.name, 14)} ${pad(client.baseUrl, 24)} ${pad('online', 9)} ${String(info.queue).padStart(5)}  ` +
        `${pad(info.gpu, 28)} ${`${info.vramFreeGb} GB`.padStart(10)}  ${info.comfyuiVersion}`,
    );
  }
  log(`\n${online}/${list.length} online`);
  return online ? 0 : 1;
}

async function cmdDiscover(args) {
  const range = args._[1];
  if (!range) throw new ConfigError('usage: cf discover <range>   e.g. cf discover 192.168.1.0/24');
  const ports = splitList(args.flags.ports)?.map(Number) || DEFAULT_PORTS;
  log(`Scanning ${range} on port(s) ${ports.join(', ')} ...`);
  const found = await scan(range, { ports, timeout: Number(args.flags.timeout) || 1500 });
  if (!found.length) {
    log('No ComfyUI instances answered.');
    log('Each machine must listen on 0.0.0.0 (not 127.0.0.1) and allow the port through the firewall');
    log('- see tools/Enable-ComfyRemote.ps1');
    return 1;
  }
  log(`\nFound ${found.length}:\n`);
  for (const info of found) {
    log(`  ${info.host}:${info.port}  ${info.gpu}  ${info.vramTotalGb} GB  ComfyUI ${info.comfyuiVersion}`);
  }
  log('\nJSON for config/nodes.json:\n');
  log(JSON.stringify(
    found.map((info, i) => ({
      name: `GPU-${String(i + 1).padStart(2, '0')}`,
      host: info.host,
      port: info.port,
      slots: 2,
      enabled: true,
      note: info.gpu,
    })),
    null,
    2,
  ));
  return 0;
}

function loadJobFrom(args) {
  const file = args._[1];
  if (!file) throw new ConfigError('usage: cf ' + args._[0] + ' <job.json>');
  const job = loadJob(file);
  if (args.flags.count) job.count = Math.max(1, Number(args.flags.count));
  if (args.flags.mode) job.mode = args.flags.mode;
  if (args.flags.seed !== undefined) job.seed = /^\d+$/.test(args.flags.seed) ? Number(args.flags.seed) : args.flags.seed;
  if (args.flags.dest) job.collectDestination = args.flags.dest;
  return job;
}

/**
 * Load every graph, apply its overrides, and work out which machine runs which.
 * A job with one workflow and no assignments runs that workflow everywhere.
 */
function planJob(job, list) {
  const applied = [];
  for (const spec of job.workflows) {
    spec.graph = Workflow.load(spec.path);
    for (const line of spec.graph.applyOverrides(spec.overrides)) applied.push(`[${spec.name}] ${line}`);
  }
  if (!Object.keys(job.assignments).length) {
    if (job.workflows.length > 1) {
      throw new ConfigError('this job has several workflows but no "assignments" saying which machine runs which');
    }
    for (const client of list) job.assignments[client.name] = job.workflows[0].id;
  }
  const usable = list.filter((c) => job.assignments[c.name]);
  const skipped = list.filter((c) => !job.assignments[c.name]).map((c) => c.name);
  return { applied, usable, skipped };
}

function checkAssigned(job, list) {
  return Promise.all(
    list.map(async (client) => {
      const spec = job.workflows.find((w) => w.id === job.assignments[client.name]);
      const report = await checkMachine(client, spec.graph, assetNames(spec));
      return { ...report, workflow: spec.name };
    }),
  );
}

async function cmdCheck(args) {
  const config = loadFleet();
  const job = loadJobFrom(args);
  const list = clients(config, args.flags.only);
  const { usable, skipped } = planJob(job, list);

  log(`Job '${job.name}'  ${job.workflows.length} workflow(s)`);
  for (const spec of job.workflows) {
    const machines = usable.filter((c) => job.assignments[c.name] === spec.id).map((c) => c.name);
    log(`  ${spec.name}: ${spec.graph.nodes().length} nodes, ${spec.graph.seedNodes().length} seed widget(s) -> ${machines.join(', ') || 'nobody'}`);
    const refs = [...new Set(spec.graph.assetRefs().map((r) => r.value))];
    if (refs.length) log(`    input files: ${refs.join(', ')}`);
  }
  if (skipped.length) log(`  no workflow assigned: ${skipped.join(', ')}`);
  log(`\nChecking ${usable.length} machine(s) - this reads /object_info from each ...\n`);

  const reports = await checkAssigned(job, usable);
  log(formatReport(reports));
  const { ready, blocked } = summarize(reports);
  log(`\n${ready.length} ready, ${blocked.length} not ready`);
  if (blocked.length) {
    log('\nInstall the listed custom nodes (ComfyUI Manager), copy the listed models under ComfyUI/models,');
    log('and add any listed input files to the job so they are uploaded before the run.');
  }
  return blocked.length ? 2 : 0;
}

async function cmdRun(args) {
  const config = loadFleet();
  const job = loadJobFrom(args);
  const all = clients(config, args.flags.only);
  const plan = planJob(job, all);
  let list = plan.usable;
  const runId = args.flags['run-id'] || `${timestamp()}-${safeName(job.name)}`;
  const destRoot = job.collectDestination || config.collect.destination;
  const collect = config.collect.enabled && !args.flags['no-collect'];

  log(`Run     : ${runId}`);
  log(`Mode    : ${job.mode}  count=${job.count}  seed=${job.seed}`);
  for (const spec of job.workflows) {
    const machines = list.filter((c) => job.assignments[c.name] === spec.id).map((c) => c.name);
    if (machines.length) log(`Workflow: '${spec.name}' -> ${machines.join(', ')}`);
  }
  if (plan.skipped.length) log(`Skipping: ${plan.skipped.join(', ')} (no workflow assigned)`);
  for (const line of plan.applied) log(`Override: ${line}`);

  if (!args.flags['skip-check']) {
    log('\nPreflight:');
    const reports = await checkAssigned(job, list);
    log(formatReport(reports));
    const { ready, blocked } = summarize(reports);
    if (blocked.length) {
      if (args.flags.strict) {
        log('\nAborting (--strict) because some machines are not ready.');
        return 2;
      }
      log(`\nSkipping ${blocked.length} machine(s) that are not ready: ${blocked.join(', ')}`);
    }
    list = list.filter((c) => ready.includes(c.name));
    if (!list.length) {
      log('\nNo usable machines. Nothing to run.');
      return 1;
    }
  }

  if (args.flags['dry-run']) {
    log('\nDry run - would queue:');
    for (const client of list) {
      const spec = job.workflows.find((w) => w.id === job.assignments[client.name]);
      log(`  ${client.name}: ${job.count} x '${spec.name}'`);
    }
    log(collect ? `  collect -> ${destRoot}` : '  collection disabled');
    return 0;
  }

  // The same supervisor the web interface uses, driven to completion.
  const fleet = new FleetSupervisor({ log });
  fleet.configure({
    ...config,
    collect: { ...config.collect, enabled: collect, destination: destRoot },
    machines: config.machines.filter((m) => list.some((c) => c.name === m.name)),
  });
  for (const spec of job.workflows) fleet.setWorkflow(spec);

  const stop = () => {
    log('\ninterrupted - stopping every machine ...');
    fleet.stopAll().finally(() => process.exit(130));
  };
  process.on('SIGINT', stop);

  log('');
  const byWorkflow = new Map();
  for (const client of list) {
    const id = job.assignments[client.name];
    if (!byWorkflow.has(id)) byWorkflow.set(id, []);
    byWorkflow.get(id).push(client.name);
  }
  const batches = [];
  for (const [workflowId, machines] of byWorkflow) {
    batches.push(fleet.enqueue({ workflowId, machines, count: job.count, seed: job.seed }));
  }

  await fleet.waitUntilIdle();
  fleet.shutdown();

  const done = batches.reduce((s, b) => s + b.done, 0);
  const failed = batches.reduce((s, b) => s + b.failed, 0);
  const total = batches.reduce((s, b) => s + b.total, 0);
  const snapshot = fleet.snapshot();

  log('');
  log(`Done  -  ${done}/${total} ok, ${failed} failed, ${snapshot.files} file(s) collected`);
  for (const machine of snapshot.machines) {
    if (machine.done || machine.failed) {
      log(`  ${machine.name.padEnd(14)} ${machine.done} ok  ${machine.failed} failed  ${machine.files} file(s)`);
    }
  }
  for (const err of fleet.collectErrors) log(`  ! download failed: ${err}`);
  if (collect) log(`\nOutputs: ${destRoot}`);
  if (args.flags.json) {
    fs.writeFileSync(args.flags.json, `${JSON.stringify({ batches: batches.map((b) => ({ id: b.id, total: b.total, done: b.done, failed: b.failed })), files: fleet.collected }, null, 2)}\n`, 'utf8');
  }
  return failed ? 3 : 0;
}

async function cmdCancel(args) {
  const config = loadFleet();
  await Promise.all(
    clients(config, args.flags.only).map(async (client) => {
      try {
        await client.clearQueue();
        await client.interrupt();
        log(`  ${client.name}: queue cleared, running job interrupted`);
      } catch (err) {
        log(`  ${client.name}: ${err.message}`);
      }
    }),
  );
  return 0;
}

async function cmdFree(args) {
  const config = loadFleet();
  await Promise.all(
    clients(config, args.flags.only).map(async (client) => {
      try {
        await client.freeMemory();
        log(`  ${client.name}: models unloaded, VRAM freed`);
      } catch (err) {
        log(`  ${client.name}: ${err.message}`);
      }
    }),
  );
  return 0;
}

function usage() {
  log(`ComfyFleet - run one ComfyUI workflow across every GPU machine on the LAN

  cf web [--port 8787] [--host 0.0.0.0] [--open]   open the web interface
  cf status [--only A,B] [-v]                      ping every machine
  cf discover <range> [--ports 8000,8188]          scan the network for ComfyUI
  cf check <job.json> [--only A,B]                 verify nodes + models per machine
  cf run <job.json> [options]                      dispatch, monitor, collect
  cf cancel [--only A,B]                           clear queues everywhere
  cf free [--only A,B]                             unload models / free VRAM

  run options: --count N --mode shard|mirror --seed N|random|keep --dest PATH
               --only A,B --run-id NAME --no-collect --skip-check --strict
               --dry-run --json FILE
`);
}

const COMMANDS = {
  web: cmdWeb,
  status: cmdStatus,
  discover: cmdDiscover,
  check: cmdCheck,
  run: cmdRun,
  cancel: cmdCancel,
  free: cmdFree,
};

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

if (!command || args.flags.help || command === 'help') {
  usage();
  process.exit(command ? 0 : 1);
}
if (!COMMANDS[command]) {
  log(`unknown command: ${command}\n`);
  usage();
  process.exit(1);
}

try {
  process.exit((await COMMANDS[command](args)) || 0);
} catch (err) {
  if (err instanceof ConfigError || err instanceof WorkflowError) log(`error: ${err.message}`);
  else log(`error: ${err.stack || err.message}`);
  process.exit(2);
}
