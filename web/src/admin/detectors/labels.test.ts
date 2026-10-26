import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from 'i18next'
import { beforeAll, expect, it } from 'vitest'
import en from '../../core/i18n/locales/en/core.json'
import fr from '../../core/i18n/locales/fr/core.json'
import defaults from './builtinDefaults.json'
import { detectorDescription, detectorLabel } from './labels'

const i18n = createInstance()
beforeAll(async () => {
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, fr: { translation: fr } } })
})

it('covers the factory metadata actually seeded in the database', () => {
  const sql = readFileSync(join(process.cwd(), '../server/migrations/sqlite/000001_core_schema.up.sql'), 'utf8')
  const seeded = [...sql.matchAll(/INSERT INTO "core"\."content_detectors" [^\n]+? VALUES \(X'[^']+', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)'/g)]
  expect(seeded).toHaveLength(14)
  for (const [, key, label, description] of seeded) {
    expect((defaults as Record<string, object>)[key]).toEqual({ label: label.replaceAll("''", "'"), description: description.replaceAll("''", "'") })
  }
})

it('shows all factory names and descriptions in the selected language without mutating them', () => {
  for (const [key, text] of Object.entries(defaults)) {
    const detector = Object.freeze({ key, ...text, is_builtin: true })
    const suffix = key.slice('core.'.length)
    for (const [language, catalogue] of [['en', en], ['fr', fr]] as const) {
      const t = i18n.getFixedT(language)
      const admin = catalogue.admin as Record<string, string>
      const label = admin[`det_builtin_${suffix}_label`]
      const description = admin[`det_builtin_${suffix}_description`]
      expect(label).toBeTruthy()
      expect(description).toBeTruthy()
      expect(detectorLabel(t, detector)).toBe(label)
      expect(detectorDescription(t, detector)).toBe(description)
    }
    expect(detector).toEqual({ key, ...text, is_builtin: true })
  }
})

it('keeps custom detectors and administrator edits verbatim', () => {
  const t = i18n.getFixedT('en')
  const original = { key: 'core.card', ...defaults['core.card'], is_builtin: true }
  const edited = { ...original, label: 'Cartes de notre équipe', description: 'Description personnalisée' }
  expect(detectorLabel(t, edited)).toBe(edited.label)
  expect(detectorDescription(t, edited)).toBe(edited.description)
  const custom = { ...original, is_builtin: false }
  expect(detectorLabel(t, custom)).toBe(custom.label)
  expect(detectorDescription(t, custom)).toBe(custom.description)
  expect(detectorDescription(t, { ...original, description: null })).toBeNull()
  const unknown = { ...original, key: 'custom.card' }
  expect(detectorLabel(t, unknown)).toBe(unknown.label)
})

it('localizes built-in entries from the rule catalogue, which omits the origin flag', () => {
  const row = { key: 'core.email', ...defaults['core.email'] }
  expect(detectorLabel(i18n.getFixedT('en'), row)).toBe('Email address')
  expect(detectorDescription(i18n.getFixedT('en'), row)).toBe(en.admin.det_builtin_email_description)
})
