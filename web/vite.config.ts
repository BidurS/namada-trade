import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Local dev proxies /api and /ws to `wrangler dev` (8787) by default.
// API_TARGET=https://namada.trade proxies to production data instead (read-only use).
const API = process.env.API_TARGET || 'http://localhost:8787';
const WS = API.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  root: 'web',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    // NT_NO_HMR=1 (the e2e harness): no hot reload, so another edit never reloads a page mid-test
    hmr: process.env.NT_NO_HMR ? false : undefined,
    // also used by `vite preview` (preview.proxy defaults to this): robots.txt and sitemap.xml are written by the
    // Worker (worker/src/seo.ts), not the static host, so they come from the same target as the API
    proxy: {
      '/api': {
        target: API,
        changeOrigin: true,
        secure: true,
      },
      '^/(robots\\.txt|sitemap\\.xml)$': {
        target: API,
        changeOrigin: true,
        secure: true,
      },
      '/ws': {
        target: WS,
        ws: true,
        changeOrigin: true,
        secure: true,
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared'),
    },
  },
});
