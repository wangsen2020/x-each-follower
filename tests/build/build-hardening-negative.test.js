import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../../tools/build.mjs';
import { verifyDist } from '../../tools/verify-dist.mjs';
import { assembleDist } from '../../tools/assemble-dist.mjs';
import { validateOutputDir, cleanOutputDir } from '../../tools/path-safety.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');
const BASE_TEST_DIST = resolve(ROOT_DIR, 'scratch', 'build-tests', 'base-test-dist');

// Build a clean base artifact once for fast cloning in negative tests
test.before(async () => {
  await runBuild({ rootDir: ROOT_DIR, distDir: BASE_TEST_DIST });
});

function createTempDist(name) {
  const target = resolve(ROOT_DIR, 'scratch', 'build-tests', name);
  cleanOutputDir(target, ROOT_DIR);
  cpSync(BASE_TEST_DIST, target, { recursive: true });
  return target;
}

test('verifyDist rejects missing hashed CSS in HTML', async () => {
  const testDir = createTempDist('neg-missing-css');
  const panelHtmlPath = join(testDir, 'panel.html');
  const html = readFileSync(panelHtmlPath, 'utf8');
  // Inject reference to non-existent CSS
  writeFileSync(panelHtmlPath, html.replace('<head>', '<head><link rel="stylesheet" href="assets/panel-missing999.css">'));

  const res = await verifyDist(testDir, { rootDir: ROOT_DIR });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.includes('missing resource') && e.includes('panel-missing999.css')),
    `Expected error about missing CSS, got: ${res.errors.join('; ')}`
  );
});

test('verifyDist rejects Chrome-reserved underscore filenames before extension reload', async () => {
  const testDir = createTempDist('neg-reserved-underscore');
  writeFileSync(join(testDir, '__grok_test__.js'), 'export const temporary = true;\n');
  const res = await verifyDist(testDir, { rootDir: ROOT_DIR });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some(error => error.includes('Forbidden file') && error.includes('__grok_test__.js')));
});

test('verifyDist rejects missing image in HTML', async () => {
  const testDir = createTempDist('neg-missing-img');
  const panelHtmlPath = join(testDir, 'panel.html');
  const html = readFileSync(panelHtmlPath, 'utf8');
  writeFileSync(panelHtmlPath, html.replace('<body>', '<body><img src="missing-image-not-found.png">'));

  const res = await verifyDist(testDir, { rootDir: ROOT_DIR });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.includes('missing resource') && e.includes('missing-image-not-found.png')),
    `Expected error about missing image, got: ${res.errors.join('; ')}`
  );
});

test('verifyDist rejects missing resource in CSS url()', async () => {
  const testDir = createTempDist('neg-missing-css-url');
  const cssPath = join(testDir, 'panel.css');
  writeFileSync(cssPath, '\n.test { background: url("missing-background-art.png"); }', { flag: 'a' });

  const res = await verifyDist(testDir, { rootDir: ROOT_DIR });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.includes('missing resource') && e.includes('missing-background-art.png')),
    `Expected error about missing CSS url resource, got: ${res.errors.join('; ')}`
  );
});

test('verifyDist rejects changed runtime byte content', async () => {
  const testDir = createTempDist('neg-changed-byte');
  const targetFile = join(testDir, 'page-reader.js');
  // Alter 1 byte in copied runtime JS
  writeFileSync(targetFile, '\n// byte tampering', { flag: 'a' });

  const res = await verifyDist(testDir, { rootDir: ROOT_DIR });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.includes('Runtime JS byte-for-byte mismatch') && e.includes('page-reader.js')),
    `Expected byte-for-byte mismatch error, got: ${res.errors.join('; ')}`
  );
});

test('verifyDist rejects bare imports in runtime JS', async () => {
  const testDir = createTempDist('neg-bare-import');
  const targetFile = join(testDir, 'bridge.js');
  writeFileSync(targetFile, "import { something } from 'unresolved-package';\n" + readFileSync(targetFile, 'utf8'));

  const res = await verifyDist(testDir, { rootDir: ROOT_DIR });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.includes('unresolved bare import') && e.includes('unresolved-package')),
    `Expected bare import error, got: ${res.errors.join('; ')}`
  );
});

test('verifyDist rejects absolute imports and directory traversal', async () => {
  const testDir = createTempDist('neg-traversal');
  const targetFile = join(testDir, 'bridge.js');
  writeFileSync(targetFile, "import '/absolute/hack.js';\nimport '../../outside.js';\n" + readFileSync(targetFile, 'utf8'));

  const res = await verifyDist(testDir, { rootDir: ROOT_DIR });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.includes('absolute import')),
    `Expected absolute import error, got: ${res.errors.join('; ')}`
  );
  assert.ok(
    res.errors.some((e) => e.includes('traverses outside dist')),
    `Expected traversal error, got: ${res.errors.join('; ')}`
  );
});

