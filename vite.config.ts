import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// `base: './'` keeps every asset URL relative, so the built app works from any
// sub-path (GitHub Pages, a static folder on a home server, ...).
export default defineConfig({
  base: './',
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'MpesaTrack',
        short_name: 'MpesaTrack',
        description: 'Import M-PESA statements and categorise your spending. Data never leaves your phone.',
        theme_color: '#0b8f3c',
        background_color: '#f6f7f6',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache everything needed to run fully offline, including the
        // SQLite WebAssembly binary and the pdf.js worker.
        globPatterns: ['**/*.{js,mjs,css,html,wasm,png,svg,ico}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
    }),
  ],
  // sqlite-wasm loads its .wasm relative to its own module URL; pre-bundling breaks that.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
