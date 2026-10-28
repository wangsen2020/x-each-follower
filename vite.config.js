import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(__dirname, 'src'),
  base: './',
  plugins: [
    vue()
  ],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        panel: resolve(__dirname, 'src/panel.html'),
        grokBotGuide: resolve(__dirname, 'src/grok-bot-guide.html'),
        grokLocalGuide: resolve(__dirname, 'src/grok-local-guide.html'),
        background: resolve(__dirname, 'src/entries/background/background.js')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]'
      }
    }
  }
});
