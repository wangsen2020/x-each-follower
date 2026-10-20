import { readFileSync, existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { resolve, join, extname, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, parse } from 'es-module-lexer';
import { WORKSPACE_ROOT, DEFAULT_DIST_DIR, assertNoReparsePoint } from './path-safety.mjs';

const FORBIDDEN_EXACT = new Set([
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
  'AGENTS.md',
  '.idea',
  'scratch',
  'artifacts',
  '.DS_Store'
]);

const VALID_JS_EXTS = new Set(['.js', '.mjs', '.cjs']);

/**
 * Recursively walks a directory and collects all file paths and directory paths.
 */
function walkDist(dir) {
  const files = [];
  const dirs = [];
  if (!existsSync(dir)) return { files, dirs };

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.push(fullPath);
      const sub = walkDist(fullPath);
      files.push(...sub.files);
      dirs.push(...sub.dirs);
    } else {
      files.push(fullPath);
    }
  }
  return { files, dirs };
}

/**
 * Validates the built dist artifact according to extension MV3 and project constraints.
 *
 * Target can be distDir string or { distDir, rootDir } options object.
 */
export async function verifyDist(target = DEFAULT_DIST_DIR, maybeOptions = {}) {
  await init;

  let distDir;
  let rootDir;
  if (typeof target === 'string') {
    distDir = resolve(target);
    rootDir = resolve(maybeOptions.rootDir || WORKSPACE_ROOT);
  } else if (target && typeof target === 'object') {
    distDir = resolve(target.distDir || DEFAULT_DIST_DIR);
    rootDir = resolve(target.rootDir || WORKSPACE_ROOT);
  } else {
    distDir = DEFAULT_DIST_DIR;
    rootDir = WORKSPACE_ROOT;
  }

  const errors = [];
  const warnings = [];
  const checks = {
    forbiddenArtifactsAbsent: false,
    manifest: false,
    manifestEquality: false,
    runtimeJsByteFidelity: false,
    htmlAndCssResources: false,
    esmImportsValid: false,
    noDevClients: false,
    transactionIdDynamicInjection: false,
    verificationAlert: false,
    panelHtmlIntegrity: false
  };

  if (!existsSync(distDir)) {
    throw new Error(`Dist directory does not exist at: ${distDir}`);
  }
  assertNoReparsePoint(distDir);

  const { files: distFiles, dirs: distDirs } = walkDist(distDir);

  // 1. Check forbidden artifacts recursively (directories and files)
  for (const dirPath of distDirs) {
    const dirName = dirPath.split(/[/\\]/).pop();
    if (FORBIDDEN_EXACT.has(dirName) || dirName.startsWith('.')) {
      errors.push(`Forbidden directory found in dist: ${relative(distDir, dirPath)}`);
    }
  }

  for (const filePath of distFiles) {
    const fileName = filePath.split(/[/\\]/).pop();
    const relFile = relative(distDir, filePath);
    if (FORBIDDEN_EXACT.has(fileName)) {
      errors.push(`Forbidden file found in dist: ${relFile}`);
    } else if (fileName.endsWith('.log') || fileName.endsWith('.zip')) {
      errors.push(`Forbidden file format found in dist: ${relFile}`);
    }

    try {
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) {
        errors.push(`Symlink found in dist: ${relFile}`);
      }
    } catch {}
  }
  checks.forbiddenArtifactsAbsent = !errors.some((e) => e.includes('Forbidden') || e.includes('Symlink'));
  // Do not read through links after identifying an invalid artifact.
  if (errors.some(error => error.includes('Symlink'))) {
    return {ok: false, errors, warnings, checks, stats: {totalFiles: distFiles.length, esmGraphSize: 0}};
  }

  // 2. Validate Manifest referenced resources and byte-for-byte equality with root
  const manifestPath = join(distDir, 'manifest.json');
  const rootManifestPath = join(rootDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    errors.push('manifest.json is missing in dist');
  } else {
    // Check byte-for-byte equality against root manifest.json
    if (existsSync(rootManifestPath)) {
      const srcManifestBuf = readFileSync(rootManifestPath);
      const distManifestBuf = readFileSync(manifestPath);
      if (Buffer.compare(srcManifestBuf, distManifestBuf) !== 0) {
        errors.push('dist/manifest.json differs byte-for-byte from root manifest.json');
      } else {
        checks.manifestEquality = true;
      }
    } else {
      errors.push(`Root manifest.json not found at: ${rootManifestPath}`);
    }

    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      errors.push(`manifest.json parse error: ${err.message}`);
    }

    if (manifest) {
      if (manifest.manifest_version !== 3) {
        errors.push(`manifest_version must be 3, found ${manifest.manifest_version}`);
      }

      // Background worker
      if (manifest.background?.service_worker) {
        const swPath = join(distDir, manifest.background.service_worker);
        if (!existsSync(swPath)) {
          errors.push(`Background service worker is missing: ${manifest.background.service_worker}`);
        }
      } else {
        errors.push('manifest.background.service_worker is not defined');
      }

      // Icons
      if (manifest.icons) {
        for (const [size, iconFile] of Object.entries(manifest.icons)) {
          const iconPath = join(distDir, iconFile);
          if (!existsSync(iconPath)) {
            errors.push(`Manifest icon (${size}) is missing: ${iconFile}`);
          }
        }
      }

      // Content Scripts
      if (Array.isArray(manifest.content_scripts)) {
        for (const cs of manifest.content_scripts) {
          if (Array.isArray(cs.js)) {
            for (const jsFile of cs.js) {
              const p = join(distDir, jsFile);
              if (!existsSync(p)) {
                errors.push(`Content script JS missing: ${jsFile}`);
              }
            }
          }
          if (Array.isArray(cs.css)) {
            for (const cssFile of cs.css) {
              const p = join(distDir, cssFile);
              if (!existsSync(p)) {
                errors.push(`Content script CSS missing: ${cssFile}`);
              }
            }
          }
        }
      }
    }
  }
  checks.manifest = !errors.some((e) => e.includes('manifest'));

  // 3. Byte-for-byte fidelity of all copied runtime JS against source
  let jsMismatchFound = false;
  const rootEntries = readdirSync(rootDir, { withFileTypes: true });
  for (const ent of rootEntries) {
    if (!ent.isDirectory() && ent.name.endsWith('.js') && !FORBIDDEN_EXACT.has(ent.name)) {
      const srcPath = join(rootDir, ent.name);
      const distPath = join(distDir, ent.name);
      if (!existsSync(distPath)) {
        errors.push(`Required runtime JS "${ent.name}" is missing in dist`);
        jsMismatchFound = true;
      } else {
        const srcBuf = readFileSync(srcPath);
        const distBuf = readFileSync(distPath);
        if (Buffer.compare(srcBuf, distBuf) !== 0) {
          errors.push(`Runtime JS byte-for-byte mismatch: dist/${ent.name} does not match source ${ent.name}`);
          jsMismatchFound = true;
        }
      }
    }
  }
  checks.runtimeJsByteFidelity = !jsMismatchFound;

  // 4. Validate HTML src/href resource existence
  for (const filePath of distFiles) {
    if (extname(filePath).toLowerCase() === '.html') {
      const htmlContent = readFileSync(filePath, 'utf8');
      const relHtml = relative(distDir, filePath);
      const attrRegex = /(?:src|href)=["']([^"']+)["']/gi;
      let match;
      while ((match = attrRegex.exec(htmlContent)) !== null) {
        const rawRef = match[1].trim();
        if (!rawRef || rawRef.startsWith('#') || rawRef.startsWith('javascript:')) continue;
        if (/^(?:https?:|data:|blob:|chrome-extension:|mailto:)/i.test(rawRef)) continue;

        if (rawRef.startsWith('/') || /^[a-zA-Z]:/.test(rawRef)) {
          errors.push(`Actionable error: HTML "${relHtml}" references absolute path "${rawRef}". Only relative paths are permitted in extension.`);
          continue;
        }

        const cleanRef = rawRef.split(/[?#]/)[0];
        if (!cleanRef) continue;

        const targetPath = resolve(dirname(filePath), cleanRef);
        const relToDist = relative(distDir, targetPath);

        if (relToDist.startsWith('..') || isAbsolute(relToDist)) {
          errors.push(`Actionable error: HTML "${relHtml}" references path outside dist: "${rawRef}"`);
        } else if (!existsSync(targetPath)) {
          errors.push(`Actionable error: HTML "${relHtml}" references missing resource "${rawRef}" (resolved to: ${relToDist})`);
        }
      }
    }
  }

  // 5. Validate CSS url(...) resource existence
  for (const filePath of distFiles) {
    if (extname(filePath).toLowerCase() === '.css') {
      const cssContent = readFileSync(filePath, 'utf8');
      const relCss = relative(distDir, filePath);
      const urlRegex = /url\(\s*(?:['"]?)([^'")]+)(?:['"]?)\s*\)/gi;
      let match;
      while ((match = urlRegex.exec(cssContent)) !== null) {
        const rawUrl = match[1].trim();
        if (!rawUrl || rawUrl.startsWith('#')) continue;
        if (/^(?:https?:|data:|blob:|chrome-extension:)/i.test(rawUrl)) continue;

        if (rawUrl.startsWith('/') || /^[a-zA-Z]:/.test(rawUrl)) {
          errors.push(`Actionable error: CSS "${relCss}" references absolute URL "${rawUrl}". Only relative URLs are permitted.`);
          continue;
        }

        const cleanUrl = rawUrl.split(/[?#]/)[0];
        if (!cleanUrl) continue;

        const targetPath = resolve(dirname(filePath), cleanUrl);
        const relToDist = relative(distDir, targetPath);

        if (relToDist.startsWith('..') || isAbsolute(relToDist)) {
          errors.push(`Actionable error: CSS "${relCss}" references path outside dist: "${rawUrl}"`);
        } else if (!existsSync(targetPath)) {
          errors.push(`Actionable error: CSS "${relCss}" references missing resource "${rawUrl}" (resolved to: ${relToDist})`);
        }
      }
    }
  }
  checks.htmlAndCssResources = !errors.some((e) => e.includes('HTML') || e.includes('CSS'));

  // 6. ESM Imports validation with es-module-lexer
  let esmErrorsFound = false;
  let esmCount = 0;

  for (const filePath of distFiles) {
    const ext = extname(filePath).toLowerCase();
    if (VALID_JS_EXTS.has(ext)) {
      esmCount++;
      const source = readFileSync(filePath, 'utf8');
      const relJs = relative(distDir, filePath);

      let imports;
      try {
        [imports] = parse(source);
      } catch (parseErr) {
        errors.push(`Actionable error: ESM lexer parse failure in "${relJs}": ${parseErr.message}`);
        esmErrorsFound = true;
        continue;
      }

      for (const imp of imports) {
        const specifier = imp.specifier ?? imp.n;

        if (imp.type === 'dynamic' && specifier === undefined) {
          errors.push(`Actionable error: dynamic non-literal import in "${relJs}" at character ${imp.start} cannot be verified.`);
          esmErrorsFound = true;
          continue;
        }

        if (!specifier) continue;

        // Reject absolute imports
        if (specifier.startsWith('/') || /^[a-zA-Z]:/.test(specifier)) {
          errors.push(`Actionable error: absolute import "${specifier}" in "${relJs}" is forbidden. Use relative imports.`);
          esmErrorsFound = true;
          continue;
        }

        // Reject bare imports
        if (!specifier.startsWith('.')) {
          errors.push(`Actionable error: unresolved bare import "${specifier}" in "${relJs}". Runtime modules must use relative local imports.`);
          esmErrorsFound = true;
          continue;
        }

        // Check traversal
        const resolvedPath = resolve(dirname(filePath), specifier);
        const relToDist = relative(distDir, resolvedPath);

        if (relToDist.startsWith('..') || isAbsolute(relToDist)) {
          errors.push(`Actionable error: import "${specifier}" in "${relJs}" traverses outside dist directory.`);
          esmErrorsFound = true;
          continue;
        }

        // Check existence and recognized JS extensions
        if (!existsSync(resolvedPath)) {
          let hint = '';
          for (const testExt of VALID_JS_EXTS) {
            if (existsSync(resolvedPath + testExt)) {
              hint = ` (Missing extension? Did you mean "${specifier}${testExt}"? Explicit file extension is required for browser ESM)`;
              break;
            }
          }
          errors.push(`Actionable error: unresolved ESM import "${specifier}" in "${relJs}". Target does not exist at "${relToDist}"${hint}.`);
          esmErrorsFound = true;
          continue;
        }

        const resolvedExt = extname(resolvedPath).toLowerCase();
        if (!VALID_JS_EXTS.has(resolvedExt)) {
          errors.push(`Actionable error: import "${specifier}" in "${relJs}" resolves to "${relToDist}" with unrecognized JS extension "${resolvedExt}". Expected .js, .mjs, or .cjs.`);
          esmErrorsFound = true;
        }
      }
    }
  }
  checks.esmImportsValid = !esmErrorsFound;

  // 7. No development clients, HMR, or loopback bridges
  const devClientPatterns = [
    { pattern: /@vite\/client/, label: '@vite/client' },
    { pattern: /\/@vite\//, label: '/@vite/' },
    { pattern: /\x00vite\//, label: 'internal vite module' },
    { pattern: /createHotContext/, label: 'Vite HMR createHotContext' },
    { pattern: /import\.meta\.hot/, label: 'import.meta.hot' },
    { pattern: /pollGrokDevBridge/, label: 'pollGrokDevBridge' },
    { pattern: /https?:\/\/(?:localhost|127\.0\.0\.1)/, label: 'localhost/127.0.0.1 bridge' },
    { pattern: /ws:\/\/(?:localhost|127\.0\.0\.1)/, label: 'websocket loopback' }
  ];

  for (const file of distFiles) {
    const ext = extname(file).toLowerCase();
    if (ext === '.js' || ext === '.html' || ext === '.css' || ext === '.json') {
      const content = readFileSync(file, 'utf8');
      for (const { pattern, label } of devClientPatterns) {
        if (pattern.test(content)) {
          errors.push(`Development client pattern "${label}" detected in dist file: ${relative(distDir, file)}`);
        }
      }
    }
  }
  checks.noDevClients = !errors.some((e) => e.includes('Development client'));

  // 8. Dynamic transaction-id.bundle.js injection check
  const txBundlePath = join(distDir, 'transaction-id.bundle.js');
  if (!existsSync(txBundlePath)) {
    errors.push('transaction-id.bundle.js is missing from dist');
  } else {
    const stat = statSync(txBundlePath);
    if (stat.size < 1000) {
      errors.push(`transaction-id.bundle.js appears truncated (size: ${stat.size} bytes)`);
    }
  }

  const networkApiPath = join(distDir, 'network-api.js');
  if (existsSync(networkApiPath)) {
    const netSource = readFileSync(networkApiPath, 'utf8');
    if (!netSource.includes('transaction-id.bundle.js')) {
      warnings.push('network-api.js does not contain expected transaction-id.bundle.js reference');
    }
  } else {
    errors.push('network-api.js is missing from dist');
  }
  checks.transactionIdDynamicInjection = !errors.some((e) => e.includes('transaction-id.bundle.js'));

  // 9. Verification Alert resources
  const alertHtmlPath = join(distDir, 'verification-alert.html');
  const alertJsPath = join(distDir, 'verification-alert.js');
  const alertCssPath = join(distDir, 'verification-alert.css');
  const alertWebpPath = join(distDir, 'verification-help-generated.webp');

  if (!existsSync(alertHtmlPath)) errors.push('verification-alert.html missing in dist');
  if (!existsSync(alertJsPath)) errors.push('verification-alert.js missing in dist');
  if (!existsSync(alertCssPath)) errors.push('verification-alert.css missing in dist');
  if (!existsSync(alertWebpPath)) errors.push('verification-help-generated.webp missing in dist');

  if (existsSync(alertHtmlPath)) {
    const alertHtml = readFileSync(alertHtmlPath, 'utf8');
    if (!alertHtml.includes('verification-alert.js')) {
      errors.push('verification-alert.html does not reference verification-alert.js');
    }
    if (!alertHtml.includes('verification-alert.css')) {
      errors.push('verification-alert.html does not reference verification-alert.css');
    }
  }
  checks.verificationAlert = !errors.some((e) => e.includes('verification'));

  // 10. Panel HTML build integrity
  const panelHtmlPath = join(distDir, 'panel.html');
  if (!existsSync(panelHtmlPath)) {
    errors.push('panel.html is missing in dist');
  } else {
    const panelHtml = readFileSync(panelHtmlPath, 'utf8');
    if (!panelHtml.includes('src="panel.js"') && !panelHtml.includes('src="./panel.js"')) {
      errors.push('panel.html does not reference panel.js as entry script');
    }
    const hasCss =
      /<link[^>]+rel=["']stylesheet["'][^>]+href=["'](?:\.\/)?assets\/panel-[^"']+\.css["']/i.test(panelHtml) ||
      /<link[^>]+rel=["']stylesheet["'][^>]+href=["'](?:\.\/)?panel\.css["']/i.test(panelHtml);
    if (!hasCss) {
      errors.push('panel.html is missing a valid stylesheet link');
    }
  }
  checks.panelHtmlIntegrity = !errors.some((e) => e.includes('panel.html'));

  const ok = errors.length === 0;
  return {
    ok,
    errors,
    warnings,
    checks,
    stats: {
      totalFiles: distFiles.length,
      esmGraphSize: esmCount
    }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  verifyDist()
    .then((res) => {
      if (res.ok) {
        console.log(`[verify-dist] Dist validation passed (${res.stats.totalFiles} files, ${res.stats.esmGraphSize} ESM modules checked).`);
        for (const [name, passed] of Object.entries(res.checks)) {
          console.log(`  ✓ ${name}: ${passed}`);
        }
        process.exit(0);
      } else {
        console.error('[verify-dist] Dist validation FAILED:');
        for (const err of res.errors) {
          console.error(`  ✗ ${err}`);
        }
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('[verify-dist] Unexpected error:', err);
      process.exit(1);
    });
}
