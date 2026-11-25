import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // three.js is most of the bundle and is needed up-front anyway
    chunkSizeWarningLimit: 800,
  },
});
