import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadTypeScript, readI18nModule, readJsonLocales, sameBundles, verifyKbresSet, writeKbresSet } from '../src/i18n-convert.js'
import { compileKbresSet, flattenBundle, kbresName, nestStrings, type KbresCodec } from '../src/kbres.js'
import { loadNodeKbres } from '../src/project.js'
import { FRONTEND } from './paths.js'

/** The 13 languages the product ships. */
const LANGUAGES = ['ar', 'de', 'el', 'en', 'es', 'fr', 'he', 'hi', 'it', 'ja', 'pt', 'ru', 'zh']

const work = mkdtempSync(join(tmpdir(), 'kbres-convert-'))
let codec: KbresCodec
beforeAll(async () => {
  codec = await loadNodeKbres()
})
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** Leaf count of a bundle. */
const leaves = (b: unknown): number => flattenBundle(b as Record<string, unknown>).length

describe('kbres-convert: the core\'s own dictionaries round-trip in the 13 languages', () => {
  const ts = loadTypeScript(FRONTEND)
  const sources = [
    { name: 'core', bundles: () => readJsonLocales(join(FRONTEND, 'src/core/i18n/locales'), 'core') },
    { name: 'setup', bundles: () => readI18nModule(ts, join(FRONTEND, 'src/core/setup/i18n.ts')).find((r) => r.ns === 'setup')!.bundles },
    // The navigation labels were converted (src/core/i18n/nav.kbres + satellites, imported by nav.ts): their set
    // round-trips again.
    { name: 'nav', bundles: () => compileKbresSet(codec, join(FRONTEND, 'src/core/i18n/nav.kbres')).bundles },
  ]

  for (const source of sources) {
    it(`${source.name}: every key and every value of every language identical after .kbres`, () => {
      const bundles = source.bundles()
      expect(Object.keys(bundles).sort()).toEqual(LANGUAGES)
      const out = join(work, source.name, `${source.name}.kbres`)
      const written = writeKbresSet(codec, bundles, out, 'en')
      // One neutral file (English) and twelve satellites.
      expect(written.files.length).toBe(13)
      expect(readdirSync(join(work, source.name)).filter((f) => f.endsWith('.kbres')).length).toBe(13)
      expect(readFileSync(out, 'utf8')).toMatch(/<Resources[^>]*Culture="en"/)
      // Read back through the Vite plugin's path: the same bundles, key order included.
      const back = compileKbresSet(codec, out)
      expect(back.errors).toEqual([])
      expect(Object.keys(back.bundles).sort()).toEqual(LANGUAGES)
      for (const lang of LANGUAGES) {
        expect(leaves(back.bundles[lang]), `${source.name} ${lang}`).toBe(leaves(bundles[lang]))
        expect(sameBundles(back.bundles[lang], bundles[lang]), `${source.name} ${lang}`).toBe(true)
      }
      expect(() => verifyKbresSet(codec, bundles, out)).not.toThrow()
    })
  }

  it('keeps the plural forms, the placeholders, the Trans tags and the surrounding spaces', () => {
    const core = readJsonLocales(join(FRONTEND, 'src/core/i18n/locales'), 'core')
    const flat = (lang: string) => new Map(flattenBundle(core[lang]).map((s) => [s.name, s.value]))
    const back = compileKbresSet(codec, join(work, 'core', 'core.kbres'))
    const flatBack = (lang: string) => new Map(flattenBundle(back.bundles[lang]).map((s) => [s.name, s.value]))
    for (const lang of ['ar', 'ru', 'fr', 'en']) {
      const before = flat(lang)
      const after = flatBack(lang)
      const plural = [...before.keys()].filter((k) => /_(zero|one|two|few|many|other)$/.test(k))
      expect(plural.length, lang).toBeGreaterThan(0)
      for (const k of plural) expect(after.get(k), `${lang} ${k}`).toBe(before.get(k))
      const spaced = [...before].filter(([, v]) => v !== v.trim())
      for (const [k, v] of spaced) expect(after.get(k), `${lang} ${k}`).toBe(v)
      const placeholders = [...before].filter(([, v]) => v.includes('{{'))
      expect(placeholders.length, lang).toBeGreaterThan(0)
      for (const [k, v] of placeholders) expect(after.get(k)).toBe(v)
    }
    // Arabic has all six plural categories somewhere.
    const ar = [...flat('ar').keys()]
    for (const cat of ['zero', 'one', 'two', 'few', 'many', 'other']) expect(ar.some((k) => k.endsWith(`_${cat}`)), cat).toBe(true)
  })
})

describe('.kbres ↔ i18next bundles', () => {
  it('nests dotted names and flattens back in the same order', () => {
    const strings = [
      { name: 'header.settings', value: 'Settings' },
      { name: 'header.help', value: 'Help' },
      { name: 'files_one', value: '{{count}} file' },
      { name: 'files_other', value: '{{count}} files' },
      { name: 'lead', value: '  spaced \n line\t' },
    ]
    const { bundle, problems } = nestStrings(strings)
    expect(problems).toEqual([])
    expect(bundle).toEqual({ header: { settings: 'Settings', help: 'Help' }, files_one: '{{count}} file', files_other: '{{count}} files', lead: '  spaced \n line\t' })
    expect(flattenBundle(bundle)).toEqual(strings)
  })

  it('reports a name that is both a string and a group, and refuses what .kbres cannot hold', () => {
    expect(nestStrings([{ name: 'a', value: 'x' }, { name: 'a.b', value: 'y' }]).problems.length).toBe(1)
    expect(() => flattenBundle({ list: ['a'] })).toThrow(/array/)
    expect(() => flattenBundle({ n: 3 })).toThrow(/number/)
    expect(() => flattenBundle({ '': 'x' })).toThrow(/empty key/)
    // A dot inside a key segment is escaped in the name, so the nesting round-trips.
    const dotted = { errors: { 'token.invalid': 'Invalid', 'back\\slash': 'b' } }
    expect(flattenBundle(dotted).map((s) => s.name)).toEqual(['errors.token\\.invalid', 'errors.back\\\\slash'])
    expect(nestStrings(flattenBundle(dotted)).bundle).toEqual(dotted)
  })

  it('names satellites by culture', () => {
    expect(kbresName('/p/strings.kbres')).toEqual({ stem: 'strings' })
    expect(kbresName('/p/strings.fr.kbres')).toEqual({ stem: 'strings', culture: 'fr' })
    expect(kbresName('/p/strings.pt-BR.kbres')).toEqual({ stem: 'strings', culture: 'pt-BR' })
    expect(kbresName('/p/app.config.kbres')).toEqual({ stem: 'app.config' })
  })

  it('writes values XML would otherwise change, byte for byte', () => {
    const tricky = {
      a: '<1>bold</1> & "quotes" \'apos\' > ok',
      b: 'line1\r\nline2\rline3\n',
      c: '',
      d: '   ',
      e: 'emoji 🎉 · RTL العربية · עברית',
      f: '{{count}} élément(s) - {{name, uppercase}}',
      g: '\ttab',
      h: ']]> <![CDATA[ x',
    }
    const out = join(work, 'tricky', 'tricky.kbres')
    writeKbresSet(codec, { en: tricky, fr: { a: 'x' } }, out, 'en')
    const back = compileKbresSet(codec, out)
    expect(back.bundles.en).toEqual(tricky)
    expect(back.bundles.fr).toEqual({ a: 'x' })
  })
})
