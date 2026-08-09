/** Scan a LAN range for reachable ComfyUI instances. */

import { ComfyClient } from './client.js';

export const DEFAULT_PORTS = [8000, 8188, 8189];

/** Accept '192.168.1.0/24', '192.168.1.10-40', or a single host / name. */
export function expandTargets(spec) {
  const text = String(spec || '').trim();
  if (!text) return [];

  if (text.includes('/')) {
    const [base, bitsRaw] = text.split('/');
    const bits = Number(bitsRaw);
    const octets = base.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n)) || !Number.isFinite(bits)) {
      throw new Error(`not a valid address range: ${text}`);
    }
    if (bits < 16 || bits > 32) throw new Error('mask must be between /16 and /32');
    const toInt = (parts) => ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const size = 2 ** (32 - bits);
    const network = (toInt(octets) & (size === 2 ** 32 ? 0 : ~(size - 1) >>> 0)) >>> 0;
    const hosts = [];
    const first = size > 2 ? network + 1 : network;
    const last = size > 2 ? network + size - 2 : network + size - 1;
    for (let ip = first; ip <= last; ip += 1) {
      hosts.push([(ip >>> 24) & 255, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'));
    }
    return hosts;
  }

  const rangeMatch = text.match(/^(\d+\.\d+\.\d+)\.(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    const [, prefix, fromRaw, toRaw] = rangeMatch;
    const from = Number(fromRaw);
    const to = Number(toRaw);
    const hosts = [];
    for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) hosts.push(`${prefix}.${i}`);
    return hosts;
  }

  return [text];
}

async function mapWithLimit(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function scan(spec, { ports = DEFAULT_PORTS, timeout = 1500, concurrency = 128, onProgress } = {}) {
  const hosts = expandTargets(spec);
  const targets = hosts.flatMap((host) => ports.map((port) => ({ host, port })));
  let done = 0;

  const results = await mapWithLimit(targets, concurrency, async ({ host, port }) => {
    const client = new ComfyClient({ name: host, host, port, timeout });
    let found = null;
    try {
      const info = await client.ping();
      found = { ...info, host, port };
    } catch {
      found = null;
    }
    done += 1;
    if (onProgress) onProgress(done, targets.length);
    return found;
  });

  return results
    .filter(Boolean)
    .sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }) || a.port - b.port);
}
