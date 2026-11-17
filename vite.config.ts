import { defineConfig } from 'vite';

// base './' để chạy được ở GitHub Pages (https://<user>.github.io/hat-ra-nhac/)
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
