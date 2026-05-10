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
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'demo'),
    },
  },
});
