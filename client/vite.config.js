import { defineConfig } from 'vite';

const appVersion = process.env.npm_package_version ?? '0.0.0';

export default defineConfig({
  root: 'src',
  // root is 'src', so envDir would default to client/src/ — but the .env files
  // live one level up in client/. Point envDir at client/ so .env.local (dev)
  // and .env.production (build) actually load.
  envDir: '..',
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  build: {
    rollupOptions: {
      input: {
        index: 'src/index.html'
      },
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          // Keep other deps in the default vendor chunk.
          return 'vendor';
        }
      }
    },
    outDir: '../dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    open: !process.env.CI
  },
  base: './'
});
