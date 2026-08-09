/**
 * A fake ComfyUI server - lets you exercise ComfyFleet without touching a GPU box.
 *
 *   node tools/mock-comfy.js --port 8801 --name FAKE-01 --delay 3
 *
 * It implements the endpoints ComfyFleet uses (/system_stats, /object_info, /prompt,
 * /history, /view, /upload/image, /queue, /interrupt, /free), validates LoadImage /
 * LoadVideo file names the way real ComfyUI does, and produces a small PNG per job.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const NAME = args.name || 'MOCK';
const PORT = Number(args.port) || 8801;
const HOST = args.host || '127.0.0.1';
const DELAY = Number(args.delay ?? 3) * 1000;
const GPU = args.gpu || 'NVIDIA GeForce RTX 4090 (mock)';
const ROOT = args.root || path.join(HERE, '_mock', NAME);

const INPUT_DIR = path.join(ROOT, 'input');
const OUTPUT_DIR = path.join(ROOT, 'output');
fs.mkdirSync(INPUT_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const state = { queue: [], running: [], history: {}, counter: 0, working: false };

/* --------------------------------------------------------------- helpers */

function makePng(width, height, [r, g, b]) {
  const chunk = (tag, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: width }, () => Buffer.from([r, g, b])))]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

const inputFiles = (extensions) =>
  fs
    .readdirSync(INPUT_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && extensions.includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

function objectInfo() {
  return {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors', 'dreamshaper_8.safetensors']] } } },
    CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } } },
    EmptyLatentImage: { input: { required: { width: ['INT'], height: ['INT'], batch_size: ['INT'] } } },
    KSampler: {
      input: {
        required: {
          seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'],
          sampler_name: [['euler', 'dpmpp_2m', 'ddim']],
          scheduler: [['normal', 'karras', 'simple']],
          denoise: ['FLOAT'], model: ['MODEL'], positive: ['CONDITIONING'],
          negative: ['CONDITIONING'], latent_image: ['LATENT'],
        },
      },
    },
    VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } } },
    SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } } },
    LoadImage: { input: { required: { image: [inputFiles(['.png', '.jpg', '.jpeg', '.webp'])] } } },
    // Some builds report a combo with no options at all - ComfyFleet must not read that
    // as "the value is missing" (this is what SaveVideo.codec does on 0.3.6x).
    SaveVideo: {
      input: {
        required: {
          video: ['VIDEO'],
          filename_prefix: ['STRING'],
          format: ['COMBO', { options: [] }],
          codec: ['COMBO', { options: [] }],
        },
      },
    },
    // Newer ComfyUI declares upload combos this way - the options live in the settings
    // dict, not in the first element.
    LoadVideo: {
      input: {
        required: {
          file: ['COMBO', { options: inputFiles(['.mp4', '.mov', '.mkv', '.webm']), video_upload: true }],
        },
      },
    },
  };
}

/** Reject LoadVideo / LoadImage nodes whose file is not in the input folder. */
function validate(prompt) {
  const checks = { LoadVideo: ['file', 'Invalid video file'], LoadImage: ['image', 'Invalid image file'] };
  const errors = {};
  for (const [nodeId, node] of Object.entries(prompt || {})) {
    const spec = checks[node?.class_type];
    if (!spec) continue;
    const [field, label] = spec;
    const name = node.inputs?.[field];
    if (typeof name === 'string' && !fs.existsSync(path.join(INPUT_DIR, name))) {
      errors[nodeId] = {
        errors: [{
          type: 'custom_validation_failed',
          message: 'Custom validation failed for node',
          details: `${field} - ${label}: ${name}`,
          extra_info: { input_name: field },
        }],
        dependent_outputs: [],
        class_type: node.class_type,
      };
    }
  }
  return errors;
}

