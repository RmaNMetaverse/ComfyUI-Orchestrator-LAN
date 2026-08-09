#!/usr/bin/env node
/** Command line front end: cf web | status | discover | check | run | cancel | free */

import fs from 'node:fs';
import path from 'node:path';

import { clientFor } from '../src/client.js';
import { ConfigError, enabledMachines, loadFleet, loadJob } from '../src/config.js';
import { DEFAULT_PORTS, scan } from '../src/discover.js';
import { checkMachine, formatReport, summarize } from '../src/preflight.js';
import { assetNames, Runner, safeName, writeManifest } from '../src/runner.js';
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
  await startWeb({
    port: Number(args.flags.port) || 8787,
    host: args.flags.host || '127.0.0.1',
    open: args.flags.open !== undefined && args.flags.open !== 'false',
  });
  return new Promise(() => {}); // stay up until Ctrl+C
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

async function cmdCheck(args) {
  const config = loadFleet();
  const job = loadJobFrom(args);
  const workflow = Workflow.load(job.workflow);
  workflow.applyOverrides(job.overrides);
  const list = clients(config, args.flags.only);

  log(`Job '${job.name}'  workflow=${path.basename(job.workflow)}  nodes=${workflow.nodes().length}  classes=${workflow.classTypes().size}`);
  const seeds = workflow.seedNodes();
  log(`Seed widgets found: ${seeds.length}${seeds.length ? ` (${seeds.map((s) => s.nodeId).join(', ')})` : ''}`);
  const refs = [...new Set(workflow.assetRefs().map((r) => r.value))];
  if (refs.length) log(`Input files referenced: ${refs.join(', ')}`);
  log(`\nChecking ${list.length} machine(s) - this reads /object_info from each ...\n`);

  const uploads = assetNames(job);
  const reports = await Promise.all(list.map((c) => checkMachine(c, workflow, uploads)));
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
  const workflow = Workflow.load(job.workflow);
  const applied = workflow.applyOverrides(job.overrides);
  let list = clients(config, args.flags.only);
  const runId = args.flags['run-id'] || `${timestamp()}-${safeName(job.name)}`;
  const destRoot = job.collectDestination || config.collect.destination;
  const collect = config.collect.enabled && !args.flags['no-collect'];

  log(`Run     : ${runId}`);
  log(`Workflow: ${job.workflow}`);
  log(`Mode    : ${job.mode}  count=${job.count}  seed=${job.seed}`);
  for (const line of applied) log(`Override: ${line}`);

  if (!args.flags['skip-check']) {
    log('\nPreflight:');
    const uploads = assetNames(job);
    const reports = await Promise.all(list.map((c) => checkMachine(c, workflow, uploads)));
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
    const per = job.mode === 'mirror' ? job.count : job.count / Math.max(1, list.length);
    log('\nDry run - would dispatch:');
    log(`  ${job.count} task(s) in ${job.mode} mode over ${list.length} machine(s) (~${per.toFixed(1)} each)`);
    log(collect ? `  collect -> ${path.join(destRoot, runId)}` : '  collection disabled');
    return 0;
  }

  const runner = new Runner({ fleet: config, job, workflow, clients: list, runId, log, collect, destRoot });
  const stop = () => {
    log('\ninterrupted - clearing the queue on every machine ...');
    runner.abort().finally(() => process.exit(130));
  };
  process.on('SIGINT', stop);

  log('');
  await runner.uploadAssets();
  runner.buildTasks();
  const manifest = await runner.run();

  log('');
  log(`Done in ${manifest.elapsedSeconds}s  -  ${manifest.tasksSucceeded}/${manifest.tasksTotal} tasks ok, ${manifest.tasksFailed} failed, ${manifest.filesCollected} file(s) collected`);
  for (const [machine, stats] of Object.entries(manifest.machines).sort()) {
    const attempts = Math.max(1, stats.success + stats.failed);
    log(`  ${machine.padEnd(14)} ${stats.success} ok  ${stats.failed} failed  avg ${(stats.seconds / attempts).toFixed(0)}s/task`);
  }
  for (const failure of manifest.failures) log(`  ! task ${failure.task} on ${failure.machine}: ${failure.detail}`);
  for (const err of manifest.collectErrors) log(`  ! download failed: ${err}`);

  if (collect) {
    const file = writeManifest(manifest, destRoot, runId);
    log(`\nOutputs: ${path.join(destRoot, runId)}`);
    log(file ? `Manifest: ${file}` : '! could not write run.json (is the output location writable?)');
  }
  if (args.flags.json) fs.writeFileSync(args.flags.json, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest.tasksFailed ? 3 : 0;
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
