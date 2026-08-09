/** Dispatch one job across the fleet, watch it, and pull the outputs back. */

import fs from 'node:fs';
import path from 'node:path';

import { ComfyClient, WorkflowRejected } from './client.js';
import { randomSeed } from './workflow.js';
// Characters Windows and SMB shares refuse inside a path segment.
const ILLEGAL_IN_PATH = /[<>:"/\\|?*]+/g;

/** Make a string usable as a folder name: for run ids and job names. */
export function safeName(text, fallback = "job") {
  const cleaned = String(text || "")
    .replace(ILLEGAL_IN_PATH, "_")
    .replace(/\s+/g, "_")
    .replace(/^[_. ]+|[_. ]+$/g, "");
  return cleaned.slice(0, 60) || fallback;
}

/**
 * Sanitise one segment of a collect path. Unlike safeName this keeps spaces and
 * hyphens, so a file ComfyUI named "my render 001.png" arrives under that name.
 */
export function safePathPart(text, fallback = "part") {
  const cleaned = String(text || "")
    .replace(ILLEGAL_IN_PATH, "_")
    .replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || fallback;
}

/** Every concrete file the job wants uploaded to the machines' input/ folders. */
export function assetFiles(job) {
  const files = [];
  for (const entry of job.assets || []) {
    let stat;
    try {
      stat = fs.statSync(entry);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const walk = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, item.name);
          if (item.isDirectory()) walk(full);
          else if (item.isFile()) files.push(full);
        }
      };
      walk(entry);
    } else if (stat.isFile()) {
      files.push(entry);
    }
  }
  return files;
}

