import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname, 'demo'),
  build: {
    outDir: resolve(__dirname, 'dist-demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'demo/index.html'),
        debug: resolve(__dirname, 'demo/debug.html'),
        hero2x: resolve(__dirname, 'demo/2x.html'),
        demosimple: resolve(__dirname, 'demo/demosimple.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'demo'),
    },
  },
});
