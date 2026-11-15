import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Map and tuning JSON live in /data at the repo root.
    fs: { allow: ['../..'] },
  },
  build: {
    target: 'es2022',
  },
});
