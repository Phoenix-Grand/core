import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from 'i18next'
import { expect, it } from 'vitest'
import en from '../i18n/locales/en/core.json'
import fr from '../i18n/locales/fr/core.json'
import seeded from './seededText.json'
import { createAuthzLabels } from './labels'
import type { Role } from './types'

const systemRole = (slug: string, name: string, description: string | null): Role => ({
  id: slug, slug, name, description, is_system: true, is_superuser: slug === 'super-admin',
  privileges: [], assignment_count: 0, ou_delegable: false, created_at: '', updated_at: '',
})

it('covers all role and privilege text seeded by the database', () => {
  const sql = readFileSync(join(process.cwd(), '../server/migrations/sqlite/000001_core_schema.up.sql'), 'utf8')
  let roles = 0
  let privileges = 0
  for (const table of ['roles', 'privileges']) {
    const pattern = new RegExp(`INSERT INTO "core"\\."${table}" \\(([^\\n]+?)\\) VALUES \\(([^\\n]+)\\);`, 'g')
    for (const row of sql.matchAll(pattern)) {
      const columns = row[1].split(',').map(column => column.trim().replaceAll('"', ''))
      const values = [...row[2].matchAll(/\s*((?:X)?'(?:[^']|'')*'|[^,]+)\s*(?:,|$)/g)].map(value => {
        const raw = value[1].trim()
        return raw === 'NULL' ? null : raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : raw
      })
      expect(values).toHaveLength(columns.length)
      const entry = Object.fromEntries(columns.map((column, index) => [column, values[index]]))
      if (table === 'roles' && entry.is_system !== '1') continue
      if (table === 'privileges' && entry.namespace !== 'core') continue
      const id = (table === 'roles' ? entry.slug! : entry.key!).replace(/[.-]/g, '_')
      const fields = table === 'roles' ? [['rolelbl_', 'name'], ['roledsc_', 'description']] : [['privlbl_', 'label'], ['privdsc_', 'description']]
      for (const [prefix, field] of fields) {
        if (!entry[field]) continue
        const key = prefix + id
        expect((seeded as Record<string, string>)[`admin.${key}`]).toBe(entry[field])
        expect((en.admin as Record<string, string>)[key]?.trim(), key).toBeTruthy()
        expect((fr.admin as Record<string, string>)[key]?.trim(), key).toBeTruthy()
      }
      if (table === 'roles') roles++
      else privileges++
    }
  }
  expect(roles).toBe(7)
  expect(privileges).toBe(51)
})

it('translates a fresh English session before the French bundle is loaded', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } } })
  expect(instance.hasResourceBundle('fr', 'translation')).toBe(false)
  const labels = createAuthzLabels(instance.t)
  const sql = readFileSync(join(process.cwd(), '../server/migrations/sqlite/000001_core_schema.up.sql'), 'utf8')
  const privilegeKeys = [...sql.matchAll(/INSERT INTO "core"\."privileges" [^\n]+? VALUES \('([^']+)'/g)].map(row => row[1])
  for (const [key, text] of Object.entries(seeded)) {
    const name = key.slice('admin.'.length)
    const expected = (en.admin as Record<string, string>)[name]
    if (name.startsWith('rolelbl_')) {
      const slug = name.slice('rolelbl_'.length).replaceAll('_', '-')
      expect(labels.roleName(systemRole(slug, text, null))).toBe(expected)
    } else if (name.startsWith('roledsc_')) {
      const slug = name.slice('roledsc_'.length).replaceAll('_', '-')
      expect(labels.roleDescription(systemRole(slug, slug, text))).toBe(expected)
    } else {
      const prefix = name.startsWith('privlbl_') ? 'privlbl_' : 'privdsc_'
      // Match real identifiers instead of guessing where underscore domains end.
      const id = name.slice(prefix.length)
      const privilege = privilegeKeys.find(key => key.replace(/[.-]/g, '_') === id)
      expect(privilege, key).toBeDefined()
      const entry = { key: privilege!, label: prefix === 'privlbl_' ? text : privilege!, description: prefix === 'privdsc_' ? text : null }
      expect(prefix === 'privlbl_' ? labels.privilegeLabel(entry) : labels.privilegeDescription(entry), key).toBe(expected)
    }
  }
  expect(instance.hasResourceBundle('fr', 'translation')).toBe(false)
})

it('follows a later language selection while preserving edits, custom entries and cleared descriptions', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, fr: { translation: fr } } })
  const role = systemRole('directory-reader', seeded['admin.rolelbl_directory_reader'], seeded['admin.roledsc_directory_reader'])
  for (const language of ['en', 'fr', 'en']) {
    await instance.changeLanguage(language)
    const labels = createAuthzLabels(instance.t)
    const catalogue = language === 'en' ? en : fr
    expect(labels.roleName(role)).toBe(catalogue.admin.rolelbl_directory_reader)
    expect(labels.roleDescription(role)).toBe(catalogue.admin.roledsc_directory_reader)
    expect(labels.roleName({ ...role, name: 'Notre équipe' })).toBe('Notre équipe')
    expect(labels.roleName({ ...role, is_system: false })).toBe(role.name)
    expect(labels.roleDescription({ ...role, description: null })).toBeNull()
    expect(labels.roleDescription({ ...role, description: '' })).toBeNull()
    expect(labels.roleDescription({ ...role, description: 'Description personnalisée' })).toBe('Description personnalisée')
    expect(labels.privilegeLabel({ key: 'module.test.read', label: 'Libellé du module' })).toBe('Libellé du module')
  }
})
