/**
 * Thin wrapper over the ComfyUI HTTP API.
 *
 * Endpoints used (identical on ComfyUI Desktop, portable and manual installs):
 *   GET  /system_stats         machine + GPU + version info
 *   GET  /object_info          every installed node class and its widget enums
 *   GET  /queue                running + pending items
 *   POST /prompt               queue an API-format workflow
 *   GET  /history/{prompt_id}  result + produced files for one submission
 *   GET  /view                 download a produced file
 *   POST /upload/image         push an input asset into the machine's input/ dir
 *   POST /interrupt            stop the running job
 *   POST /free                 unload models / free VRAM
 */

import fs from 'node:fs';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

export class ComfyError extends Error {}

/**
 * ComfyUI refused the workflow itself - the machine is fine, the graph is not.
 * Retrying elsewhere is pointless: every machine will reject it the same way.
 */
export class WorkflowRejected extends ComfyError {}

/** Turn ComfyUI's /prompt error payload into one readable line per bad node. */
export function formatRejection(data, response = null) {
  const lines = [];
  for (const [nodeId, info] of Object.entries(data?.node_errors || {})) {
    const classType = info?.class_type || '?';
    const errors = info?.errors || [];
    if (!errors.length) {
      lines.push(`node ${nodeId} (${classType}): invalid`);
      continue;
    }
    for (const error of errors) {
      const detail = error?.details || error?.message || 'invalid';
      lines.push(`node ${nodeId} (${classType}): ${detail}`);
    }
  }
  if (lines.length) return lines.join('; ');
  const error = data?.error;
  if (error && typeof error === 'object' && error.message) {
    return error.details ? `${error.message} - ${error.details}` : error.message;
  }
  if (response) return `HTTP ${response.status}`;
  return JSON.stringify(data).slice(0, 300);
}

function describeNetworkError(err) {
  // fetch wraps the real problem: TypeError('fetch failed') with the cause underneath,
  // and for multi-address hosts the cause is an AggregateError holding one error per try.
  const cause = err?.cause;
  const inner = cause?.errors?.[0] || cause;
  const code = inner?.code || cause?.code || err?.code;
  const name = inner?.name || cause?.name || err?.name;

  if (name === 'TimeoutError' || name === 'ConnectTimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'no answer (host up but nothing listening, or blocked by the firewall)';
  }
  if (code === 'ECONNREFUSED') return 'cannot connect (ComfyUI not running, or still bound to 127.0.0.1)';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host unreachable on this network';
  if (code === 'ENOTFOUND') return 'unknown host name';
  if (code === 'ECONNRESET') return 'the connection was closed by the machine';
  if (code === 'EACCES') return 'the connection was blocked (firewall or security software on this computer)';
  if (name === 'AbortError') return 'cancelled';
  const detail = inner?.message || err?.message || String(err);
  return detail === 'fetch failed' ? 'no route to this address (check the IP and that the machine is on)' : detail;
}

export class ComfyClient {
  constructor({ name, host, port = 8000, scheme = 'http', timeout = 20000, clientId = null }) {
    this.name = name || host;
    this.host = host;
    this.port = port;
    this.scheme = scheme;
    this.timeout = timeout;
    this.clientId = clientId || randomUUID();
    this.baseUrl = `${scheme}://${host}:${port}`;
  }

  url(pathname, params) {
    const url = new URL(pathname, this.baseUrl);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url;
  }

