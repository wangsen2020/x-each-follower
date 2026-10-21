import {APP_VERSION, BACKGROUND_RELOAD_KEY} from '../../src/shared/version.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('extension, package, background and panel handshake use one version', () => {
  const manifest = JSON.parse(read('src/manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const background = read('src/entries/background/background.js');
  const panel = read('src/entries/panel/panel.js');
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(APP_VERSION, manifest.version);
  assert.equal(BACKGROUND_RELOAD_KEY, `x_bg_reloaded_${manifest.version}`);
  assert.match(panel, /sessionStorage\.getItem\(BACKGROUND_RELOAD_KEY\)/);
  assert.match(panel, /sessionStorage\.setItem\(BACKGROUND_RELOAD_KEY, '1'\)/);
  assert.match(background, /BACKGROUND_BUILD_VERSION = APP_VERSION/);
  assert.match(panel, /expectedVersion = APP_VERSION/);
});
