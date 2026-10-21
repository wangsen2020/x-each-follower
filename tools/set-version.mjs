import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const version = process.argv[2];
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '') || version.split('.').some(v => Number(v) > 65535)) {
  throw new Error('Usage: npm run version:set -- MAJOR.MINOR.PATCH (each component <= 65535)');
}
const root = new URL('../', import.meta.url);
// Read all metadata before making changes. Application code imports src/shared/version.js.
const names = ['src/manifest.json', 'package.json', 'package-lock.json'];
const data = await Promise.all(names.map(async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))));
for (const value of data) value.version = version;
data[2].packages[''].version = version;
for (let i=0; i<names.length; i++) await writeFile(new URL(names[i], root), JSON.stringify(data[i], null, 2)+'\n');
console.log(`Version synchronized to ${version} in ${fileURLToPath(root)}`);