  async request(method, pathname, { params, json, body, timeout, check = true } = {}) {
    const ms = timeout || this.timeout;
    let response;
    try {
      response = await fetch(this.url(pathname, params), {
        method,
        signal: AbortSignal.timeout(ms),
        ...(json !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      throw new ComfyError(`${this.baseUrl} ${method} ${pathname}: ${describeNetworkError(err)}`);
    }
    if (check && !response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 400);
      throw new ComfyError(`${this.name}: ${method} ${pathname} -> HTTP ${response.status}: ${text}`);
    }
    return response;
  }

  async getJson(pathname, options) {
    const response = await this.request('GET', pathname, options);
    return response.json();
  }

  /* ------------------------------------------------------------- info */

  /** A small summary, or throws ComfyError when the machine cannot be reached. */
  async ping() {
    const stats = await this.getJson('/system_stats', { timeout: Math.min(this.timeout, 8000) });
    const system = stats.system || {};
    const device = (stats.devices || [])[0] || {};
    const gb = (bytes) => (bytes ? Math.round((bytes / 1024 ** 3) * 10) / 10 : 0);
    let queue = 0;
    try {
      queue = await this.queueRemaining();
    } catch {
      /* the machine answered /system_stats; a queue hiccup should not mark it offline */
    }
    return {
      name: this.name,
      url: this.baseUrl,
      comfyuiVersion: system.comfyui_version || '?',
      python: String(system.python_version || '?').split(' ')[0],
      os: system.os || '?',
      gpu: device.name || '?',
      vramTotalGb: gb(device.vram_total),
      vramFreeGb: gb(device.vram_free),
      queue,
    };
  }

  objectInfo() {
    return this.getJson('/object_info', { timeout: Math.max(this.timeout, 60000) });
  }

  queue() {
    return this.getJson('/queue');
  }

  /**
   * Which prompt ids this machine still knows about.
   * Used to tell "queued behind other work" apart from "vanished", which /history alone
   * cannot do - it stays empty for queued and running prompts alike.
   */
  async queueIds() {
    const data = await this.getJson('/queue', { timeout: Math.min(this.timeout, 15000) });
    const ids = (list) => (Array.isArray(list) ? list : []).map((item) => String(item?.[1] ?? '')).filter(Boolean);
    return { running: new Set(ids(data.queue_running)), pending: new Set(ids(data.queue_pending)) };
  }

  /**
   * Listen to this machine's event socket, so outputs can be collected the moment a node
   * saves them instead of waiting for the whole prompt to finish.
   *
   * Returns a close function. Never throws: if the socket cannot be opened the caller
   * carries on with plain polling.
   */
  connectEvents({ onExecuted, onStart, onError } = {}) {
    let socket = null;
    let closed = false;
    let retries = 0;

    const open = () => {
      if (closed) return;
      const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(this.clientId)}`;
      try {
        socket = new WebSocket(url);
      } catch {
        return; // no socket on this machine - polling still covers everything
      }
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return; // binary preview frames
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const data = message?.data || {};
        if (message.type === 'executed' && data.prompt_id && data.output) {
          const files = [];
          for (const [kind, entries] of Object.entries(data.output)) {
            if (!Array.isArray(entries)) continue;
            for (const entry of entries) {
              if (entry && typeof entry === 'object' && entry.filename) {
                files.push({
                  filename: String(entry.filename),
                  subfolder: String(entry.subfolder || ''),
                  type: String(entry.type || 'output'),
                  nodeId: String(data.node ?? data.display_node ?? '?'),
                  kind: String(kind),
                });
              }
            }
          }
          if (files.length) onExecuted?.(String(data.prompt_id), files);
        } else if (message.type === 'execution_start' && data.prompt_id) {
          onStart?.(String(data.prompt_id));
        } else if (message.type === 'execution_error' && data.prompt_id) {
          onError?.(String(data.prompt_id), data);
        }
      });
      socket.addEventListener('close', () => {
        if (closed || retries >= 5) return;
        retries += 1;
        setTimeout(open, 1000 * retries);
      });
      socket.addEventListener('error', () => { /* the close handler retries */ });
    };

    open();
    return () => {
      closed = true;
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
    };
  }

  async queueRemaining() {
    const data = await this.getJson('/prompt', { timeout: Math.min(this.timeout, 8000) });
    return Number(data?.exec_info?.queue_remaining || 0);
  }

  /* ------------------------------------------------------- submission */

  async submit(prompt, extraData = null) {
    const body = { prompt, client_id: this.clientId, ...(extraData ? { extra_data: extraData } : {}) };
    const response = await this.request('POST', '/prompt', {
      json: body,
      timeout: Math.max(this.timeout, 60000),
      check: false,
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok || (data.node_errors && Object.keys(data.node_errors).length)) {
      throw new WorkflowRejected(`${this.name} rejected the workflow: ${formatRejection(data, response)}`);
    }
    if (!data.prompt_id) throw new ComfyError(`${this.name}: no prompt_id in the reply`);
    return String(data.prompt_id);
  }

  /** null while the job is still queued or running, else the history record. */
  async history(promptId) {
    const data = await this.getJson(`/history/${promptId}`, { timeout: Math.min(this.timeout, 15000) });
    return data?.[promptId] || null;
  }

  /** ['success' | 'error' | 'running', detail] */
  static recordStatus(record) {
    const status = record?.status || {};
    if (status.status_str === 'success' || (status.completed && status.status_str !== 'error')) {
      return ['success', ''];
    }
    if (status.status_str === 'error') {
      for (const message of status.messages || []) {
        if (Array.isArray(message) && ['execution_error', 'execution_interrupted'].includes(message[0])) {
          const info = message[1] || {};
          const what = info.exception_message || info.exception_type || 'unknown error';
          return ['error', `${info.node_type || '?'} #${info.node_id || '?'}: ${what}`];
        }
      }
      return ['error', 'execution error'];
    }
    return ['running', ''];
  }

  static outputsFromRecord(record) {
    const found = [];
    for (const [nodeId, nodeOutput] of Object.entries(record?.outputs || {})) {
      if (!nodeOutput || typeof nodeOutput !== 'object') continue;
      for (const [kind, entries] of Object.entries(nodeOutput)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (entry && typeof entry === 'object' && entry.filename) {
            found.push({
              filename: String(entry.filename),
              subfolder: String(entry.subfolder || ''),
              type: String(entry.type || 'output'),
              nodeId: String(nodeId),
              kind: String(kind),
            });
          }
        }
      }
    }
    return found;
  }

  /* ------------------------------------------------------------ files */

  async download(file, destination, { overwrite = false } = {}) {
    let dest = destination;
    if (!overwrite && fs.existsSync(dest)) {
      const dir = path.dirname(dest);
      const ext = path.extname(dest);
      const stem = path.basename(dest, ext);
      let n = 1;
      while (fs.existsSync(dest)) dest = path.join(dir, `${stem}_${n++}${ext}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const response = await this.request('GET', '/view', {
      params: { filename: file.filename, subfolder: file.subfolder, type: file.type },
      timeout: Math.max(this.timeout, 300000),
    });
    const temp = `${dest}.part`;
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
    fs.renameSync(temp, dest);
    return dest;
  }

  /** Push a file into this machine's input/ folder. Returns the name to use in the workflow. */
  async uploadAsset(file, { subfolder = '', overwrite = true } = {}) {
    const form = new FormData();
    form.append('image', await openAsBlob(file), path.basename(file));
    form.append('type', 'input');
    form.append('overwrite', overwrite ? 'true' : 'false');
    if (subfolder) form.append('subfolder', subfolder);
    const response = await this.request('POST', '/upload/image', {
      body: form,
      timeout: Math.max(this.timeout, 600000),
    });
    let info = {};
    try {
      info = await response.json();
    } catch {
      return path.basename(file);
    }
    const name = info.name || path.basename(file);
    return info.subfolder ? `${info.subfolder}/${name}` : name;
  }

  /* ---------------------------------------------------------- control */

  interrupt() {
    return this.request('POST', '/interrupt', { json: {}, timeout: Math.min(this.timeout, 10000) });
  }

  clearQueue() {
    return this.request('POST', '/queue', { json: { clear: true }, timeout: Math.min(this.timeout, 10000) });
  }

  cancelPending(promptIds) {
    const ids = [...promptIds].filter(Boolean);
    if (!ids.length) return Promise.resolve();
    return this.request('POST', '/queue', { json: { delete: ids }, timeout: Math.min(this.timeout, 10000) });
  }

  freeMemory({ unloadModels = true } = {}) {
    return this.request('POST', '/free', {
      json: { unload_models: unloadModels, free_memory: true },
      timeout: Math.min(this.timeout, 30000),
    });
  }
}

export function clientFor(machine, { timeout = 20000 } = {}) {
  return new ComfyClient({ ...machine, timeout });
}
