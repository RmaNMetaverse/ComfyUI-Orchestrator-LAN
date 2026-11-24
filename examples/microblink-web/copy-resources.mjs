import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'node_modules', '@microblink', 'blinkid', 'dist', 'resources');
const destination = path.join(here, 'public', 'resources');
await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true, force: true });
console.log('Copied BlinkID browser resources to /resources');
