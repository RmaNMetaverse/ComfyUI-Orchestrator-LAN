/**
 * Native file and folder dialogs.
 *
 * The web interface runs on the same machine as the server, so picking files means
 * opening the real Explorer dialog rather than a web imitation of one. Windows uses
 * a small PowerShell helper, macOS uses osascript, Linux uses zenity or kdialog.
 * When none of those is available the caller falls back to typing a path.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { APP_ROOT } from './paths.js';

const run = promisify(execFile);

const FILTERS = {
  workflow: { windows: 'ComfyUI workflow (*.json)|*.json|All files (*.*)|*.*', mac: 'json', patterns: ['*.json'] },
  media: {
    windows:
      'Media (*.png;*.jpg;*.jpeg;*.webp;*.mp4;*.mov;*.mkv;*.webm;*.wav;*.mp3)|' +
      '*.png;*.jpg;*.jpeg;*.webp;*.mp4;*.mov;*.mkv;*.webm;*.wav;*.mp3|All files (*.*)|*.*',
    mac: 'png,jpg,jpeg,webp,mp4,mov,mkv,webm,wav,mp3',
    patterns: ['*.png', '*.jpg', '*.jpeg', '*.webp', '*.mp4', '*.mov', '*.mkv', '*.webm', '*.wav', '*.mp3'],
  },
  any: { windows: 'All files (*.*)|*.*', mac: '', patterns: [] },
};

export class PickerUnavailable extends Error {}

/**
 * @param kind 'file' | 'files' | 'folder'
 * @returns string[] - empty when the dialog was cancelled
 */
export async function pick({ kind = 'file', filter = 'any', initial = '', title = 'Select' } = {}) {
  const spec = FILTERS[filter] || FILTERS.any;
  if (process.platform === 'win32') return pickWindows({ kind, spec, initial, title });
  if (process.platform === 'darwin') return pickMac({ kind, spec, initial, title });
  return pickLinux({ kind, spec, initial, title });
}

function splitLines(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function pickWindows({ kind, spec, initial, title }) {
  const script = path.join(APP_ROOT, 'tools', 'pick.ps1');
  const args = [
    '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Kind', kind,
    '-Filter', spec.windows,
    '-Title', title,
  ];
  if (initial) args.push('-Initial', initial);
  try {
    // No timeout: the person may take as long as they like in the dialog.
    const { stdout } = await run('powershell.exe', args, { windowsHide: false, maxBuffer: 1 << 20 });
    return splitLines(stdout);
  } catch (err) {
    throw new PickerUnavailable(`the Windows file dialog could not be opened: ${err.message}`);
  }
}

async function pickMac({ kind, spec, initial, title }) {
  const target = kind === 'folder' ? 'folder' : 'file';
  const multiple = kind === 'files' ? ' with multiple selections allowed' : '';
  const ofType = target === 'file' && spec.mac ? ` of type {${spec.mac.split(',').map((e) => `"${e}"`).join(', ')}}` : '';
  const location = initial ? ` default location POSIX file ${JSON.stringify(initial)}` : '';
  const script = `set chosen to choose ${target}${ofType} with prompt ${JSON.stringify(title)}${location}${multiple}
set out to ""
if class of chosen is list then
  repeat with item_ in chosen
    set out to out & POSIX path of item_ & linefeed
  end repeat
else
  set out to POSIX path of chosen
end if
return out`;
  try {
    const { stdout } = await run('osascript', ['-e', script], { maxBuffer: 1 << 20 });
    return splitLines(stdout);
  } catch (err) {
    if (/User canceled/i.test(err.stderr || '')) return [];
    throw new PickerUnavailable(`the macOS file dialog could not be opened: ${err.message}`);
  }
}

async function pickLinux({ kind, spec, initial, title }) {
  const args = ['--file-selection', `--title=${title}`];
  if (kind === 'folder') args.push('--directory');
  if (kind === 'files') args.push('--multiple', '--separator=\n');
  if (initial) args.push(`--filename=${initial.endsWith('/') ? initial : `${initial}/`}`);
  for (const pattern of spec.patterns) args.push(`--file-filter=${pattern}`);
  try {
    const { stdout } = await run('zenity', args, { maxBuffer: 1 << 20 });
    return splitLines(stdout);
  } catch (err) {
    if (err.code === 1) return []; // cancelled
    throw new PickerUnavailable(
      'no native file dialog is available on this system (install zenity, or type the path instead)',
    );
  }
}
