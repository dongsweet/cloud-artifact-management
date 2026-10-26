import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentPage } from '../apps/cam-agent/src/web.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(process.argv[2] ?? resolve(projectRoot, 'agent-web', 'dist'));
const assetRoot = resolve(projectRoot, 'web-shared', 'assets');
const outputAssets = resolve(outputRoot, 'assets');

await mkdir(resolve(outputAssets, 'fonts'), { recursive: true });
await writeFile(resolve(outputRoot, 'index.html'), agentPage(), 'utf8');

for (const file of ['bootstrap.min.css', 'bootstrap-icons.min.css', 'adminlte.min.css']) {
  await copyFile(resolve(assetRoot, file), resolve(outputAssets, file));
}
for (const file of ['bootstrap-icons.woff', 'bootstrap-icons.woff2']) {
  try { await copyFile(resolve(assetRoot, 'fonts', file), resolve(outputAssets, 'fonts', file)); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
for (const file of [
  'layout.css', 'role-display.css', 'role-display.js', 'table-pagination.js',
  'artifact-catalog.js', 'task-table.js', 'audit-events.js', 'aaa-config.js'
]) {
  await copyFile(resolve(projectRoot, 'web-shared', file), resolve(outputAssets, file));
}
