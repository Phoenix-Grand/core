import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from 'i18next'
import { expect, it } from 'vitest'
import en from '../i18n/locales/en/core.json'
import fr from '../i18n/locales/fr/core.json'
import builtin from './builtinText.json'
import { groupName, groupDescription, audienceName, audienceDescription } from './labels'

it('translates every seeded system group and everyone audience before French resources load', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en } } })
  const sql = readFileSync(join(process.cwd(), '../server/migrations/sqlite/000001_core_schema.up.sql'), 'utf8')
  let groups = 0
  let audiences = 0
  for (const table of ['user_groups', 'target_audiences']) {
    const pattern = new RegExp(`INSERT INTO "core"\\."${table}" \\(([^\\n]+?)\\) VALUES \\(([^\\n]+)\\);`, 'g')
    for (const row of sql.matchAll(pattern)) {
      const columns = row[1].split(',').map(c => c.trim().replaceAll('"', ''))
      const values = [...row[2].matchAll(/\s*((?:X)?'(?:[^']|'')*'|[^,]+)\s*(?:,|$)/g)].map(value => {
        const raw = value[1].trim()
        return raw === 'NULL' ? null : raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : raw
      })
      expect(values).toHaveLength(columns.length)
      const entry = Object.fromEntries(columns.map((c, i) => [c, values[i]]))
      const text = { name: entry.name!, description: entry.description, is_system: entry.is_system === '1', is_everyone: entry.is_everyone === '1' }
      if (table === 'user_groups' && text.is_system) {
        const match = Object.entries(builtin.groups).find(([, group]) => group.name === text.name)
        expect(match).toBeDefined()
        expect(text.description).toBe(match![1].description)
        for (const [field, label] of [['name', groupName], ['description', groupDescription]] as const) {
          const key = `group_builtin_${match![0]}_${field}`
          expect(label(instance.t, text)).toBe((en.admin as Record<string, string>)[key])
          expect((fr.admin as Record<string, string>)[key]).toBe(match![1][field])
        }
        groups++
      } else if (table === 'target_audiences' && text.is_everyone) {
        expect({ name: text.name, description: text.description }).toEqual(builtin.everyone)
        expect(audienceName(instance.t, text)).toBe(en.admin.audience_builtin_everyone_name)
        expect(audienceDescription(instance.t, text)).toBe(en.admin.audience_builtin_everyone_description)
        audiences++
      }
    }
  }
  expect(groups).toBe(3)
  expect(audiences).toBe(1)
  expect(instance.hasResourceBundle('fr', 'translation')).toBe(false)
})

it('follows language changes while preserving renamed and cleared fields independently', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en }, fr: { translation: fr } } })
  for (const language of ['en', 'fr', 'en']) {
    await instance.changeLanguage(language)
    const catalogue = language === 'en' ? en : fr
    for (const [key, text] of Object.entries(builtin.groups)) {
      const group = { ...text, is_system: true }
      expect(groupName(instance.t, group)).toBe((catalogue.admin as Record<string, string>)[`group_builtin_${key}_name`])
      expect(groupDescription(instance.t, group)).toBe((catalogue.admin as Record<string, string>)[`group_builtin_${key}_description`])
      expect(groupName(instance.t, { ...group, name: 'Notre équipe' })).toBe('Notre équipe')
      expect(groupDescription(instance.t, { ...group, name: 'Notre équipe' })).toBe(groupDescription(instance.t, group))
      for (const description of ['', null, 'Description personnalisée']) {
        expect(groupDescription(instance.t, { ...group, description })).toBe(description)
      }
    }
    const audience = { ...builtin.everyone, is_everyone: true }
    expect(audienceName(instance.t, audience)).toBe(catalogue.admin.audience_builtin_everyone_name)
    expect(audienceDescription(instance.t, audience)).toBe(catalogue.admin.audience_builtin_everyone_description)
  }
})

it('leaves custom groups and audiences verbatim even when their wording matches a factory record', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en } } })
  for (const text of Object.values(builtin.groups)) {
    for (const is_system of [false, undefined]) {
      expect(groupName(instance.t, { ...text, is_system })).toBe(text.name)
      expect(groupDescription(instance.t, { ...text, is_system })).toBe(text.description)
    }
  }
  const audience = { ...builtin.everyone, is_everyone: false }
  expect(audienceName(instance.t, audience)).toBe(audience.name)
  expect(audienceDescription(instance.t, audience)).toBe(audience.description)
})
