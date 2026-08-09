/** Pre-run verification: does every machine have the nodes and models this workflow needs? */

import path from 'node:path';

import { ComfyError } from './client.js';

/**
 * Extract the allowed values of a combo widget from an /object_info input spec.
 *
 * ComfyUI has shipped three shapes for this over time and they all still appear:
 *   [["a.safetensors", "b.safetensors"], {...}]       classic
 *   [{"options": [...]}, {...}]                       dict head
 *   ["COMBO", {"options": [...], "image_upload": 1}]  options in the settings dict
 * Missing the third one is how a workflow can pass preflight and then be rejected
 * by /prompt for a file the machine does not have.
 */
export function enumOptions(spec) {
  if (!Array.isArray(spec) || !spec.length) return null;
  const head = spec[0];
  const clean = (list) => list.filter((v) => ['string', 'number'].includes(typeof v)).map(String);
  if (Array.isArray(head)) return clean(head);
  if (head && typeof head === 'object' && Array.isArray(head.options)) return clean(head.options);
  if (spec[1] && typeof spec[1] === 'object' && Array.isArray(spec[1].options)) return clean(spec[1].options);
  return null;
}

const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx', '.sft', '.yaml']);
const MEDIA_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif',
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.wav', '.mp3', '.flac', '.ogg', '.m4a',
]);

/** 'model' | 'input' | 'setting' - decides both the advice and whether it is worth blocking. */
export function classifyValue(value) {
  const ext = path.extname(String(value)).toLowerCase();
  if (MODEL_EXTENSIONS.has(ext)) return 'model';
  if (MEDIA_EXTENSIONS.has(ext)) return 'input';
  return 'setting';
}

export function describeMissing(missing) {
  const where = `node ${missing.nodeId} ${missing.classType}.${missing.field}`;
  if (missing.kind === 'setting') {
    const has = missing.options?.length ? ` It offers: ${missing.options.slice(0, 6).join(', ')}` : '';
    return `this machine's ComfyUI does not offer '${missing.value}' for ${where}.${has}`;
  }
  let text = `'${missing.value}' is not on this machine (${where})`;
  if (missing.options?.length) {
    const sample = missing.options.slice(0, 4).join(', ');
    const extra = missing.options.length > 4 ? `, +${missing.options.length - 4} more` : '';
    text += ` - it has: ${sample}${extra}`;
  } else if (missing.kind === 'input') {
    text += ' - its input folder is empty';
  } else {
    text += ' - it has no models of that kind';
  }
  return text;
}

/**
 * @param pendingAssets Set of input filenames the run will upload, so they are not reported missing.
 */
export async function checkMachine(client, workflow, pendingAssets = new Set()) {
  const report = {
    machine: client.name,
    reachable: false,
    error: '',
    comfyuiVersion: '?',
    gpu: '?',
    missingClasses: [],
    missingValues: [],
    ok: false,
  };

  try {
    const info = await client.ping();
    report.reachable = true;
    report.comfyuiVersion = info.comfyuiVersion;
    report.gpu = info.gpu;
  } catch (err) {
    report.error = err instanceof ComfyError ? err.message : String(err);
    return report;
  }

  let objectInfo;
  try {
    objectInfo = await client.objectInfo();
  } catch (err) {
    report.error = `could not read /object_info: ${err.message}`;
    return report;
  }

  const available = new Set(Object.keys(objectInfo));
  report.missingClasses = [...workflow.classTypes()].filter((c) => !available.has(c)).sort();

  for (const { nodeId, classType, field, value } of workflow.widgetValues()) {
    const nodeSpec = objectInfo[classType];
    if (!nodeSpec) continue; // already reported as a missing class
    const inputs = nodeSpec.input || {};
    const spec = inputs.required?.[field] ?? inputs.optional?.[field];
    const options = enumOptions(spec);
    if (options === null) continue; // free-form widget (text, filename prefix, ...)

    const kind = classifyValue(value);
    if (!options.length && kind === 'setting') {
      // The machine reported no choices at all for this widget. That means it could not
      // enumerate them, not that the value is wrong - blocking here would refuse a machine
      // over something like SaveVideo.codec = "auto". Files are different: an empty list
      // really does mean the folder holds nothing.
      continue;
    }
    if (!options.includes(value) && !pendingAssets.has(path.basename(value))) {
      report.missingValues.push({ nodeId, classType, field, value, options, kind });
    }
  }

  report.ok = report.reachable && !report.missingClasses.length && !report.missingValues.length;
  return report;
}

export function summarize(reports) {
  return {
    ready: reports.filter((r) => r.ok).map((r) => r.machine),
    blocked: reports.filter((r) => !r.ok).map((r) => r.machine),
  };
}

export function formatReport(reports) {
  const lines = [];
  for (const r of [...reports].sort((a, b) => a.machine.localeCompare(b.machine))) {
    if (!r.reachable) {
      lines.push(`  [OFFLINE] ${r.machine}: ${r.error}`);
      continue;
    }
    if (r.ok) {
      lines.push(`  [  OK   ] ${r.machine}  ComfyUI ${r.comfyuiVersion}  ${r.gpu}`);
      continue;
    }
    lines.push(`  [MISSING] ${r.machine}  ComfyUI ${r.comfyuiVersion}  ${r.gpu}`);
    if (r.error) lines.push(`             error: ${r.error}`);
    for (const cls of r.missingClasses) lines.push(`             custom node not installed: ${cls}`);
    for (const missing of r.missingValues) lines.push(`             ${describeMissing(missing)}`);
  }
  return lines.join('\n');
}
