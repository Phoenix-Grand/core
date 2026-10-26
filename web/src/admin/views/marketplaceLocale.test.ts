import { createInstance } from 'i18next'
import { expect, it } from 'vitest'
import en from '../../core/i18n/locales/en/core.json'
import fr from '../../core/i18n/locales/fr/core.json'
import { categoryKey, categoryLabel, failureLabel, localizeModule, marketplaceFailure, progressLabel,
  relatedModules, type MarketModule } from './marketplaceLocale'

const module: MarketModule = {
  id: 'drive', name: 'Drive', version: '1.0', official: true, category: 'Bureautique',
  summary: 'Stockage de fichiers', tags: [], installed: false, installed_version: null, removable: false,
}
async function language(lng = 'en') {
  const i18n = createInstance()
  await i18n.init({ lng, fallbackLng: 'en', resources: { en: { translation: en }, fr: { translation: fr } } })
  return i18n
}

it('resolves locale, base language, English and original independently for each field', () => {
  const localized = { ...module, localizations: {
    'pt-BR': { name: 'Arquivos' }, pt: { summary: 'Armazenamento' }, en: { description: 'File storage' },
  } }
  expect(localizeModule(localized, 'pt_br')).toMatchObject({ name: 'Arquivos', summary: 'Armazenamento', description: 'File storage' })
  expect(localizeModule(localized, 'de')).toMatchObject({ name: 'Drive', summary: 'Stockage de fichiers', description: 'File storage' })
  expect(localized.summary).toBe('Stockage de fichiers')
})

it('preserves empty translations, unknown modules, and metadata without translations', () => {
  expect(localizeModule({ ...module, localizations: { en: { summary: '' } } }, 'en').summary).toBe('')
  expect(localizeModule({ ...module, localizations: null }, 'en')).toEqual({ ...module, localizations: null })
  expect(localizeModule({ ...module, official: false, name: 'Mon module privé' }, 'en').name).toBe('Mon module privé')
})

it('translates known legacy categories and missing categories without changing their identity', async () => {
  const i18n = await language()
  expect(categoryLabel(module, 'en', i18n.t)).toBe('Office')
  expect(categoryLabel({ ...module, category: null }, 'en', i18n.t)).toBe('Other')
  expect(categoryKey(module)).toBe(categoryKey({ ...module, category_id: 'office', category: 'Different label' }))
  await i18n.changeLanguage('fr')
  expect(categoryLabel(module, 'fr', i18n.t)).toBe('Bureautique')
  expect(categoryKey(module)).toBe('id:office')
})

it('preserves custom category labels and prefers publisher translations', async () => {
  const i18n = await language()
  expect(categoryLabel({ ...module, category: 'My own category' }, 'en', i18n.t)).toBe('My own category')
  expect(categoryLabel({ ...module, category_id: 'custom', category: null }, 'en', i18n.t)).toBe('custom')
  expect(categoryLabel({ ...module, localizations: { en: { category: 'Office tools' } } }, 'en', i18n.t)).toBe('Office tools')
  expect(categoryLabel({ ...module, category: '__proto__' }, 'en', i18n.t)).toBe('__proto__')
})

it('matches related modules using stable category IDs or tags, never translated display labels', () => {
  const calendar = { ...module, id: 'calendar', category_id: 'office', category: 'Calendriers' }
  expect(relatedModules(module, calendar)).toBe(true)
  expect(relatedModules(module, module)).toBe(false)
  expect(relatedModules({ ...module, category: null }, { ...calendar, category: null, category_id: null })).toBe(false)
  expect(relatedModules({ ...module, tags: ['shared'] }, { ...calendar, category_id: 'other', tags: ['shared'] })).toBe(true)
})

it('translates progress codes and structured dependency parameters instead of server prose', async () => {
  const i18n = await language()
  const progress = { phase: 'extracting', message: 'Extraction du paquet…' }
  expect(progressLabel(progress, i18n.t)).toBe('Extracting package…')
  expect(progressLabel({ phase: 'dependencies', params: { dependency: 'drive' } }, i18n.t)).toContain('“drive”')
  expect(progressLabel({ phase: 'dependencies' }, i18n.t)).toBe('Installing dependencies…')
  expect(progressLabel({ phase: 'future', message: 'Une nouvelle phase' }, i18n.t)).toBe('Installing…')
  await i18n.changeLanguage('fr')
  expect(progressLabel(progress, i18n.t)).toBe('Extraction du paquet…')
})

it('keeps diagnostics separate from translated errors and supports old/new API error shapes', async () => {
  const i18n = await language()
  const failure = marketplaceFailure({ code: 'FORBIDDEN', message: 'Accès refusé' }, 'INSTALL_FAILED')
  expect(failureLabel(failure, i18n.t)).toBe(en.admin.mk_error_forbidden)
  expect(failure.detail).toBe('Accès refusé')
  expect(marketplaceFailure({ response: { data: { error: 'CONFLICT', message: 'Busy' } } }, 'INSTALL_FAILED')).toEqual({ code: 'CONFLICT', detail: 'Busy' })
  expect(failureLabel(marketplaceFailure(new Error('Diagnostic'), 'UNINSTALL_FAILED'), i18n.t)).toBe(en.admin.mk_uninstall_failed)
  expect(marketplaceFailure({ code: 'INTERNAL_ERROR', message: 'Diagnostic' }, 'UNINSTALL_FAILED').code).toBe('UNINSTALL_FAILED')
  expect(failureLabel({ code: 'UNKNOWN' }, i18n.t)).toBe(en.admin.mk_install_failed)
  await i18n.changeLanguage('fr')
  expect(failureLabel(failure, i18n.t)).toBe(fr.admin.mk_error_forbidden)
})

it('has readable English and French labels for every supported category and phase', async () => {
  for (const lng of ['en', 'fr']) {
    const i18n = await language(lng)
    for (const id of ['office', 'communication', 'creation', 'development', 'productivity', 'storage', 'other']) {
      expect(categoryLabel({ ...module, category_id: id }, lng, i18n.t)).not.toContain('admin.')
    }
    for (const phase of ['queued', 'resolving', 'downloading', 'verifying', 'extracting', 'dependencies', 'starting', 'done', 'error']) {
      expect(progressLabel({ phase }, i18n.t)).not.toContain('admin.')
    }
  }
})
