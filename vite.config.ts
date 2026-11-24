import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  root: 'web', plugins: [react()],
  server: { fs: { allow: [path.resolve('web'), path.resolve('node_modules')] } },
  build: { outDir: '../dist', emptyOutDir: true },
});
