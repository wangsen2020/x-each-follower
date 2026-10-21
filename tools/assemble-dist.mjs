import {RUNTIME_RESOURCES} from './runtime-resources.mjs';
import { readdirSync, copyFileSync, existsSync, mkdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOutputDir, assertNoReparsePoint, WORKSPACE_ROOT, DEFAULT_DIST_DIR } from './path-safety.mjs';

const FORBIDDEN_DIRS = new Set([
  'node_modules',
  'tests',
  'tools',
  'docs',
  '.git',
  '.idea',
  'scratch',
  'artifacts'
]);

const FORBIDDEN_FILES = new Set([
  'package.json',
  'package-lock.json',
  'vite.config.js',
  '.gitignore',
  'README.md',
  'AGENTS.md'
]);

/**
 * Standalone resources that must remain separate files in dist:
 * - manifest.json (Chrome extension configuration)
 * - bridge.js (ISOLATED world content script)
 * - tweet-comment-button.js & .css (ISOLATED world comment trigger)
 * - net-hook.js & transaction-id.bundle.js (MAIN world content scripts)
 * - page-reader.js (Target of dynamic script injection)
 * - verification-alert.* (Standalone verification reminder extension page)
 * - verification-alert-window.js (Helper module for verification alert positioning)
 * - icons and graphics
 *
 * All other business logic modules (panel.js, scoring.js, record-*.js,
 * follow-queue-*.js, grok-*.js, etc.) are compiled and bundled by Vite
 * into dist/background.js and dist/assets/.
 */
const STANDALONE_COPY_FILES = Object.keys(RUNTIME_RESOURCES);

/**
 * Assembles standalone resources into dist/.
 * Rejects symlink sources and destinations.
 * Forbidden artifact detection throws without deleting unexpected paths.
 */
export async function assembleDist(options = {}) {
  const rootDir = resolve(options.rootDir || WORKSPACE_ROOT);
  const distDir = resolve(options.distDir || DEFAULT_DIST_DIR);

  // Validate output directory before any operations
  const validatedDist = validateOutputDir(distDir, rootDir);

  if (!existsSync(validatedDist)) {
    mkdirSync(validatedDist, { recursive: true });
  }

  // Safety check on destination directory
  assertNoReparsePoint(validatedDist);

  // Verify destination does not contain any forbidden item
  for (const name of readdirSync(validatedDist)) {
    if (FORBIDDEN_DIRS.has(name) || FORBIDDEN_FILES.has(name)) {
      throw new Error(`Security violation: forbidden item "${name}" was found in dist`);
    }
  }

  let assembledCount = 0;

  for (const name of STANDALONE_COPY_FILES) {
    const srcPath = join(rootDir, RUNTIME_RESOURCES[name]);
    if (!existsSync(srcPath)) throw new Error('Missing runtime source: '+srcPath);

    assertNoReparsePoint(srcPath);

    const destPath = join(validatedDist, name);
    if (existsSync(destPath)) {
      assertNoReparsePoint(destPath);
    }

    copyFileSync(srcPath, destPath);
    assembledCount++;
  }

  return { copiedCount: assembledCount, assembledCount, distDir: validatedDist };
}

// CLI direct execution
const isDirectCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectCli) {
  try {
    const result = await assembleDist();
    console.log(`[assemble-dist] Successfully assembled ${result.assembledCount} standalone items into ${result.distDir}`);
  } catch (err) {
    console.error(`[assemble-dist] Assembly failed: ${err.message}`);
    process.exit(1);
  }
}
