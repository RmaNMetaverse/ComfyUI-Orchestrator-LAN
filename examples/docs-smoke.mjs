// A clean, isolated walkthrough of the API call documented on the site.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'comfyfleet-docs-'));
const children = [];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(script, args, env = {}) {
  const child = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function ready(url) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await request(url); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(`Server did not become ready: ${url}`);
}

try {
  const [mockPort, webPort] = await Promise.all([freePort(), freePort()]);
  start('tools/mock-comfy.js', ['--port', String(mockPort), '--name', 'DOCS-MOCK', '--delay', '0', '--root', path.join(temporary, 'mock')]);
  await ready(`http://127.0.0.1:${mockPort}/system_stats`);
  start('bin/cf.js', ['web', '--port', String(webPort)], {
    COMFYFLEET_CONFIG: path.join(temporary, 'config'),
    COMFYFLEET_PICKER: 'off',
  });
  const base = `http://127.0.0.1:${webPort}`;
  const state = await ready(`${base}/api/state`);
  if (!Array.isArray(state.config?.machines) || state.config.machines.length !== 0 || state.configError !== null) {
    throw new Error('Unexpected state for a clean setup');
  }
  console.log(`GET /api/state: HTTP 200, version ${state.version}, 0 configured machines`);

  const config = {
    ...state.config,
    machines: [{ name: 'DOCS-MOCK', host: '127.0.0.1', port: mockPort }],
  };
  await request(`${base}/api/fleet`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const status = await request(`${base}/api/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (status.machines?.[0]?.online !== true) throw new Error('Mock worker did not report online');
  console.log('Mock ComfyUI worker: online');
} finally {
  for (const child of children) child.kill();
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
