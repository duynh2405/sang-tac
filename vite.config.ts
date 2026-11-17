import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const VERSION: string = pkg.version;
// mỗi lần build có một mã riêng: dùng để phát hiện bản cập nhật mới
const BUILD_ID = `${VERSION}-${Date.now().toString(36)}`;

/** Sinh service worker (cache ứng dụng để dùng offline) và version.json sau khi build. */
function pwa(): Plugin {
  return {
    name: 'hrn-pwa',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const assets = Object.keys(bundle).filter((f) => !f.endsWith('.wasm') && !f.endsWith('.map'));
      const statics = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-64.png'];
      const precache = [...new Set([...statics, ...assets.map((a) => a.replace(/^\.?\/?/, ''))])];
      const sw = readFileSync(new URL('./src/sw-template.js', import.meta.url), 'utf8')
        .replace('__BUILD_ID__', BUILD_ID)
        .replace('__PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: VERSION, build: BUILD_ID }) });
    },
  };
}

// base './' để chạy được ở GitHub Pages (https://<user>.github.io/<repo>/)
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(VERSION),
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [pwa()],
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
