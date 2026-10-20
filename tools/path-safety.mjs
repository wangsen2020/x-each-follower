import { existsSync, lstatSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const WORKSPACE_ROOT = resolve(__dirname, '..');
export const DEFAULT_DIST_DIR = resolve(WORKSPACE_ROOT, 'dist');
export const BUILD_TESTS_DIR = resolve(WORKSPACE_ROOT, 'scratch', 'build-tests');

/**
 * Checks whether a given path or any of its existing ancestor directories
 * is a symbolic link or junction / reparse point.
 */
export function assertNoReparsePoint(targetPath) {
  const resolved = resolve(targetPath);
  let current = resolved;
  while (current) {
    // lstat also detects dangling links, whereas existsSync follows their target.
    const stat = lstatSync(current, {throwIfNoEntry: false});
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw new Error(`Security violation: reparse point / symlink detected at: ${current}`);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Validates that an output directory is strictly inside the workspace,
 * is not the workspace root, is not an arbitrary source directory,
 * does not involve symlinks/junctions, and is restricted strictly to:
 * 1) repo/dist
 * 2) a task-owned subdirectory under repo/scratch/build-tests
 */
export function validateOutputDir(targetDir, rootDir = WORKSPACE_ROOT) {
  if (!targetDir || typeof targetDir !== 'string') {
    throw new Error('Security violation: output directory path must be a non-empty string');
  }

  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(targetDir);

  // 1. Inspect containment in workspace
  const relToRoot = relative(resolvedRoot, resolvedTarget);
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
    throw new Error(`Security violation: output directory "${targetDir}" is outside workspace root "${resolvedRoot}"`);
  }

  // 2. Reject workspace root itself
  if (relToRoot === '' || resolvedTarget === resolvedRoot) {
    throw new Error('Security violation: output directory cannot be workspace root');
  }

  // 3. Inspect reparse points / symlinks along path
  assertNoReparsePoint(resolvedTarget);

  // 4. Allowed roots check: repo/dist OR task-owned subdir under repo/scratch/build-tests
  const allowedDist = resolve(resolvedRoot, 'dist');
  const allowedBuildTests = resolve(resolvedRoot, 'scratch', 'build-tests');

  const isDist = resolvedTarget.toLowerCase() === allowedDist.toLowerCase();

  const relToBuildTests = relative(allowedBuildTests, resolvedTarget);
  const isInsideBuildTests =
    !relToBuildTests.startsWith('..') &&
    !isAbsolute(relToBuildTests) &&
    relToBuildTests !== '';

  if (!isDist && !isInsideBuildTests) {
    throw new Error(
      `Security violation: output directory "${targetDir}" is rejected. Only repo/dist or subdirectories under repo/scratch/build-tests are permitted.`
    );
  }

  return resolvedTarget;
}

/**
 * Safely cleans an allowed output directory prior to building.
 * Verifies containment and reparse points before any removal.
 */
export function cleanOutputDir(targetDir, rootDir = WORKSPACE_ROOT) {
  const resolved = validateOutputDir(targetDir, rootDir);
  assertNoReparsePoint(resolved);

  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Security violation: target output directory is a symlink: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
  }

  mkdirSync(resolved, { recursive: true });
  return resolved;
}
