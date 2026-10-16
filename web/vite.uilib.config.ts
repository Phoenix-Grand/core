import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

/**
 * Builds the publishable `@kubuno/ui` bundle (src/ui/dist/index.js).
 *
 * It used to be produced ad hoc, so the committed bundle drifted from the
 * source - a Button fix landed in the host but not in the published package.
 * This config makes the artefact reproducible:
 *
 *   npx vite build --config vite.uilib.config.ts
 *
 * Externals mirror the package's peerDependencies exactly: the primitives must
 * share the HOST's single instance of React, zustand & co at runtime, never
 * bundle their own.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/ui/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    outDir: resolve(__dirname, 'src/ui/dist'),
    emptyOutDir: true,
    // Vite 8 minifies with oxc; esbuild is no longer bundled.
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: [
        'react', 'react-dom', 'react/jsx-runtime', 'react-dom/client',
        'clsx', 'tailwind-merge', 'lucide-react', 'zustand',
        'date-fns', 'date-fns/locale',
        'i18next', 'react-i18next',
      ],
    },
  },
})
