import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuild } from '../../tools/build.mjs';
import { verifyDist } from '../../tools/verify-dist.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');
const TEST_DIST_DIR = resolve(ROOT_DIR, 'scratch', 'build-tests', 'fresh-dist-artifact');

// Always build fresh artifacts in build tests (zero stale dist reuse)
test.before(async () => {
  await runBuild({ rootDir: ROOT_DIR, distDir: TEST_DIST_DIR });
});

test('manifest referenced resources and byte equality are verified in fresh build', () => {
  const manifestPath = join(TEST_DIST_DIR, 'manifest.json');
  assert.ok(existsSync(manifestPath), 'manifest.json must exist in dist');

  const rootManifestPath = join(ROOT_DIR, 'manifest.json');
  const rootBuf = readFileSync(rootManifestPath);
  const distBuf = readFileSync(manifestPath);
  assert.equal(Buffer.compare(rootBuf, distBuf), 0, 'dist/manifest.json must match root manifest.json byte-for-byte');

  const manifest = JSON.parse(distBuf.toString('utf8'));
  assert.equal(manifest.manifest_version, 3);

  // Background service worker
  const sw = manifest.background?.service_worker;
  assert.ok(sw, 'background.service_worker must be specified');
  assert.ok(existsSync(join(TEST_DIST_DIR, sw)), `background worker ${sw} must exist in dist`);

  // Icons
  assert.ok(manifest.icons, 'icons must be specified in manifest');
  for (const [size, file] of Object.entries(manifest.icons)) {
    assert.ok(existsSync(join(TEST_DIST_DIR, file)), `icon ${size} (${file}) must exist in dist`);
  }

  // Content scripts
  assert.ok(Array.isArray(manifest.content_scripts), 'content_scripts must be an array');
  for (const cs of manifest.content_scripts) {
    if (cs.js) {
      for (const jsFile of cs.js) {
        assert.ok(existsSync(join(TEST_DIST_DIR, jsFile)), `content script js "${jsFile}" must exist in dist`);
      }
    }
    if (cs.css) {
      for (const cssFile of cs.css) {
        assert.ok(existsSync(join(TEST_DIST_DIR, cssFile)), `content script css "${cssFile}" must exist in dist`);
      }
    }
  }
});

test('dynamic transaction-id.bundle.js is preserved byte-for-byte and references valid', () => {
  const bundlePath = join(TEST_DIST_DIR, 'transaction-id.bundle.js');
  assert.ok(existsSync(bundlePath), 'transaction-id.bundle.js must exist in dist');

  const srcBundle = readFileSync(join(ROOT_DIR, 'transaction-id.bundle.js'));
  const distBundle = readFileSync(bundlePath);
  assert.equal(Buffer.compare(srcBundle, distBundle), 0, 'transaction-id.bundle.js must match source byte-for-byte');

  const stat = statSync(bundlePath);
  assert.ok(stat.size > 5000, `transaction-id.bundle.js size must be valid (got ${stat.size} bytes)`);

  const netPath = join(TEST_DIST_DIR, 'network-api.js');
  assert.ok(existsSync(netPath), 'network-api.js must exist in dist');
  const netSource = readFileSync(netPath, 'utf8');
  assert.match(netSource, /files:\s*\[['"]transaction-id\.bundle\.js['"]\]/);
});

test('runtime injection functions in page-reader.js and persistent-db.js are byte-identical to source', () => {
  for (const file of ['page-reader.js', 'persistent-db.js', 'panel-data.js', 'relationship-rules.js']) {
    const srcBuf = readFileSync(join(ROOT_DIR, file));
    const distBuf = readFileSync(join(TEST_DIST_DIR, file));
    assert.equal(Buffer.compare(srcBuf, distBuf), 0, `${file} must be byte-for-byte identical to source`);
  }
});

test('verification-alert page and its resources are completely preserved', () => {
  const htmlPath = join(TEST_DIST_DIR, 'verification-alert.html');
  const jsPath = join(TEST_DIST_DIR, 'verification-alert.js');
  const cssPath = join(TEST_DIST_DIR, 'verification-alert.css');
  const webpPath = join(TEST_DIST_DIR, 'verification-help-generated.webp');
  const iconPath = join(TEST_DIST_DIR, 'icon128.png');

  assert.ok(existsSync(htmlPath), 'verification-alert.html must exist in dist');
  assert.ok(existsSync(jsPath), 'verification-alert.js must exist in dist');
  assert.ok(existsSync(cssPath), 'verification-alert.css must exist in dist');
  assert.ok(existsSync(webpPath), 'verification-help-generated.webp must exist in dist');
  assert.ok(existsSync(iconPath), 'icon128.png must exist in dist');

  const html = readFileSync(htmlPath, 'utf8');
  assert.match(html, /href=["']verification-alert\.css["']/);
  assert.match(html, /src=["']verification-alert\.js["']/);
  assert.match(html, /src=["']verification-help-generated\.webp["']/);
});

test('panel.html references externalized panel.js entry and valid hashed CSS', () => {
  const panelHtmlPath = join(TEST_DIST_DIR, 'panel.html');
  assert.ok(existsSync(panelHtmlPath));

  const html = readFileSync(panelHtmlPath, 'utf8');
  assert.match(html, /<script\s+type=["']module["'][^>]*src=["'](?:(?:\.\/)?panel\.js)["']/);

  const hasCss =
    /<link[^>]+rel=["']stylesheet["'][^>]+href=["'](?:\.\/)?assets\/panel-[^"']+\.css["']/i.test(html) ||
    /<link[^>]+rel=["']stylesheet["'][^>]+href=["'](?:\.\/)?panel\.css["']/i.test(html);
  assert.ok(hasCss, 'panel.html must link to a valid stylesheet');
});

test('never copies forbidden items into dist', () => {
  const forbidden = [
    'node_modules',
    'tests',
    'tools',
    'docs',
    '.git',
    '.gitignore',
    'package.json',
    'package-lock.json',
    'vite.config.js',
    'README.md',
    'AGENTS.md'
  ];

  for (const name of forbidden) {
    const checkPath = join(TEST_DIST_DIR, name);
    assert.equal(existsSync(checkPath), false, `Forbidden item "${name}" must NOT exist in dist`);
  }
});

test('verifyDist validator passes cleanly on fresh build', async () => {
  const res = await verifyDist(TEST_DIST_DIR, { rootDir: ROOT_DIR });
  assert.equal(res.ok, true, `verifyDist should pass cleanly, errors: ${res.errors.join('; ')}`);
  assert.equal(res.checks.forbiddenArtifactsAbsent, true);
  assert.equal(res.checks.manifest, true);
  assert.equal(res.checks.manifestEquality, true);
  assert.equal(res.checks.runtimeJsByteFidelity, true);
  assert.equal(res.checks.htmlAndCssResources, true);
  assert.equal(res.checks.esmImportsValid, true);
  assert.equal(res.checks.noDevClients, true);
  assert.equal(res.checks.transactionIdDynamicInjection, true);
  assert.equal(res.checks.verificationAlert, true);
  assert.equal(res.checks.panelHtmlIntegrity, true);
});
