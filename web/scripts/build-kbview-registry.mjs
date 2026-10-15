#!/usr/bin/env node
// Writes src/ui/kbview-registry.web.json from the `*.meta.ts` tables (VIEWS-SPEC §9), and the core
// project's own registry (its shell custom controls) src/core/shell/menus/kbview-controls.json.
//
//   npm run build:registry            regenerate the files
//   npm run build:registry -- --check exit 1 when a committed file is out of date
//
// The tables are plain TypeScript data: Node runs them directly (type stripping, Node >= 22.18
// or 23.6), without bundling the UI or touching node_modules.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectRegistryText, webRegistryText } from '../src/kbview/export.ts'
import { SHELL_CONTROLS } from '../src/core/shell/menus/controls.meta.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputs = [
  { file: resolve(root, 'src/ui/kbview-registry.web.json'), text: webRegistryText(), cmd: 'build:registry' },
  { file: resolve(root, 'src/core/shell/menus/kbview-controls.json'), text: projectRegistryText(SHELL_CONTROLS), cmd: 'build:registry' },
]

if (process.argv.includes('--check')) {
  let stale = false
  for (const { file, text, cmd } of outputs) {
    let current = ''
    try { current = readFileSync(file, 'utf8') } catch { /* missing = out of date */ }
    if (current !== text) {
      console.error(`${file} is out of date: run \`npm run ${cmd}\``)
      stale = true
    } else {
      console.log(`${file} is up to date`)
    }
  }
  if (stale) process.exit(1)
} else {
  for (const { file, text } of outputs) {
    writeFileSync(file, text)
    const doc = JSON.parse(text)
    console.log(`wrote ${file} (${doc.components.length} elements, version ${doc.version})`)
  }
}
