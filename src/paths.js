import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FLEET_PATH = path.join(APP_ROOT, 'config', 'nodes.json');
export const UI_STATE_PATH = path.join(APP_ROOT, 'config', 'ui-state.json');
export const WORKFLOW_DIR = path.join(APP_ROOT, 'workflows');
export const JOBS_DIR = path.join(APP_ROOT, 'jobs');
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');
export const DEFAULT_OUTPUT_DIR = path.join(APP_ROOT, 'outputs');
