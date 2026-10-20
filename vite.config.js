import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

let gitHash = 'dev';
try { gitHash = execSync('git rev-parse --short HEAD').toString().trim(); } catch {}

export default defineConfig({
  define: { __BUILD_HASH__: JSON.stringify(gitHash) },
  plugins: [react()],
  build: {
    minify: 'esbuild',
    target: 'es2015',
  },
  esbuild: {
    keepNames: true,
  },
});