test('runBuild cleans stale output on rebuild', async () => {
  const staleDir = resolve(ROOT_DIR, 'scratch', 'build-tests', 'stale-clean-test');
  cleanOutputDir(staleDir, ROOT_DIR);

  // Seed stale files
  const staleFile = join(staleDir, 'stale-artifact.tmp');
  const staleAssetDir = join(staleDir, 'assets');
  mkdirSync(staleAssetDir, { recursive: true });
  const staleAsset = join(staleAssetDir, 'panel-oldhash1234.css');

  writeFileSync(staleFile, 'old data');
  writeFileSync(staleAsset, 'old css');

  assert.ok(existsSync(staleFile));
  assert.ok(existsSync(staleAsset));

  // Run build into staleDir
  await runBuild({ rootDir: ROOT_DIR, distDir: staleDir });

  // Stale output must be gone
  assert.equal(existsSync(staleFile), false, 'stale-artifact.tmp must be removed by clean before build');
  assert.equal(existsSync(staleAsset), false, 'panel-oldhash1234.css must be removed by clean before build');

  // Fresh artifact must be valid
  assert.ok(existsSync(join(staleDir, 'manifest.json')));
  assert.ok(existsSync(join(staleDir, 'panel.html')));
});

test('output path safety rejects root, outside workspace, and arbitrary source dirs', async () => {
  // Reject root
  assert.throws(() => validateOutputDir(ROOT_DIR, ROOT_DIR), /cannot be workspace root/);

  // Reject outside workspace
  assert.throws(() => validateOutputDir(resolve(ROOT_DIR, '..', 'other-dir'), ROOT_DIR), /outside workspace root/);

  // Reject arbitrary source directories
  assert.throws(() => validateOutputDir(resolve(ROOT_DIR, 'tools'), ROOT_DIR), /is rejected/);
  assert.throws(() => validateOutputDir(resolve(ROOT_DIR, 'tests'), ROOT_DIR), /is rejected/);
  assert.throws(() => validateOutputDir(resolve(ROOT_DIR, 'docs'), ROOT_DIR), /is rejected/);

  // runBuild honors rejection
  await assert.rejects(async () => {
    await runBuild({ rootDir: ROOT_DIR, distDir: resolve(ROOT_DIR, 'tools') });
  }, /Security violation/);
});

test('output path safety rejects symlink and reparse points', () => {
  const targetReal = resolve(ROOT_DIR, 'scratch', 'build-tests', 'junc-target');
  const linkDir = resolve(ROOT_DIR, 'scratch', 'build-tests', 'junc-link');
  cleanOutputDir(targetReal, ROOT_DIR);

  try {
    lstatSync(linkDir);
    unlinkSync(linkDir);
  } catch {}

  try {
    symlinkSync(targetReal, linkDir, 'junction');
    assert.throws(() => validateOutputDir(linkDir, ROOT_DIR), /reparse point \/ symlink detected/);
    assert.throws(() => cleanOutputDir(linkDir, ROOT_DIR), /reparse point \/ symlink detected/);
  } finally {
    try {
      unlinkSync(linkDir);
    } catch {}
  }
});

test('forbidden artifact detection only throws without deleting unexpected paths', async () => {
  const testDir = createTempDist('neg-forbidden-non-delete');
  const forbiddenDir = join(testDir, 'node_modules');
  mkdirSync(forbiddenDir, { recursive: true });
  const sentinelFile = join(forbiddenDir, 'secret.txt');
  writeFileSync(sentinelFile, 'precious-user-data');

  assert.ok(existsSync(sentinelFile));

  // assembleDist must throw
  await assert.rejects(async () => {
    await assembleDist({ rootDir: ROOT_DIR, distDir: testDir });
  }, /Security violation: forbidden item "node_modules" was found in dist/);

  // The unexpected file must NOT have been deleted
  assert.ok(existsSync(sentinelFile), 'Forbidden artifact detection must only throw, never delete unexpected paths');
});

test('dangling junction output is rejected without creating its target', () => {
  const owned = resolve(ROOT_DIR, 'scratch', 'build-tests', 'dangling-link-test');
  cleanOutputDir(owned, ROOT_DIR);
  const missing = join(owned, 'missing');
  const link = join(owned, 'link');
  symlinkSync(missing, link, 'junction');
  try {
    assert.throws(() => validateOutputDir(link, ROOT_DIR), /reparse point/);
    assert.throws(() => cleanOutputDir(link, ROOT_DIR), /reparse point/);
    assert.equal(existsSync(missing), false);
  } finally {
    unlinkSync(link);
  }
});
