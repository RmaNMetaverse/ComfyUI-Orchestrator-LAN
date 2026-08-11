/**
 * The fleet supervisor.
 *
 * Every machine is an independent worker with its own queue, its own workflow and its
 * own controls. Nothing is global: you can start work on one machine while another is
 * mid-render, pause or stop a single machine, and add machines or workflows at any time.
 *
 * A "batch" is one press of Start: N generations of one workflow, spread over the machines
 * chosen at that moment. Batches are just labels on tasks - several can be in flight at once.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ComfyClient, WorkflowRejected } from './client.js';
import { assetFiles, safeName, safePathPart, writeManifest } from './runner.js';
import { randomSeed } from './workflow.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let taskCounter = 0;

export class FleetSupervisor {
  constructor({ log = () => {}, onChange = () => {} } = {}) {
    this.log = log;
    this.onChange = onChange;

    this.settings = { requestTimeout: 20000, pollInterval: 2000, stallTimeout: 1800000 };
    this.collectCfg = { enabled: true, destination: '', layout: '{run_id}/{machine}/{filename}', overwrite: false };

    this.workers = new Map(); // machine name -> worker
    this.workflows = new Map(); // workflow id -> { id, name, path, assets, overrides, graph }
    this.batches = new Map(); // batch id -> { id, workflowId, workflowName, total, done, failed, files, machines, startedAt, manifestWritten }
    this.uploaded = new Set(); // "machine|workflowId" pairs already pushed
    this.collected = [];
    this.collectErrors = [];
    this.seenFiles = new Set();
    this.downloads = new Set();
    this.running = false;
  }

  /* ------------------------------------------------------------ config */

  /** Apply a fleet config. Safe to call while work is in progress: existing workers keep going. */
  configure(config) {
    this.settings = { ...this.settings, ...config.fleet };
    this.collectCfg = { ...this.collectCfg, ...config.collect };

    const wanted = new Map(config.machines.map((m) => [m.name, m]));
    for (const [name, worker] of this.workers) {
      const cfg = wanted.get(name);
      if (!cfg) {
        // machine removed from the fleet
        if (worker.queue.length || worker.inflight.length) {
          this.log(`  ! ${name} was removed from the fleet - dropping its remaining work`);
        }
        worker.socketClose?.();
        this.workers.delete(name);
        continue;
      }
      worker.cfg = cfg;
      worker.client = new ComfyClient({ ...cfg, timeout: this.settings.requestTimeout, clientId: worker.client.clientId });
    }
    for (const [name, cfg] of wanted) {
      if (!this.workers.has(name)) this.workers.set(name, this.createWorker(cfg));
    }
    this.changed();
  }

  createWorker(cfg) {
    const client = new ComfyClient({ ...cfg, timeout: this.settings.requestTimeout });
    const worker = {
      name: cfg.name,
      cfg,
      client,
      status: 'idle', // idle | running | paused | offline
      note: '',
      queue: [],
      inflight: [],
      starting: 0, // pulled off the queue, still uploading or being submitted
      done: 0,
      failed: 0,
      cancelled: 0,
      files: 0,
      socketClose: null,
    };
    this.openSocket(worker);
    return worker;
  }

  setWorkflow(spec) {
    this.workflows.set(spec.id, spec);
    // a changed graph or new input files must be re-uploaded
    for (const key of [...this.uploaded]) {
      if (key.endsWith(`|${spec.id}`)) this.uploaded.delete(key);
    }
  }

  removeWorkflow(id) {
    this.workflows.delete(id);
  }

  /* ------------------------------------------------------------- queue */

  /**
   * Queue `count` generations of one workflow onto each of `machines`.
   * Returns the batch. Machines that are paused stay paused - the work waits for them.
   */
  enqueue({ workflowId, machines, count, seed = 'random', name = null }) {
    const spec = this.workflows.get(workflowId);
    if (!spec) throw new Error(`unknown workflow "${workflowId}"`);
    const targets = machines.filter((m) => this.workers.has(m));
    if (!targets.length) throw new Error('none of those machines are in the fleet');

    const batchId = `${timestamp()}-${safeName(spec.name)}`;
    const perMachine = Math.max(1, Number(count) || 1);
    const seedMode = seed === 'keep' ? 'keep' : seed === 'random' ? 'random' : 'fixed';
    let seedIndex = 0;

    const batch = {
      id: batchId,
      workflowId,
      workflowName: spec.name,
      machines: targets,
      total: perMachine * targets.length,
      done: 0,
      failed: 0,
      cancelled: 0,
      files: 0,
      startedAt: Date.now(),
      finishedAt: null,
      manifestWritten: false,
      results: [],
    };
    this.batches.set(batchId, batch);

    for (const machine of targets) {
      const worker = this.workers.get(machine);
      for (let i = 0; i < perMachine; i += 1) {
        worker.queue.push({
          id: `t${taskCounter++}`,
          batchId,
          workflowId,
          seed: seedMode === 'keep' ? -1 : seedMode === 'random' ? randomSeed() : Number(seed) + seedIndex++,
          attempts: 0,
        });
      }
      if (worker.status === 'idle') worker.status = 'running';
    }

    this.log(`+ queued ${perMachine} x '${spec.name}' on ${targets.join(', ')}  [${batchId}]`);
    this.changed();
    this.ensureLoop();
    return batch;
  }

  /* ---------------------------------------------------------- controls */

  pause(machine) {
    const worker = this.workers.get(machine);
    if (!worker || worker.status === 'paused') return;
    worker.status = 'paused';
    this.log(`|| ${machine} paused - ${worker.inflight.length} job(s) already sent will still finish`);
    this.changed();
  }

  resume(machine) {
    const worker = this.workers.get(machine);
    if (!worker || worker.status !== 'paused') return;
    worker.status = worker.queue.length || worker.inflight.length ? 'running' : 'idle';
    this.log(`> ${machine} resumed`);
    this.changed();
    this.ensureLoop();
  }

  /** Drop this machine's queue and stop what it is doing right now. */
  async stop(machine, { clearQueue = true } = {}) {
    const worker = this.workers.get(machine);
    if (!worker) return;
    const dropped = clearQueue ? worker.queue.length : 0;
    if (clearQueue) {
      for (const task of worker.queue) this.recordResult(task, machine, 'cancelled', 'cancelled before it started', 0);
      worker.queue = [];
    }
    const inflight = [...worker.inflight];
    worker.inflight = [];
    for (const item of inflight) {
      this.recordResult(item.task, machine, 'cancelled', 'stopped while running', 0);
    }
    worker.status = 'idle';
    try {
      await worker.client.cancelPending(inflight.map((i) => i.promptId));
      await worker.client.interrupt();
    } catch {
      /* the machine is unreachable; nothing left to cancel there anyway */
    }
    this.log(`■ ${machine} stopped${dropped ? ` - ${dropped} queued job(s) dropped` : ''}`);
    this.changed();
  }

  async stopAll() {
    await Promise.all([...this.workers.keys()].map((name) => this.stop(name)));
  }

  /* ------------------------------------------------------------ assets */

  async ensureAssets(worker, spec) {
    const key = `${worker.name}|${spec.id}`;
    if (this.uploaded.has(key)) return spec.graph;

    const files = assetFiles(spec);
    if (!files.length) {
      this.uploaded.add(key);
      spec.graphs = spec.graphs || new Map();
      spec.graphs.set(worker.name, spec.graph);
      return spec.graph;
    }

    const totalMb = files.reduce((sum, p) => sum + fs.statSync(p).size, 0) / 1024 ** 2;
    this.log(`  uploading ${files.length} input file(s), ${totalMb.toFixed(1)} MB, for '${spec.name}' to ${worker.name}`);
    const mapping = {};
    for (const file of files) mapping[path.basename(file)] = await worker.client.uploadAsset(file);
    const graph = spec.graph.clone();
    graph.rewriteAssetNames(mapping);
    spec.graphs = spec.graphs || new Map();
    spec.graphs.set(worker.name, graph);
    this.uploaded.add(key);
    return graph;
  }

  /* ---------------------------------------------------------- dispatch */

  async dispatchTo(worker) {
    if (worker.status === 'paused' || worker.status === 'offline') return;
    const slots = (worker.cfg.slots || 1) - worker.inflight.length - worker.starting;
    for (let i = 0; i < slots; i += 1) {
      const task = worker.queue.shift();
      if (!task) break;
      const spec = this.workflows.get(task.workflowId);
      if (!spec) {
        this.recordResult(task, worker.name, 'error', 'its workflow was removed', 0);
        continue;
      }
      // Between leaving the queue and landing in `inflight` the task is being uploaded and
      // submitted, which can take a while for a big video. Count it so it never disappears
      // from the totals the interface shows.
      worker.starting += 1;
      try {
        const graph = (await this.ensureAssets(worker, spec)).clone();
        if (task.seed >= 0) graph.setSeed(task.seed);
        const promptId = await worker.client.submit(graph.data, {
          comfyfleet: { batch: task.batchId, workflow: spec.name },
        });
        worker.inflight.push({ task, promptId, queuedAt: Date.now(), runningSince: 0, lastSeen: Date.now() });
        worker.status = 'running';
        worker.starting -= 1;
      } catch (err) {
        worker.starting -= 1;
        if (err instanceof WorkflowRejected) {
          this.log(`  x ${worker.name} refused '${spec.name}': ${err.message}`);
          this.recordResult(task, worker.name, 'error', err.message, 0);
          // the rest of this batch on this machine would fail the same way
          const same = worker.queue.filter((t) => t.batchId === task.batchId && t.workflowId === task.workflowId);
          worker.queue = worker.queue.filter((t) => !same.includes(t));
          for (const dropped of same) this.recordResult(dropped, worker.name, 'error', 'same workflow was refused', 0);
        } else {
          task.attempts += 1;
          if (task.attempts >= 3) {
            this.recordResult(task, worker.name, 'error', `could not be sent: ${err.message}`, 0);
          } else {
            worker.queue.unshift(task);
          }
          this.markOffline(worker, err.message);
        }
        break;
      }
    }
    if (worker.status === 'running' && !worker.queue.length && !worker.inflight.length) worker.status = 'idle';
  }

  markOffline(worker, reason) {
    if (worker.status === 'offline') return;
    worker.status = 'offline';
    worker.note = reason;
    this.log(`  ! ${worker.name} is not answering (${reason}) - its queue is kept, use Resume when it is back`);
    this.changed();
  }

  /* ----------------------------------------------------------- polling */

  async pollWorker(worker) {
    if (!worker.inflight.length) return;
    let queue;
    try {
      queue = await worker.client.queueIds();
      if (worker.status === 'offline') {
        worker.status = worker.queue.length || worker.inflight.length ? 'running' : 'idle';
        worker.note = '';
        this.log(`  + ${worker.name} is answering again`);
      }
    } catch (err) {
      this.markOffline(worker, err.message);
      return;
    }

    for (const item of [...worker.inflight]) {
      const running = queue.running.has(item.promptId);
      const pending = queue.pending.has(item.promptId);
      if (running && !item.runningSince) item.runningSince = Date.now();
      if (running || pending) {
        item.lastSeen = Date.now();
        // Only time spent actually executing counts towards the stall timeout, so a job
        // waiting its turn behind others is never written off.
        if (running && Date.now() - item.runningSince > this.settings.stallTimeout) {
          const minutes = Math.round(this.settings.stallTimeout / 60000);
          this.finish(worker, item, 'error', `still running after ${minutes} minutes - giving up on it`, null);
        }
        continue;
      }

      let record = null;
      try {
        record = await worker.client.history(item.promptId);
      } catch {
        item.lastSeen = Date.now();
        continue;
      }
      if (record) {
        const [state, detail] = ComfyClient.recordStatus(record);
        if (state === 'running') continue;
        this.finish(worker, item, state, detail, record);
      } else if (Date.now() - item.lastSeen > 20000) {
        this.finish(
          worker, item, 'error',
          'the machine no longer knows about this job (ComfyUI restarted, or its queue was cleared)',
          null,
        );
      }
    }
  }

  finish(worker, item, state, detail, record) {
    const at = worker.inflight.indexOf(item);
    if (at !== -1) worker.inflight.splice(at, 1);
    const seconds = (Date.now() - (item.runningSince || item.queuedAt)) / 1000;

    if (state === 'success') {
      const files = ComfyClient.outputsFromRecord(record || {});
      const shown = files.slice(0, 2).map((f) => f.filename).join(', ') || 'no files';
      this.log(`  + ${worker.name} finished a '${this.batches.get(item.task.batchId)?.workflowName}' job in ${seconds.toFixed(0)}s -> ${shown}`);
      this.queueDownload(worker, item, files);
    } else {
      this.log(`  x ${worker.name}: ${detail}`);
    }
    this.recordResult(item.task, worker.name, state, detail, seconds, item.promptId);

    if (!worker.queue.length && !worker.inflight.length && worker.status === 'running') worker.status = 'idle';
    this.changed();
  }

  recordResult(task, machine, state, detail, seconds, promptId = '') {
    const batch = this.batches.get(task.batchId);
    const worker = this.workers.get(machine);
    // Stopping a machine on purpose is not a failure - keep the two apart so the totals
    // stay honest and a deliberate stop never looks like something went wrong.
    const bucket = state === 'success' ? 'done' : state === 'cancelled' ? 'cancelled' : 'failed';
    if (worker) worker[bucket] += 1;
    if (batch) batch[bucket] += 1;
    if (batch) {
      batch.results.push({ machine, state, detail, seconds, promptId, seed: task.seed });
      if (batch.done + batch.failed + batch.cancelled >= batch.total && !batch.finishedAt) {
        batch.finishedAt = Date.now();
        this.finishBatch(batch);
      }
    }
  }

  finishBatch(batch) {
    this.log(
      `= batch '${batch.workflowName}' finished: ${batch.done}/${batch.total} ok` +
        `${batch.failed ? `, ${batch.failed} failed` : ''}${batch.cancelled ? `, ${batch.cancelled} cancelled` : ''}` +
        `, ${batch.files} file(s)  [${batch.id}]`,
    );
    if (this.collectCfg.enabled && !batch.manifestWritten) {
      batch.manifestWritten = true;
      const manifest = {
        runId: batch.id,
        workflow: batch.workflowName,
        machines: batch.machines,
        started: new Date(batch.startedAt).toISOString(),
        elapsedSeconds: Math.round(((batch.finishedAt || Date.now()) - batch.startedAt) / 100) / 10,
        tasksTotal: batch.total,
        tasksSucceeded: batch.done,
        tasksFailed: batch.failed,
        filesCollected: batch.files,
        files: this.collected.filter((f) => f.batchId === batch.id),
        results: batch.results,
      };
      writeManifest(manifest, this.collectCfg.destination, batch.id);
    }
    this.changed();
  }

  /* -------------------------------------------------------- collecting */

  openSocket(worker) {
    worker.socketClose = worker.client.connectEvents({
      onStart: (promptId) => {
        const item = worker.inflight.find((i) => i.promptId === promptId);
        if (item && !item.runningSince) item.runningSince = Date.now();
      },
      onExecuted: (promptId, files) => {
        const item = worker.inflight.find((i) => i.promptId === promptId);
        if (!item) return;
        item.lastSeen = Date.now();
        this.queueDownload(worker, item, files);
      },
    });
  }

  fileKey(worker, item, file) {
    return `${worker.name}|${item.promptId}|${file.subfolder}/${file.filename}`;
  }

  queueDownload(worker, item, files) {
    if (!this.collectCfg.enabled) return;
    const wanted = [];
    for (const file of files) {
      if (file.type !== 'output') continue;
      const key = this.fileKey(worker, item, file);
      if (this.seenFiles.has(key)) continue;
      this.seenFiles.add(key);
      wanted.push(file);
    }
    if (!wanted.length) return;
    const promise = this.collectFiles(worker, item, wanted).finally(() => this.downloads.delete(promise));
    this.downloads.add(promise);
  }

  destinationFor(worker, item, file) {
    const batch = this.batches.get(item.task.batchId);
    const ext = path.extname(file.filename);
    const tokens = {
      run_id: batch?.id || 'run',
      batch: batch?.id || 'run',
      machine: worker.name,
      workflow: safeName(batch?.workflowName || 'workflow'),
      filename: file.filename,
      stem: path.basename(file.filename, ext),
      ext: ext.replace(/^\./, ''),
      seed: String(item.task.seed),
      node: file.nodeId,
      kind: file.kind,
      job: safeName(batch?.workflowName || 'job'),
      task: String(item.task.id),
      date: new Date().toISOString().slice(0, 10),
      subfolder: file.subfolder,
    };
    const relative = (this.collectCfg.layout || '{run_id}/{machine}/{filename}')
      .replace(/\{(\w+)\}/g, (match, key) => (key in tokens ? String(tokens[key]) : match))
      .replace(/\\/g, '/');
    const parts = relative.split('/').filter(Boolean).map((part) => safePathPart(part));
    return path.join(this.collectCfg.destination, ...parts);
  }

  async collectFiles(worker, item, files) {
    for (const file of files) {
      const dest = this.destinationFor(worker, item, file);
      try {
        const written = await worker.client.download(file, dest, { overwrite: this.collectCfg.overwrite });
        const batch = this.batches.get(item.task.batchId);
        this.collected.push({
          batchId: item.task.batchId,
          machine: worker.name,
          workflow: batch?.workflowName || '',
          seed: item.task.seed,
          promptId: item.promptId,
          node: file.nodeId,
          kind: file.kind,
          remote: file.subfolder ? `${file.subfolder}/${file.filename}` : file.filename,
          local: written,
          bytes: fs.existsSync(written) ? fs.statSync(written).size : 0,
        });
        worker.files += 1;
        if (batch) batch.files += 1;
        this.log(`  ↓ ${worker.name} saved ${path.basename(written)}`);
        this.changed();
      } catch (err) {
        this.seenFiles.delete(this.fileKey(worker, item, file));
        this.collectErrors.push(`${worker.name} ${file.filename}: ${err.message}`);
      }
    }
  }

  /* --------------------------------------------------------- main loop */

  ensureLoop() {
    if (this.running) return;
    this.running = true;
    (async () => {
      while (this.running) {
        try {
          await Promise.all([...this.workers.values()].map((w) => this.dispatchTo(w)));
          await Promise.all([...this.workers.values()].map((w) => this.pollWorker(w)));
        } catch (err) {
          this.log(`! supervisor error: ${err.message}`);
        }
        const busy = [...this.workers.values()].some((w) => w.queue.length || w.inflight.length);
        if (!busy && !this.downloads.size) {
          this.running = false;
          this.changed();
          break;
        }
        await sleep(this.settings.pollInterval);
      }
    })();
  }

  changed() {
    try {
      this.onChange(this.snapshot());
    } catch {
      /* the UI is a listener, not a dependency */
    }
  }

  /** Everything the interface needs to draw the current state. */
  snapshot() {
    return {
      busy: [...this.workers.values()].some((w) => w.queue.length || w.inflight.length),
      machines: [...this.workers.values()].map((w) => ({
        name: w.name,
        status: w.status,
        note: w.note,
        queued: w.queue.length + w.starting,
        running: w.inflight.length,
        done: w.done,
        failed: w.failed,
        cancelled: w.cancelled,
        files: w.files,
        workflow: this.workflows.get(w.queue[0]?.workflowId || w.inflight[0]?.task.workflowId)?.name || null,
      })),
      batches: [...this.batches.values()]
        .slice(-12)
        .map((b) => ({
          id: b.id, workflow: b.workflowName, machines: b.machines,
          total: b.total, done: b.done, failed: b.failed, cancelled: b.cancelled, files: b.files,
          finished: !!b.finishedAt,
        })),
      files: this.collected.length,
      collectErrors: this.collectErrors.slice(-10),
    };
  }

  /** Wait until nothing is queued or running (used by the CLI). */
  async waitUntilIdle() {
    while (true) {
      const busy = [...this.workers.values()].some((w) => w.queue.length || w.inflight.length);
      if (!busy && !this.downloads.size) break;
      await sleep(500);
    }
    await Promise.all([...this.downloads]);
  }

  shutdown() {
    this.running = false;
    for (const worker of this.workers.values()) worker.socketClose?.();
  }
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
