import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance } from 'i18next'
import { expect, it } from 'vitest'
import en from '../i18n/locales/en/core.json'
import fr from '../i18n/locales/fr/core.json'
import { exportServiceLabel, exportServiceDescription } from './labels'

const core = Object.freeze({ id: 'core', module_id: 'core', label: 'Mon compte', description: 'Le profil, les appartenances, les appareils connus et le journal de vos actions.' })

it('covers the built-in service text supplied by both export APIs in a cold English session', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en } } })
  for (const [context, file, catalogue, label, description] of [
    ['self', 'me_export.rs', fr.settings, 'mde_core_label', 'mde_core_description'],
    ['admin', 'admin/data_export.rs', fr.admin, 'dx_core_label', 'dx_core_description'],
  ] as const) {
    const source = readFileSync(join(process.cwd(), '../server/src/handlers', file), 'utf8')
    const seed = source.slice(source.indexOf('fn services_payload'), source.indexOf('for offer in offers', source.indexOf('fn services_payload')))
    expect(seed).toMatch(/"module_id":\s*"core"/)
    expect(seed.match(/"label":\s*"([^"]+)"/)![1]).toBe((catalogue as Record<string, string>)[label])
    expect(seed.match(/"description":\s*"([^"]+)"/)![1]).toBe((catalogue as Record<string, string>)[description])
    const expected = context === 'self' ? en.settings : en.admin
    expect(exportServiceLabel(instance.t, core, context)).toBe((expected as Record<string, string>)[label])
    expect(exportServiceDescription(instance.t, core, context)).toBe((expected as Record<string, string>)[description])
  }
  expect(instance.hasResourceBundle('fr', 'translation')).toBe(false)
})

it('follows English/French selections for the service text', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en }, fr: { translation: fr } } })
  for (const language of ['en', 'fr', 'en']) {
    await instance.changeLanguage(language)
    const catalogue = language === 'en' ? en : fr
    expect(exportServiceLabel(instance.t, core, 'self')).toBe(catalogue.settings.mde_core_label)
    expect(exportServiceDescription(instance.t, core, 'self')).toBe(catalogue.settings.mde_core_description)
    expect(exportServiceLabel(instance.t, core, 'admin')).toBe(catalogue.admin.dx_core_label)
    expect(exportServiceDescription(instance.t, core, 'admin')).toBe(catalogue.admin.dx_core_description)
  }
})

it('preserves module-owned text and does not mutate service identifiers or raw metadata', async () => {
  const instance = createInstance()
  await instance.init({ lng: 'en', resources: { en: { translation: en } } })
  for (const service of [
    { ...core, id: 'notes.documents', module_id: 'notes' },
    { ...core, module_id: 'custom-module' },
    { ...core, id: 'core.extra' },
    { id: 'custom', module_id: 'custom', label: 'Custom service', description: null },
  ]) {
    for (const context of ['self', 'admin'] as const) {
      expect(exportServiceLabel(instance.t, service, context)).toBe(service.label)
      expect(exportServiceDescription(instance.t, service, context)).toBe(service.description)
    }
  }
  exportServiceLabel(instance.t, core, 'self')
  expect(core.id).toBe('core')
  expect(core.module_id).toBe('core')
  expect(core.label).toBe('Mon compte')
})
