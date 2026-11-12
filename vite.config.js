import { defineConfig } from 'vite';

// base './' so the built site works from any path (static hosting, sub-folders).
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 2000 },
  test: { include: ['tests/**/*.test.js'] },
});
