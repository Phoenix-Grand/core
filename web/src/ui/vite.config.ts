import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// Build @kubuno/ui as a standalone ESM library. All bare imports (react,
// lucide-react, clsx…) stay external — they are peer dependencies provided by
// the consumer (and, for modules, by the host at runtime).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('../../src/ui/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: (id: string) => !id.startsWith('.') && !id.startsWith('/'),
    },
  },
})
