#!/usr/bin/env node
// Regenerates src/views/handles.generated.ts — the element handle types of @kubuno/views (`save: Button`
// in a code-behind) — from the web element registry (src/ui/kbview-registry.web.json), with the
// same generator as the compiler (kubuno-views-web, through @kubuno/views-compiler's WASM).
//
//   node scripts/build-views-handles.mjs           # write
//   node scripts/build-views-handles.mjs --check   # fail when the committed file is stale
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadNodeCompiler } from '../packages/views-compiler/dist/index.js'

const fe = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = join(fe, 'packages', 'ui', 'kbview-registry.web.json')
const out = join(fe, 'src', 'views', 'handles.generated.ts')

const compiler = await loadNodeCompiler()
compiler.addRegistry(readFileSync(registry, 'utf8'), 'kbview-registry.web.json', true)
const text = compiler.handleTypes()
compiler.dispose()

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(out, 'utf8')
  } catch {
    // Missing: stale.
  }
  if (current.replace(/\r\n/g, '\n') !== text) {
    console.error('src/views/handles.generated.ts is stale: run `npm run build:views-handles`')
    process.exit(1)
  }
  console.log('handles.generated.ts is up to date')
} else {
  writeFileSync(out, text)
  console.log(`wrote ${out}`)
}
