/**
 * Shared helpers for turning a job into files on disk.
 * The dispatching itself lives in fleet.js, which owns the per-machine workers.
 */

import fs from 'node:fs';
import path from 'node:path';

// Characters Windows and SMB shares refuse inside a path segment.
const ILLEGAL_IN_PATH = /[<>:"/\\|?*]+/g;

/** Make a string usable as a folder name: for run ids and job names. */
export function safeName(text, fallback = "job") {
  const cleaned = String(text || "")
    .replace(ILLEGAL_IN_PATH, "_")
    .replace(/\s+/g, "_")
    .replace(/^[_. ]+|[_. ]+$/g, "");
  return cleaned.slice(0, 60) || fallback;
}

/**
 * Sanitise one segment of a collect path. Unlike safeName this keeps spaces and
 * hyphens, so a file ComfyUI named "my render 001.png" arrives under that name.
 */
export function safePathPart(text, fallback = "part") {
  const cleaned = String(text || "")
    .replace(ILLEGAL_IN_PATH, "_")
    .replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || fallback;
}

/** Every concrete file a workflow entry wants uploaded to the machines' input/ folders. */
export function assetFiles(entry) {
  const files = [];
  for (const target of entry.assets || []) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const walk = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, item.name);
          if (item.isDirectory()) walk(full);
          else if (item.isFile()) files.push(full);
        }
      };
      walk(target);
    } else if (stat.isFile()) {
      files.push(target);
    }
  }
  return files;
}

export function assetNames(entry) {
  return new Set(assetFiles(entry).map((p) => path.basename(p)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function writeManifest(manifest, destRoot, runId) {
  try {
    const dir = path.join(destRoot, runId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'run.json');
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}
