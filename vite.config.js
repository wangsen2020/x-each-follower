import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const legacyPlaceholder = '<!-- __LEGACY_PANEL_SCRIPT_PLACEHOLDER__ -->';
const legacyScript = '<script type="module" src="panel.js"></script>';

/**
 * Preserve legacy panel.js entry script in panel.html:
 * 1. Pre-hook: hides panel.js tag from Rollup HTML parser so it is not externalized into bundled chunk.
 * 2. Post-hook: restores panel.js script tag in final emitted dist/panel.html.
 */
function preserveLegacyPanelScript() {
  return [
    {
      name: 'strip-legacy-panel-script',
      enforce: 'pre',
      transformIndexHtml(html) {
        return html.replace(/<script\s+type=["']module["']\s+src=["'](?:\.\/)?panel\.js["']\s*><\/script>/g, legacyPlaceholder);
      }
    },
    {
      name: 'restore-legacy-panel-script',
      enforce: 'post',
      transformIndexHtml(html) {
        if (html.includes(legacyPlaceholder)) {
          return html.replace(legacyPlaceholder, legacyScript);
        }
        return html.replace('</body>', `  ${legacyScript}\n</body>`);
      }
    }
  ];
}

export default defineConfig({
  base: './',
  plugins: [
    ...preserveLegacyPanelScript(),
    vue()
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        panel: resolve(__dirname, 'panel.html')
      }
    }
  }
});
