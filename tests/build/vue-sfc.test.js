import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import productionConfig from '../../vite.config.js';
import { cleanOutputDir, WORKSPACE_ROOT } from '../../tools/path-safety.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');
const TEST_DIR = resolve(ROOT_DIR, 'scratch', 'build-tests', 'vue-sfc-compile');
const OUT_DIR = resolve(TEST_DIR, 'dist');

test('actual Vue SFC compiles and bundles normally with @vitejs/plugin-vue', async () => {
  // Deterministic clean setup
  cleanOutputDir(TEST_DIR, ROOT_DIR);

  const vueComponent = `<template>
  <div class="x-badge" :data-id="badgeId">{{ label }}</div>
</template>

<script setup>
import { ref } from 'vue';
const badgeId = ref('xfollower-user-42');
const label = ref('Verified Mutual Follower');
</script>

<style scoped>
.x-badge {
  color: #1da1f2;
  font-size: 14px;
}
</style>
`;

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Vue SFC Test</title></head>
<body><div id="app"></div><script type="module" src="./main.js"></script></body>
</html>`;

  const mainJs = `import { createApp } from 'vue';
import Badge from './Badge.vue';
createApp(Badge).mount('#app');
`;

  writeFileSync(join(TEST_DIR, 'Badge.vue'), vueComponent, 'utf8');
  writeFileSync(join(TEST_DIR, 'index.html'), htmlContent, 'utf8');
  writeFileSync(join(TEST_DIR, 'main.js'), mainJs, 'utf8');

  // Compile via Vite with Vue SFC plugin
  await build({
    ...productionConfig,
    root: TEST_DIR,
    configFile: false,
    base: './',
    build: {
      ...productionConfig.build,
      outDir: OUT_DIR,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        ...productionConfig.build.rollupOptions,
        input: join(TEST_DIR, 'index.html')
      }
    }
  });

  assert.ok(existsSync(join(OUT_DIR, 'index.html')), 'Compiled index.html must exist');

  const assetsDir = join(OUT_DIR, 'assets');
  assert.ok(existsSync(assetsDir), 'assets/ directory must exist in compiled output');

  const assetFiles = readdirSync(assetsDir);
  const jsFile = assetFiles.find((f) => f.endsWith('.js'));
  const cssFile = assetFiles.find((f) => f.endsWith('.css'));

  assert.ok(jsFile, 'Compiled JS bundle must be emitted');
  assert.ok(cssFile, 'Compiled CSS bundle with scoped styles must be emitted');

  const jsContent = readFileSync(join(assetsDir, jsFile), 'utf8');
  assert.match(jsContent, /xfollower-user-42/, 'Compiled JS must contain SFC component template/data');

  const cssContent = readFileSync(join(assetsDir, cssFile), 'utf8');
  assert.match(cssContent, /\.x-badge/, 'Compiled CSS must contain scoped component styles');
});
