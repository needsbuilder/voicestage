#!/usr/bin/env node
// "npm start" serves the compiled server and the built UI. Build them first if
// they are missing, so the first "npm start" after a clone just works.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'dist', 'cli.js')) || !existsSync(join(root, 'dist', 'ui', 'index.html'))) {
  console.log('Building Voicestage (first start)...');
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
