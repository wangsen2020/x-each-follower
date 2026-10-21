import { build } from 'vite';
import { assembleDist } from './assemble-dist.mjs';
import { verifyDist } from './verify-dist.mjs';
import { validateOutputDir, cleanOutputDir, WORKSPACE_ROOT, DEFAULT_DIST_DIR } from './path-safety.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * Executes the complete extension build pipeline:
 * 1. Validates and cleans target output directory safely prior to build.
 * 2. Runs Vite to compile and bundle panel HTML and CSS into distDir.
 * 3. Assembles verbatim runtime ESM graph, manifest, and extension resources.
 * 4. Validates artifact integrity (MV3 manifest, byte-fidelity, ESM imports, resources).
 */
export async function runBuild(options = {}) {
  const rootDir = resolve(options.rootDir || WORKSPACE_ROOT);
  const distDir = resolve(options.distDir || DEFAULT_DIST_DIR);

  // Validate output directory and clean stale output before build
  validateOutputDir(distDir, rootDir);
  cleanOutputDir(distDir, rootDir);

  console.log(`[build] 1/3 Building Panel HTML and CSS via Vite into ${distDir}...`);
  await build({
    configFile: resolve(rootDir, 'vite.config.js'),
    root: resolve(rootDir, 'src'),
    build: {
      outDir: distDir,
      emptyOutDir: false
    }
  });

  console.log('[build] 2/3 Assembling verbatim runtime ESM graph and extension resources...');
  const assembleResult = await assembleDist({ rootDir, distDir });
  console.log(`[build] Assembled ${assembleResult.copiedCount} items into ${distDir}.`);

  console.log('[build] 3/3 Validating extension artifact integrity...');
  const verifyResult = await verifyDist(distDir, { rootDir });
  if (!verifyResult.ok) {
    console.error('[build] Validation errors:');
    for (const err of verifyResult.errors) {
      console.error(`  ✗ ${err}`);
    }
    throw new Error(`Build verification failed with ${verifyResult.errors.length} errors`);
  }

  console.log(`[build] Build successfully completed! (${verifyResult.stats.totalFiles} files in dist, ${verifyResult.stats.esmGraphSize} ESM modules verified).`);
  return { assembleResult, verifyResult };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runBuild()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[build] Build failed:', err.message);
      process.exit(1);
    });
}
