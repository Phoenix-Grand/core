import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from 'i18next'
import { expect, it } from 'vitest'
import en from '../../core/i18n/locales/en/core.json'
import fr from '../../core/i18n/locales/fr/core.json'
import type { ResolvedSetting } from './scopeTypes'
import { settingControlValue, settingDisplayValue } from './settingValues'

const inherited = {
  key: 'instance.description', value: 'Mon cloud personnel',
  source: { scope_type: 'default', scope_id: null, scope_name: null },
} as ResolvedSetting

it('translates the actual seeded factory description in a fresh English session', async () => {
  const sql = readFileSync(join(process.cwd(), '../server/migrations/sqlite/000001_core_schema.up.sql'), 'utf8')
  const raw = sql.match(/VALUES \('instance\.description', '([^']+)'/)![1]
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en } } })
  expect(settingControlValue(instance.t, { ...inherited, value: JSON.parse(raw) }, {})).toBe('My personal cloud')
  expect(instance.hasResourceBundle('fr', 'translation')).toBe(false)
})

it('follows the selected language for factory values in controls and inheritance chains', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en }, fr: { translation: fr } } })
  for (const language of ['en', 'fr', 'en']) {
    await instance.changeLanguage(language)
    const expected = language === 'en' ? 'My personal cloud' : 'Mon cloud personnel'
    expect(settingControlValue(instance.t, inherited, {})).toBe(expected)
    for (const value of ['Mon cloud personnel', 'My personal cloud']) {
      expect(settingDisplayValue(instance.t, inherited.key, value, 'default')).toBe(expected)
    }
  }
})

it('preserves overrides, drafts, cleared values and unrelated settings without creating edits', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en } } })
  for (const scope of ['instance', 'org_unit', 'group', 'user', undefined] as const) {
    expect(settingDisplayValue(instance.t, inherited.key, inherited.value, scope)).toBe(inherited.value)
  }
  for (const value of ['Mon cloud personnel', 'Notre équipe', '', null]) {
    const edits = { [inherited.key]: value }
    expect(settingControlValue(instance.t, inherited, edits)).toBe(value)
    expect(edits).toEqual({ [inherited.key]: value })
  }
  const edits = { 'instance.name': 'Test' }
  expect(settingControlValue(instance.t, inherited, edits)).toBe('My personal cloud')
  expect(edits).toEqual({ 'instance.name': 'Test' })
  for (const value of ['Notre équipe', '', null, false, 10]) {
    expect(settingDisplayValue(instance.t, inherited.key, value, 'default')).toBe(value)
  }
  expect(settingDisplayValue(instance.t, 'module.description', inherited.value, 'default')).toBe(inherited.value)
  expect(inherited.value).toBe('Mon cloud personnel')
})
