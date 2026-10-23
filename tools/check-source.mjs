import {readdirSync} from 'node:fs';
import {resolve, join, relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectBrowserSourceTree} from './check-browser-calls.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceDirs = new Set(['src']);
const files = [];
function collect(dir) {
  for (const item of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      if (sourceDirs.has(item.name) && dir === root || dir !== root) collect(path);
    } else if (item.name.endsWith('.js') && (dir === root || dir.startsWith(join(root, 'src')))) {
      files.push(path);
    }
  }
}
collect(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
  if (result.status !== 0) {
    process.stderr.write(`${relative(root, file)}: ${result.stderr || result.stdout}`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`Syntax checked ${files.length} source modules.`);
const browserCalls = inspectBrowserSourceTree(join(root, 'src'));
if (browserCalls.errors.length) {
  console.error(browserCalls.errors.join('\n'));
  process.exitCode = 1;
} else console.log(`Browser call contracts checked in ${browserCalls.files} JS/Vue files.`);
