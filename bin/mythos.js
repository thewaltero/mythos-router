#!/usr/bin/env node

// Thin shim — delegates to tsx for zero-compile execution
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, '..', 'src', 'cli.ts');

try {
  execFileSync('npx', ['tsx', entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
    shell: true,
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
