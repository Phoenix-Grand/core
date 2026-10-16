/**
 * The `.kbview` element gallery (vskubuno docs/WEB-VIEWS.md, WV-5a/5b): one page per element, rendered by the
 * views runtime with the host's real `@ui` components and CSS, in light / dark and LTR / RTL. Development and
 * verification only - never part of the product build (`vite.config.ts` does not list `gallery.html`).
 *
 *   npx vite --config vite.gallery.config.ts                       # dev server, http://localhost:5174/gallery.html
 *   npx vite build --config vite.gallery.config.ts                 # static build in dist-gallery/
 *   node scripts/capture-gallery.mjs --dist dist-gallery --out <dir>  # captures (headless Chrome)
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { kbview } from './packages/views-compiler/dist/index.js'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [kbview(), react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify('gallery'),
    __APP_BUILD__: JSON.stringify('gallery'),
  },
  resolve: {
    alias: {
      '@ui': here('./src/ui'),
      '@kubuno/sdk': here('./src/sdk/index.ts'),
      '@kubuno/drive': here('./src/drive/index.ts'),
      '@kubuno/views': here('./src/views/index.ts'),
    },
  },
  base: './',
  server: { port: 5174, fs: { allow: [here('..')] } },
  build: {
    outDir: 'dist-gallery',
    emptyOutDir: true,
    rollupOptions: { input: { gallery: here('./gallery.html') } },
  },
})