async function worker() {
  if (state.working) return;
  state.working = true;
  while (state.queue.length) {
    const { promptId, prompt } = state.queue.shift();
    state.running.push(promptId);
    await new Promise((resolve) => setTimeout(resolve, DELAY));
    state.counter += 1;
    let seed = 0;
    for (const node of Object.values(prompt)) {
      if (node?.inputs && 'seed' in node.inputs) seed = Number(node.inputs.seed) || 0;
    }
    const filename = `${NAME}_${String(state.counter).padStart(5, '0')}_.png`;
    fs.writeFileSync(path.join(OUTPUT_DIR, filename), makePng(64, 64, [(seed * 37) % 255, (seed * 91) % 255, (seed * 13) % 255]));
    state.history[promptId] = {
      prompt: [0, promptId, prompt, {}, []],
      outputs: { 9: { images: [{ filename, subfolder: '', type: 'output' }] } },
      status: { status_str: 'success', completed: true, messages: [] },
    };
    state.running = state.running.filter((id) => id !== promptId);
  }
  state.working = false;
}

/* ---------------------------------------------------------------- server */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function multipartFilename(body) {
  const marker = 'filename="';
  const text = body.toString('latin1');
  const start = text.indexOf(marker);
  if (start === -1) return null;
  return text.slice(start + marker.length, text.indexOf('"', start + marker.length));
}

function multipartPayload(body) {
  const separator = body.indexOf('\r\n\r\n');
  if (separator === -1) return body;
  const end = body.lastIndexOf('\r\n--');
  return body.subarray(separator + 4, end > separator ? end : body.length);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (body, status = 200) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(text);
  };

  if (req.method === 'GET') {
    if (url.pathname === '/system_stats') {
      return json({
        system: { os: process.platform, comfyui_version: '0.3.44-mock', python_version: '3.13.5 (mock)' },
        devices: [{ name: GPU, type: 'cuda', vram_total: 24 * 1024 ** 3, vram_free: 21 * 1024 ** 3 }],
      });
    }
    if (url.pathname === '/object_info') return json(objectInfo());
    if (url.pathname === '/prompt') return json({ exec_info: { queue_remaining: state.queue.length + state.running.length } });
    if (url.pathname === '/queue') return json({ queue_running: state.running, queue_pending: state.queue.map((q) => q.promptId) });
    if (url.pathname.startsWith('/history')) {
      const id = url.pathname.split('/').pop();
      if (!id || id === 'history') return json(state.history);
      return json(state.history[id] ? { [id]: state.history[id] } : {});
    }
    if (url.pathname === '/view') {
      const file = path.join(OUTPUT_DIR, path.basename(url.searchParams.get('filename') || ''));
      if (!fs.existsSync(file)) return json({ error: 'not found' }, 404);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(fs.readFileSync(file));
    }
    return json({ error: `mock: no route ${url.pathname}` }, 404);
  }

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (url.pathname === '/prompt') {
      const data = JSON.parse(body.toString('utf8') || '{}');
      const errors = validate(data.prompt);
      if (Object.keys(errors).length) {
        // The same shape real ComfyUI returns when a node's file does not exist.
        return json({
          error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
          node_errors: errors,
        }, 400);
      }
      const promptId = randomUUID();
      state.queue.push({ promptId, prompt: data.prompt || {} });
      worker();
      return json({ prompt_id: promptId, number: 1, node_errors: {} });
    }
    if (url.pathname === '/upload/image') {
      const name = multipartFilename(body) || `upload-${randomUUID().slice(0, 8)}.bin`;
      fs.writeFileSync(path.join(INPUT_DIR, path.basename(name)), multipartPayload(body));
      return json({ name: path.basename(name), subfolder: '', type: 'input' });
    }
    if (url.pathname === '/queue') {
      const data = JSON.parse(body.toString('utf8') || '{}');
      if (data.clear) state.queue = [];
      if (Array.isArray(data.delete)) state.queue = state.queue.filter((q) => !data.delete.includes(q.promptId));
      return json({});
    }
    if (url.pathname === '/interrupt' || url.pathname === '/free') return json({});
    return json({ error: `mock: no route ${url.pathname}` }, 404);
  }

  return json({ error: 'method not allowed' }, 405);
});

server.listen(PORT, HOST, () => {
  console.log(`mock ComfyUI '${NAME}' on http://${HOST}:${PORT}  (${DELAY / 1000}s per job, root ${ROOT})`);
});
