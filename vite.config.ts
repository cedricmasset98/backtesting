import { defineConfig } from 'vite';

// Relative base: the site works under any sub-path (cedricmasset98.github.io/backtesting/,
// a custom domain such as cedricmasset.ch/backtesting/, or a local preview).
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 5000,
  },
});
