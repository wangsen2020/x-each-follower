import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const panelPath = resolve(__dirname, 'panel.js');
const normPanelPath = panelPath.replace(/\\/g, '/').toLowerCase();

export default defineConfig({
  base: './',
  plugins: [
    vue()
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        panel: resolve(__dirname, 'panel.html')
      },
      external: (id) => {
        // Externalize only the legacy panel.js entry (including resolved absolute exact path).
        // Root runtime graph is copied verbatim during the single assembly stage.
        // Future Vue code bundles normally.
        if (id === 'panel.js' || id === './panel.js') return true;
        try {
          const norm = resolve(id).replace(/\\/g, '/').toLowerCase();
          if (norm === normPanelPath) return true;
          const normFromDir = resolve(__dirname, id).replace(/\\/g, '/').toLowerCase();
          if (normFromDir === normPanelPath) return true;
        } catch {}
        return false;
      }
    }
  }
});
