import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      // pdf.js loads these at runtime by URL, so they ship beside the bundle.
      name: 'pdfjs-runtime-files',
      closeBundle() {
        for (const dir of ['wasm', 'cmaps', 'standard_fonts']) {
          cpSync(resolve('node_modules/pdfjs-dist', dir), resolve('dist/pdfjs', dir), { recursive: true });
        }
      },
    },
  ],
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
});
