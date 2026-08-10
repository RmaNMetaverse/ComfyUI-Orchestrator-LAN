/** Dispatch a job across the fleet, watch it, and pull the outputs back as they appear. */

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

/** Every concrete file a workflow entry wants uploaded to the machines' input/ folders. */
export function assetFiles(entry) {
  const files = [];
  for (const target of entry.assets || []) {
    let stat;
    try {
      stat = fs.statSync(target);
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
      walk(target);
    } else if (stat.isFile()) {
      files.push(target);
    }
  }
  return files;
}

export function assetNames(entry) {
  return new Set(assetFiles(entry).map((p) => path.basename(p)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Runner {
  /**
   * @param job  normalized job: { workflows: [{ id, name, path, assets, overrides, graph }], assignments, mode, count, seed }
   *             each workflow entry must already carry a loaded, override-applied `graph`.
   */
  constructor({ fleet, job, clients, runId, log = () => {}, collect = true, destRoot = null }) {
    this.settings = fleet.fleet;
    this.collectCfg = fleet.collect;
    this.machinesCfg = new Map(fleet.machines.map((m) => [m.name, m]));
    this.job = job;
    this.clients = new Map(clients.map((c) => [c.name, c]));
    this.runId = runId;
    this.log = log;
    this.doCollect = collect && this.collectCfg.enabled;
    this.destRoot = destRoot || job.collectDestination || this.collectCfg.destination;

    // workflow id -> { spec, machines: [names], graphs: Map(machine -> Workflow) }
    this.groups = new Map();
    for (const spec of job.workflows) {
      this.groups.set(spec.id, { spec, machines: [], graphs: new Map() });
    }
    for (const [machine, workflowId] of Object.entries(job.assignments)) {
      if (this.clients.has(machine) && this.groups.has(workflowId)) {
        this.groups.get(workflowId).machines.push(machine);
      }
    }

    this.pending = [];
    this.inflight = new Map([...this.clients.keys()].map((name) => [name, []]));
    this.offline = new Set();
    this.rejected = new Map();
    this.results = [];
    this.collected = [];
    this.collectErrors = [];
    this.seenFiles = new Set(); // machine|promptId|subfolder/filename - the live socket and the
    this.downloads = new Set(); // final history check both report outputs; take each one once
    this.sockets = [];
    this.totalTasks = 0;
    this.aborted = false;
    this.startedAt = 0;
  }

  workflowFor(machine) {
    const id = this.job.assignments[machine];
    return this.groups.get(id) || null;
  }

  /* --------------------------------------------------------- assets */

  async uploadAssets() {
    for (const group of this.groups.values()) {
      if (!group.machines.length) continue;
      const { spec } = group;

      for (const target of spec.assets || []) {
        if (!fs.existsSync(target)) this.log(`  ! [${spec.name}] input path not found, skipping: ${target}`);
      }
      const files = assetFiles(spec);

      const referenced = new Set(spec.graph.assetRefs().map(({ value }) => path.basename(value)));
      if (referenced.size) {
        const known = new Set(files.map((p) => path.basename(p)));
        for (const missing of [...referenced].filter((n) => !known.has(n)).sort()) {
          this.log(
            `  ! [${spec.name}] loads the input file '${missing}' but it was not added to this workflow - ` +
              "it must already sit in each machine's ComfyUI/input folder",
          );
        }
      }

      if (!files.length) {
        for (const machine of group.machines) group.graphs.set(machine, spec.graph);
        continue;
      }

      const totalMb = files.reduce((sum, p) => sum + fs.statSync(p).size, 0) / 1024 ** 2;
      this.log(
        `  uploading ${files.length} input file(s), ${totalMb.toFixed(1)} MB, for '${spec.name}' ` +
          `to ${group.machines.length} machine(s)`,
      );

      await Promise.all(
        group.machines.map(async (machine) => {
          const client = this.clients.get(machine);
          const mapping = {};
          try {
            for (const file of files) mapping[path.basename(file)] = await client.uploadAsset(file);
          } catch (err) {
            this.log(`  ! ${machine}: upload failed: ${err.message}`);
            this.offline.add(machine);
            return;
          }
          const graph = spec.graph.clone();
          graph.rewriteAssetNames(mapping);
          group.graphs.set(machine, graph);
        }),
      );
    }
  }

  /* ---------------------------------------------------------- tasks */

  buildTasks() {
    const base = this.job.seed;
    const mode = base === 'keep' ? 'keep' : base === 'random' ? 'random' : 'fixed';
    let counter = 0;
    const seedFor = (i) => {
      if (mode === 'keep') return -1; // leave the workflow's own seeds alone
      if (mode === 'random') return randomSeed();
      return Number(base) + i;
    };

    let index = 0;
    for (const [id, group] of this.groups) {
      const live = group.machines.filter((n) => !this.offline.has(n));
      if (!live.length) continue;
      const count = group.spec.count || this.job.count;

      if (this.job.mode === 'mirror') {
        for (let i = 0; i < count; i += 1) {
          const seed = seedFor(counter++);
          for (const machine of live) this.pending.push({ index: index++, seed, group: id, pinned: machine, attempts: 0 });
        }
      } else {
        for (let i = 0; i < count; i += 1) {
          this.pending.push({ index: index++, seed: seedFor(counter++), group: id, pinned: null, attempts: 0 });
        }
      }
    }
    this.totalTasks = this.pending.length;
  }

  /* -------------------------------------------------------- dispatch */

  promptFor(machine, task) {
    const group = this.groups.get(task.group);
    const graph = (group.graphs.get(machine) || group.spec.graph).clone();
    if (task.seed >= 0) graph.setSeed(task.seed);
    return graph.data;
  }

  freeSlots(machine) {
    const cfg = this.machinesCfg.get(machine);
    return (cfg?.slots || 1) - this.inflight.get(machine).length;
  }

  nextTaskFor(machine) {
    const assigned = this.job.assignments[machine];
    if (!assigned) return null;
    const at = this.pending.findIndex(
      (task) => task.group === assigned && (task.pinned === null || task.pinned === machine),
    );
    return at === -1 ? null : this.pending.splice(at, 1)[0];
  }

  async dispatch() {
    for (const [name, client] of this.clients) {
      if (this.offline.has(name) || this.aborted) continue;
      while (this.freeSlots(name) > 0) {
        const task = this.nextTaskFor(name);
        if (!task) break;
        const group = this.groups.get(task.group);
        try {
          const promptId = await client.submit(this.promptFor(name, task), {
            comfyfleet: { run_id: this.runId, task: task.index, workflow: group.spec.name },
          });
          this.inflight.get(name).push({
            task, promptId, machine: name,
            queuedAt: Date.now(),
            runningSince: 0, // set when the machine reports it started
            lastSeen: Date.now(),
          });
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
                index: task.index, seed: task.seed, machine: name, promptId: '', workflow: group.spec.name,
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
      const others = (this.groups.get(item.task.group)?.machines || []).filter(
        (n) => n !== machine && !this.offline.has(n),
      );
      if (item.task.pinned || !others.length) {
        this.results.push({
          index: item.task.index, seed: item.task.seed, machine, promptId: item.promptId,
          workflow: this.groups.get(item.task.group)?.spec.name || '',
          state: 'lost', detail: 'machine unreachable', seconds: 0,
        });
      } else {
        item.task.pinned = null;
        this.pending.unshift(item.task);
      }
    }
    this.inflight.set(machine, []);
  }

  /* ----------------------------------------------- live collection */

  /** Subscribe to every machine so outputs are fetched the moment a node saves them. */
  openSockets() {
    if (!this.doCollect) return;
    for (const [name, client] of this.clients) {
      const close = client.connectEvents({
        onStart: (promptId) => {
          const item = this.inflight.get(name)?.find((i) => i.promptId === promptId);
          if (item && !item.runningSince) item.runningSince = Date.now();
        },
        onExecuted: (promptId, files) => {
          const item = this.inflight.get(name)?.find((i) => i.promptId === promptId);
          if (!item) return;
          item.lastSeen = Date.now();
          this.queueDownload(name, item, files);
        },
      });
      this.sockets.push(close);
    }
  }

  closeSockets() {
    for (const close of this.sockets) close();
    this.sockets = [];
  }

  /* --------------------------------------------------------- polling */

  async pollOnce() {
    const machines = [...this.inflight.entries()].filter(([name, items]) => items.length && !this.offline.has(name));
    if (!machines.length) return;

    await Promise.all(
      machines.map(async ([name, items]) => {
        const client = this.clients.get(name);

        // One /queue call tells us which of our prompts the machine still knows about.
        // /history alone cannot: it stays empty while a prompt is queued *and* while it runs.
        let queue = null;
        try {
          queue = await client.queueIds();
        } catch (err) {
          this.retire(name, 'stopped answering - requeueing its work to the rest of the fleet');
          return;
        }

        for (const item of [...items]) {
          const running = queue.running.has(item.promptId);
          const pending = queue.pending.has(item.promptId);
          if (running && !item.runningSince) item.runningSince = Date.now();
          if (running || pending) {
            item.lastSeen = Date.now();
            // Still working. Only count time spent actually executing towards the stall
            // timeout, so a job waiting its turn behind others is never written off.
            if (running && Date.now() - item.runningSince > this.settings.stallTimeout) {
              const minutes = Math.round(this.settings.stallTimeout / 60000);
              this.log(`  ! ${name}: task ${item.task.index} has been running over ${minutes} min`);
              this.finish(name, item, 'error', `still running after ${minutes} minutes - giving up on it`, null);
            }
            continue;
          }

          // Not in the queue: it either finished (history has it) or vanished.
          let record = null;
          try {
            record = await client.history(item.promptId);
          } catch {
            item.lastSeen = Date.now();
            continue; // transient; the next poll retries
          }
          if (record) {
            const [state, detail] = ComfyClient.recordStatus(record);
            if (state === 'running') continue;
            this.finish(name, item, state, detail, record);
            continue;
          }
          // Give it a moment: there is a gap between leaving the queue and landing in history.
          if (Date.now() - item.lastSeen > 20000) {
            this.finish(
              name, item, 'error',
              'the machine no longer knows about this job (ComfyUI restarted, or its queue was cleared)',
              null,
            );
          }
        }
      }),
    );
  }

  finish(machine, item, state, detail, record) {
    const items = this.inflight.get(machine);
    const at = items.indexOf(item);
    if (at !== -1) items.splice(at, 1);

    const started = item.runningSince || item.queuedAt;
    const seconds = (Date.now() - started) / 1000;
    const workflow = this.groups.get(item.task.group)?.spec.name || '';
    this.results.push({
      index: item.task.index, seed: item.task.seed, machine, promptId: item.promptId, workflow, state, detail, seconds,
    });

    if (state === 'success') {
      const files = ComfyClient.outputsFromRecord(record || {});
      const fresh = files.filter((f) => !this.seenFiles.has(this.fileKey(machine, item, f)));
      const shown = files.slice(0, 3).map((f) => f.filename).join(', ') || 'no files';
      const extra = files.length > 3 ? ` (+${files.length - 3})` : '';
      this.log(`  + ${machine} finished task ${item.task.index} in ${seconds.toFixed(0)}s -> ${shown}${extra}`);
      // Most files are already on their way from the live socket; this catches anything
      // the socket missed (older ComfyUI, dropped connection).
      if (this.doCollect && fresh.length) this.queueDownload(machine, item, fresh);
    } else {
      this.log(`  x ${machine} task ${item.task.index} failed: ${detail}`);
    }
  }

  /* ------------------------------------------------------ collecting */

  fileKey(machine, item, file) {
    return `${machine}|${item.promptId}|${file.subfolder}/${file.filename}`;
  }

  destinationFor(machine, item, file) {
    const ext = path.extname(file.filename);
    const workflow = this.groups.get(item.task.group)?.spec.name || '';
    const tokens = {
      run_id: this.runId,
      machine,
      workflow: safeName(workflow, 'workflow'),
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

  /** Start downloading now; the run loop only waits for these at the very end. */
  queueDownload(machine, item, files) {
    if (!this.doCollect) return;
    const wanted = [];
    for (const file of files) {
      if (file.type !== 'output') continue; // skip temp previews
      const key = this.fileKey(machine, item, file);
      if (this.seenFiles.has(key)) continue;
      this.seenFiles.add(key);
      wanted.push(file);
    }
    if (!wanted.length) return;

    const promise = this.collectFiles(machine, item, wanted).finally(() => this.downloads.delete(promise));
    this.downloads.add(promise);
  }

  async collectFiles(machine, item, files) {
    const client = this.clients.get(machine);
    for (const file of files) {
      const dest = this.destinationFor(machine, item, file);
      try {
        const written = await client.download(file, dest, { overwrite: this.collectCfg.overwrite });
        this.collected.push({
          machine,
          workflow: this.groups.get(item.task.group)?.spec.name || '',
          task: item.task.index,
          seed: item.task.seed,
          promptId: item.promptId,
          node: file.nodeId,
          kind: file.kind,
          remote: file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename,
          local: written,
          bytes: fs.existsSync(written) ? fs.statSync(written).size : 0,
        });
        this.log(`  ↓ ${machine} saved ${path.basename(written)}`);
      } catch (err) {
        this.seenFiles.delete(this.fileKey(machine, item, file)); // let the final sweep retry
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
        workflow: this.groups.get(this.job.assignments[name])?.spec.name || null,
        state: this.offline.has(name) ? (this.rejected.has(name) ? 'refused' : 'offline') : 'ready',
        busy: this.inflight.get(name).length,
      })),
    };
  }

  async run() {
    this.startedAt = Date.now();
    const total = this.totalTasks;
    const active = [...this.clients.keys()].filter((n) => !this.offline.has(n) && this.job.assignments[n]);
    this.log(`  dispatching ${total} task(s) across ${active.length} machine(s)`);
    for (const [, group] of this.groups) {
      if (group.machines.length) this.log(`    '${group.spec.name}' -> ${group.machines.join(', ')}`);
    }
    this.openSockets();
    let lastStatus = 0;

    try {
      while (!this.aborted) {
        await this.dispatch();
        const busy = [...this.inflight.values()].reduce((sum, items) => sum + items.length, 0);
        if (!this.pending.length && !busy) break;
        if (active.every((n) => this.offline.has(n))) {
          if (this.rejected.size && this.rejected.size === active.length) {
            this.log(
              '  ! every machine refused its workflow, so the problem is the workflow itself, ' +
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
    } finally {
      this.closeSockets();
    }

    // Anything still queued here never ran - report it rather than quietly losing it.
    for (const task of this.pending) {
      this.results.push({
        index: task.index, seed: task.seed, machine: '-', promptId: '',
        workflow: this.groups.get(task.group)?.spec.name || '',
        state: 'not run', detail: 'no machine was able to accept it', seconds: 0,
      });
    }
    this.pending = [];

    if (this.downloads.size) this.log('  finishing the last download(s) ...');
    await Promise.all([...this.downloads]);

    return this.manifest();
  }

  async abort() {
    this.aborted = true;
    this.closeSockets();
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
      const slot = (perMachine[r.machine] ||= { success: 0, failed: 0, seconds: 0, workflow: r.workflow });
      slot[r.state === 'success' ? 'success' : 'failed'] += 1;
      slot.seconds += r.seconds;
    }
    return {
      runId: this.runId,
      job: this.job.name,
      workflows: this.job.workflows.map((w) => ({
        id: w.id, name: w.name, path: w.path, machines: this.groups.get(w.id)?.machines || [],
      })),
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
      failures: failed.map((r) => ({
        task: r.index, machine: r.machine, workflow: r.workflow, state: r.state, detail: r.detail,
      })),
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
