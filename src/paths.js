import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// COMFYFLEET_CONFIG points the whole app at a different config folder. The tests use it so
// they can never write over the fleet you actually run.
const CONFIG_DIR = process.env.COMFYFLEET_CONFIG
  ? path.resolve(process.env.COMFYFLEET_CONFIG)
  : path.join(APP_ROOT, 'config');

export const FLEET_PATH = path.join(CONFIG_DIR, 'nodes.json');
export const UI_STATE_PATH = path.join(CONFIG_DIR, 'ui-state.json');
export const WORKFLOW_DIR = path.join(APP_ROOT, 'workflows');
export const JOBS_DIR = path.join(APP_ROOT, 'jobs');
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');
export const DEFAULT_OUTPUT_DIR = path.join(APP_ROOT, 'outputs');