export function assetNames(job) {
  return new Set(assetFiles(job).map((p) => path.basename(p)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Runner {
  constructor({ fleet, job, workflow, clients, runId, log = () => {}, collect = true, destRoot = null }) {
    this.settings = fleet.fleet;
    this.collectCfg = fleet.collect;
    this.machinesCfg = new Map(fleet.machines.map((m) => [m.name, m]));
    this.job = job;
    this.workflow = workflow;
    this.clients = new Map(clients.map((c) => [c.name, c]));
    this.runId = runId;
    this.log = log;
    this.doCollect = collect && this.collectCfg.enabled;
    this.destRoot = destRoot || job.collectDestination || this.collectCfg.destination;

    this.baseWorkflows = new Map();
    this.pending = [];
    this.inflight = new Map([...this.clients.keys()].map((name) => [name, []]));
    this.offline = new Set();
    this.rejected = new Map();
    this.results = [];
    this.collected = [];
    this.collectErrors = [];
    this.downloads = new Set();
    this.totalTasks = 0;
    this.aborted = false;
    this.startedAt = 0;
  }

  /* --------------------------------------------------------- assets */

  async uploadAssets() {
    for (const entry of this.job.assets || []) {
      if (!fs.existsSync(entry)) this.log(`  ! asset path not found, skipping: ${entry}`);
    }
    const files = assetFiles(this.job);

    const referenced = new Set(this.workflow.assetRefs().map(({ value }) => path.basename(value)));
    if (referenced.size) {
      const known = new Set(files.map((p) => path.basename(p)));
      for (const missing of [...referenced].filter((n) => !known.has(n)).sort()) {
        this.log(
          `  ! the workflow loads the input file '${missing}' but it was not added to this job - ` +
            "it must already sit in each machine's ComfyUI/input folder",
        );
      }
    }

    if (!files.length) {
      for (const name of this.clients.keys()) this.baseWorkflows.set(name, this.workflow);
      return;
    }

    const totalMb = files.reduce((sum, p) => sum + fs.statSync(p).size, 0) / 1024 ** 2;
    this.log(`  uploading ${files.length} input file(s), ${totalMb.toFixed(1)} MB, to ${this.clients.size} machine(s)`);

    await Promise.all(
      [...this.clients.values()].map(async (client) => {
        const mapping = {};
        try {
          for (const file of files) mapping[path.basename(file)] = await client.uploadAsset(file);
        } catch (err) {
          this.log(`  ! ${client.name}: upload failed: ${err.message}`);
          this.offline.add(client.name);
          return;
        }
        const wf = this.workflow.clone();
        wf.rewriteAssetNames(mapping);
        this.baseWorkflows.set(client.name, wf);
      }),
    );
  }

  /* ---------------------------------------------------------- tasks */

  buildTasks() {
    const base = this.job.seed;
    const mode = base === 'keep' ? 'keep' : base === 'random' ? 'random' : 'fixed';
    const seedFor = (i) => {
      if (mode === 'keep') return -1; // leave the workflow's own seeds alone
      if (mode === 'random') return randomSeed();
      return Number(base) + i;
    };

    if (this.job.mode === 'mirror') {
      const live = [...this.clients.keys()].filter((n) => !this.offline.has(n));
      let index = 0;
      for (let i = 0; i < this.job.count; i += 1) {
        const seed = seedFor(i);
        for (const name of live) this.pending.push({ index: index++, seed, pinned: name, attempts: 0 });
      }
    } else {
      for (let i = 0; i < this.job.count; i += 1) {
        this.pending.push({ index: i, seed: seedFor(i), pinned: null, attempts: 0 });
      }
    }
    this.totalTasks = this.pending.length;
  }

  /* -------------------------------------------------------- dispatch */

  promptFor(machine, task) {
    const wf = (this.baseWorkflows.get(machine) || this.workflow).clone();
    if (task.seed >= 0) wf.setSeed(task.seed);
    return wf.data;
  }

  freeSlots(machine) {
    const cfg = this.machinesCfg.get(machine);
    return (cfg?.slots || 1) - this.inflight.get(machine).length;
  }

  nextTaskFor(machine) {
    const at = this.pending.findIndex((task) => task.pinned === null || task.pinned === machine);
    return at === -1 ? null : this.pending.splice(at, 1)[0];
  }

  async dispatch() {
    for (const [name, client] of this.clients) {
      if (this.offline.has(name) || this.aborted) continue;
      while (this.freeSlots(name) > 0) {
        const task = this.nextTaskFor(name);
        if (!task) break;
        try {
          const promptId = await client.submit(this.promptFor(name, task), {
            comfyfleet: { run_id: this.runId, task: task.index },
          });
          this.inflight.get(name).push({ task, promptId, machine: name, started: Date.now() });
        } catch (err) {
          if (err instanceof WorkflowRejected) {
            // The graph is wrong, not the machine. Put the task back for a machine that might
            // accept it; if none do, the run stops with the reason spelled out.
            this.pending.unshift(task);
            this.rejected.set(name, err.message);
            this.log(`  x ${err.message}`);
            this.retire(name, 'refused this workflow');
          } else {
            task.attempts += 1;
            this.log(`  ! ${name}: submit failed (${err.message})`);
            if (task.attempts >= 2 || task.pinned) {
              this.results.push({
                index: task.index, seed: task.seed, machine: name, promptId: '',
                state: 'error', detail: `submit failed: ${err.message}`, seconds: 0,
              });
            } else {
              this.pending.unshift(task);
            }
            this.retire(name, 'dropped out - requeueing its work to the rest of the fleet');
          }
          break;
        }
      }
    }
  }

  /** Take a machine out of the rotation and hand its unfinished work back. */
  retire(machine, reason) {
    if (this.offline.has(machine)) return;
    this.offline.add(machine);
    this.log(`  ! ${machine} ${reason}`);
    for (const item of this.inflight.get(machine)) {
      if (item.task.pinned) {
        this.results.push({
          index: item.task.index, seed: item.task.seed, machine, promptId: item.promptId,
          state: 'lost', detail: 'machine unreachable', seconds: 0,
        });
      } else {
        item.task.pinned = null;
        this.pending.unshift(item.task);
      }
    }
    this.inflight.set(machine, []);
  }

  /* --------------------------------------------------------- polling */

  async pollOnce() {
    const jobs = [];
    for (const [name, items] of this.inflight) for (const item of items) jobs.push({ name, item });
    if (!jobs.length) return;

    const checks = await Promise.all(
      jobs.map(async ({ name, item }) => {
        try {
          return { name, item, record: await this.clients.get(name).history(item.promptId), error: null };
        } catch (err) {
          return { name, item, record: null, error: err };
        }
      }),
    );

    for (const { name, item, record, error } of checks) {
      if (error) {
        this.retire(name, 'stopped answering - requeueing its work to the rest of the fleet');
        continue;
      }
      if (!record) {
        if (Date.now() - item.started > this.settings.stallTimeout) {
          this.log(`  ! ${name}: task ${item.task.index} exceeded the stall timeout`);
          this.finish(name, item, 'error', 'stalled - no history entry', null);
        }
        continue;
      }
      const [state, detail] = ComfyClient.recordStatus(record);
      if (state === 'running') continue;
      this.finish(name, item, state, detail, record);
    }
  }

  finish(machine, item, state, detail, record) {
    const items = this.inflight.get(machine);
    const at = items.indexOf(item);
    if (at !== -1) items.splice(at, 1);

    const seconds = (Date.now() - item.started) / 1000;
    this.results.push({
      index: item.task.index, seed: item.task.seed, machine, promptId: item.promptId, state, detail, seconds,
    });

    if (state === 'success') {
      const files = ComfyClient.outputsFromRecord(record || {});
      const shown = files.slice(0, 3).map((f) => f.filename).join(', ') || 'no files';
      const extra = files.length > 3 ? ` (+${files.length - 3})` : '';
      this.log(`  + ${machine} finished task ${item.task.index} in ${seconds.toFixed(0)}s -> ${shown}${extra}`);
      if (this.doCollect && files.length) {
        const promise = this.collectFiles(machine, item, files).finally(() => this.downloads.delete(promise));
        this.downloads.add(promise);
      }
    } else {
      this.log(`  x ${machine} task ${item.task.index} failed: ${detail}`);
    }
  }

  /* ------------------------------------------------------ collecting */

  destinationFor(machine, item, file) {
    const ext = path.extname(file.filename);
    const tokens = {
      run_id: this.runId,
      machine,
      filename: file.filename,
      stem: path.basename(file.filename, ext),
      ext: ext.replace(/^\./, ''),
      task: String(item.task.index).padStart(4, '0'),
      seed: String(item.task.seed),
      node: file.nodeId,
      kind: file.kind,
      job: safeName(this.job.name),
      date: new Date().toISOString().slice(0, 10),
      subfolder: file.subfolder,
    };
    const relative = (this.collectCfg.layout || '{run_id}/{machine}/{filename}')
      .replace(/\{(\w+)\}/g, (match, key) => (key in tokens ? String(tokens[key]) : match))
      .replace(/\\/g, '/');
    const parts = relative.split('/').filter(Boolean).map((part) => safePathPart(part));
    return path.join(this.destRoot, ...parts);
  }

  async collectFiles(machine, item, files) {
    const client = this.clients.get(machine);
    for (const file of files) {
      if (file.type !== 'output') continue; // skip temp previews
      const dest = this.destinationFor(machine, item, file);
      try {
        const written = await client.download(file, dest, { overwrite: this.collectCfg.overwrite });
        this.collected.push({
          machine,
          task: item.task.index,
          seed: item.task.seed,
          promptId: item.promptId,
          node: file.nodeId,
          kind: file.kind,
          remote: file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename,
          local: written,
          bytes: fs.existsSync(written) ? fs.statSync(written).size : 0,
        });
      } catch (err) {
        this.collectErrors.push(`${machine} ${file.filename}: ${err.message}`);
      }
    }
  }

  /* -------------------------------------------------------------- run */

  progress() {
    const done = this.results.filter((r) => r.state === 'success').length;
    const failed = this.results.filter((r) => r.state !== 'success').length;
    return {
      total: this.totalTasks,
      done,
      failed,
      files: this.collected.length,
      machines: [...this.clients.keys()].map((name) => ({
        name,
        state: this.offline.has(name) ? (this.rejected.has(name) ? 'refused' : 'offline') : 'ready',
        busy: this.inflight.get(name).length,
      })),
    };
  }

  async run() {
    this.startedAt = Date.now();
    const total = this.totalTasks;
    this.log(`  dispatching ${total} task(s) across ${this.clients.size - this.offline.size} machine(s)`);
    let lastStatus = 0;

    while (!this.aborted) {
      await this.dispatch();
      const busy = [...this.inflight.values()].reduce((sum, items) => sum + items.length, 0);
      if (!this.pending.length && !busy) break;
      if (this.offline.size === this.clients.size) {
        if (this.rejected.size === this.clients.size) {
          this.log(
            '  ! every machine refused this workflow, so the problem is the workflow itself, ' +
              'not the machines - nothing was queued',
          );
        } else {
          this.log('  ! no machines left to run on - stopping');
        }
        break;
      }
      await sleep(this.settings.pollInterval);
      await this.pollOnce();
      if (Date.now() - lastStatus >= 15000) {
        lastStatus = Date.now();
        const p = this.progress();
        const parts = p.machines.map((m) => `${m.name}:${m.state === 'ready' ? m.busy : m.state}`);
        this.log(`  [${p.done}/${total} done, ${p.failed} failed, ${p.files} files] ${parts.join('  ')}`);
      }
    }

    // Anything still queued here never ran - report it rather than quietly losing it.
    for (const task of this.pending) {
      this.results.push({
        index: task.index, seed: task.seed, machine: '-', promptId: '',
        state: 'not run', detail: 'no machine was able to accept it', seconds: 0,
      });
    }
    this.pending = [];

    if (this.downloads.size) this.log('  waiting for downloads to finish ...');
    await Promise.all([...this.downloads]);

    return this.manifest();
  }

  async abort() {
    this.aborted = true;
    await Promise.all(
      [...this.clients].map(async ([name, client]) => {
        if (this.offline.has(name)) return;
        try {
          await client.cancelPending(this.inflight.get(name).map((i) => i.promptId));
          await client.interrupt();
        } catch {
          /* a machine that will not answer the cancel is already effectively stopped */
        }
      }),
    );
  }

  manifest() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const succeeded = this.results.filter((r) => r.state === 'success');
    const failed = this.results.filter((r) => r.state !== 'success');
    const perMachine = {};
    for (const r of this.results) {
      if (r.machine === '-') continue; // never reached a machine
      const slot = (perMachine[r.machine] ||= { success: 0, failed: 0, seconds: 0 });
      slot[r.state === 'success' ? 'success' : 'failed'] += 1;
      slot.seconds += r.seconds;
    }
    return {
      runId: this.runId,
      job: this.job.name,
      workflow: this.job.workflow,
      mode: this.job.mode,
      started: new Date(this.startedAt).toISOString(),
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      tasksTotal: this.totalTasks,
      tasksSucceeded: succeeded.length,
      tasksFailed: failed.length,
      machines: perMachine,
      offline: [...this.offline].sort(),
      rejected: Object.fromEntries(this.rejected),
      filesCollected: this.collected.length,
      collectRoot: this.destRoot,
      collectErrors: this.collectErrors,
      files: this.collected,
      failures: failed.map((r) => ({ task: r.index, machine: r.machine, state: r.state, detail: r.detail })),
    };
  }
}

export function writeManifest(manifest, destRoot, runId) {
  try {
    const dir = path.join(destRoot, runId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'run.json');
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}
