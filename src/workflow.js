/** Loading, inspecting and patching API-format ComfyUI workflows. */

import fs from 'node:fs';
import path from 'node:path';

export class WorkflowError extends Error {}

const SEED_FIELDS = ['seed', 'noise_seed', 'rand_seed'];

const ASSET_FIELDS = ['image', 'images', 'video', 'audio', 'file', 'mask', 'filename', 'path', 'video_file'];
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.gif',
  '.mp4', '.mov', '.mkv', '.webm', '.avi',
  '.wav', '.mp3', '.flac', '.ogg', '.m4a',
]);

// Seeds stay inside the exact-integer range so a round trip through JSON never drifts.
const MAX_SEED = Number.MAX_SAFE_INTEGER;

export class Workflow {
  constructor(data, source = null) {
    this.data = data;
    this.source = source;
  }

  static parse(data, source = null) {
    if (data && typeof data === 'object' && data.prompt && typeof data.prompt === 'object') {
      data = data.prompt; // some tools wrap the API payload
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new WorkflowError('expected a JSON object at the top level');
    }
    if (data.nodes && data.links) {
      throw new WorkflowError(
        'This is a UI workflow, not an API workflow. In ComfyUI use Workflow -> Export (API) ' +
          'and select that file instead.',
      );
    }
    for (const [nodeId, node] of Object.entries(data)) {
      if (!node || typeof node !== 'object' || !node.class_type || !node.inputs) {
        throw new WorkflowError(
          `node "${nodeId}" is not in API format (expected "class_type" and "inputs"). ` +
            'Re-export with Workflow -> Export (API).',
        );
      }
    }
    return new Workflow(data, source);
  }

  static load(file) {
    if (!fs.existsSync(file)) throw new WorkflowError(`workflow not found: ${file}`);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new WorkflowError(`${path.basename(file)} is not valid JSON: ${err.message}`);
    }
    return Workflow.parse(parsed, file);
  }

  clone() {
    return new Workflow(structuredClone(this.data), this.source);
  }

  nodes() {
    return Object.entries(this.data);
  }

  classTypes() {
    return new Set(this.nodes().map(([, node]) => String(node.class_type)));
  }

  static titleOf(node) {
    return String(node?._meta?.title || node?.class_type || '');
  }

  /** [{nodeId, field}] for every literal seed widget. */
  seedNodes() {
    const found = [];
    for (const [nodeId, node] of this.nodes()) {
      for (const [field, value] of Object.entries(node.inputs || {})) {
        if (SEED_FIELDS.includes(field) && typeof value === 'number') found.push({ nodeId, field });
      }
    }
    return found;
  }

  /** [{nodeId, field, value}] for widget values that look like input files. */
  assetRefs() {
    const found = [];
    for (const [nodeId, node] of this.nodes()) {
      for (const [field, value] of Object.entries(node.inputs || {})) {
        if (typeof value !== 'string' || !value) continue;
        const ext = path.extname(value).toLowerCase();
        const looksLikeAsset = ASSET_FIELDS.includes(field) || field.includes('image') || field.includes('video');
        if (ASSET_EXTENSIONS.has(ext) && looksLikeAsset) found.push({ nodeId, field, value });
      }
    }
    return found;
  }

  /** [{nodeId, classType, field, value}] for every string widget - used for model checks. */
  widgetValues() {
    const found = [];
    for (const [nodeId, node] of this.nodes()) {
      for (const [field, value] of Object.entries(node.inputs || {})) {
        if (typeof value === 'string') found.push({ nodeId, classType: String(node.class_type), field, value });
      }
    }
    return found;
  }

  /** A flat description of the graph for the browser's node inspector. */
  outline() {
    return this.nodes()
      .map(([nodeId, node]) => ({
        id: nodeId,
        title: Workflow.titleOf(node),
        classType: String(node.class_type),
        widgets: Object.entries(node.inputs || {})
          .filter(([, value]) => !Array.isArray(value)) // arrays are wires to other nodes
          .map(([field, value]) => ({ field, value })),
      }))
      .sort((a, b) => {
        const na = Number(a.id);
        const nb = Number(b.id);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return String(a.id).localeCompare(String(b.id));
      });
  }

  /* -------------------------------------------------------- patching */

  matchNodes(override) {
    return this.nodes().filter(([nodeId, node]) => {
      if (override.node) return nodeId === String(override.node);
      if (override.title) return Workflow.titleOf(node) === override.title;
      if (override.class) return node.class_type === override.class;
      return false;
    });
  }

  /** Mutates in place. Returns human-readable descriptions of what changed. */
  applyOverrides(overrides) {
    const applied = [];
    for (const override of overrides || []) {
      const targets = this.matchNodes(override);
      const label = override.node || override.title || override.class;
      if (!targets.length) throw new WorkflowError(`override ${label}.${override.field} matched no node`);
      for (const [nodeId, node] of targets) {
        const inputs = node.inputs || (node.inputs = {});
        if (!(override.field in inputs)) {
          throw new WorkflowError(
            `override ${label}.${override.field}: node ${nodeId} (${node.class_type}) has no input ` +
              `"${override.field}". Available: ${Object.keys(inputs).sort().join(', ')}`,
          );
        }
        if (Array.isArray(inputs[override.field])) {
          throw new WorkflowError(
            `override ${label}.${override.field}: node ${nodeId}.${override.field} is wired to another ` +
              'node, not a literal widget - it cannot be overridden.',
          );
        }
        inputs[override.field] = override.value;
        const preview = String(override.value);
        applied.push(`${nodeId}.${override.field} = ${preview.length > 60 ? `${preview.slice(0, 57)}...` : preview}`);
      }
    }
    return applied;
  }

  /** Set every literal seed widget. Returns how many were patched. */
  setSeed(seed) {
    let count = 0;
    for (const { nodeId, field } of this.seedNodes()) {
      this.data[nodeId].inputs[field] = Number(seed) % (MAX_SEED + 1);
      count += 1;
    }
    return count;
  }

  /** Point asset widgets at the names the remote machine returned after upload. */
  rewriteAssetNames(mapping) {
    for (const { nodeId, field, value } of this.assetRefs()) {
      const mapped = mapping[value] ?? mapping[path.basename(value)];
      if (mapped && mapped !== value) this.data[nodeId].inputs[field] = mapped;
    }
  }
}

export function randomSeed() {
  return Math.floor(Math.random() * MAX_SEED);
}

export { MAX_SEED };
