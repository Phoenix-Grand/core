import type { TFunction } from 'i18next'
import { apiErrorDetail } from '../../core/api/errorMessage'

/** Optional catalog fields; old and third-party catalogs remain readable. */
export interface MarketText {
  name?: string | null
  summary?: string | null
  description?: string | null
  category?: string | null
}

export interface MarketModule {
  id: string
  name: string
  version: string
  author?: string | null
  official: boolean
  category?: string | null
  category_id?: string | null
  localizations?: Record<string, MarketText> | null
  accent?: string | null
  summary?: string | null
  description?: string | null
  license?: string | null
  tags: string[]
  rating?: number | null
  updated?: string | null
  links?: { repo?: string | null; html?: string | null }
  installed: boolean
  installed_version: string | null
  enabled?: boolean | null
  removable: boolean
}

export interface InstallReport { name: string; version: string; started: boolean }
export interface InstallProgress {
  phase: string
  message?: string
  params?: Record<string, string>
  report?: InstallReport
  error?: string
  error_code?: string
}
export interface MarketplaceFailure { code: string; detail?: string }

const categoryKeys: Record<string, string> = {
  office: 'admin.mk_category_office',
  communication: 'admin.mk_category_communication',
  creation: 'admin.mk_category_creation',
  development: 'admin.mk_category_development',
  productivity: 'admin.mk_category_productivity',
  storage: 'admin.mk_category_storage',
  other: 'admin.mk_category_other',
}
// Compatibility with the current catalog, whose category is a display label.
// Never use the translated label as identity or rewrite the downloaded metadata.
const legacyCategories: Record<string, string> = {
  Bureautique: 'office', Office: 'office',
  Communication: 'communication',
  'Création': 'creation', Creation: 'creation',
  'Développeurs': 'development', Developers: 'development',
  'Productivité': 'productivity', Productivity: 'productivity',
  Stockage: 'storage', Storage: 'storage',
  Autres: 'other', Other: 'other',
}
const own = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined

const normalizeLocale = (locale: string) => locale.replaceAll('_', '-').toLowerCase()

/** Resolve each field independently. Empty strings are intentional translations. */
export function localizedText(module: MarketModule, field: keyof MarketText, language: string): string | undefined {
  const parts = normalizeLocale(language).split('-')
  const locales: string[] = []
  while (parts.length) { locales.push(parts.join('-')); parts.pop() }
  if (!locales.includes('en')) locales.push('en')
  const entries = Object.entries(module.localizations ?? {})
  for (const locale of locales) {
    const value = entries.find(([key]) => normalizeLocale(key) === locale)?.[1]?.[field]
    if (typeof value === 'string') return value
  }
  return undefined
}

export function localizeModule(module: MarketModule, language: string): MarketModule {
  return {
    ...module,
    name: localizedText(module, 'name', language) ?? module.name,
    summary: localizedText(module, 'summary', language) ?? module.summary,
    description: localizedText(module, 'description', language) ?? module.description,
  }
}

export function categoryId(module: MarketModule): string | undefined {
  return module.category_id || (module.category ? own(legacyCategories, module.category) : 'other')
}

export function categoryKey(module: MarketModule): string {
  const id = categoryId(module)
  return id ? `id:${id}` : `label:${module.category}`
}

export function categoryLabel(module: MarketModule, language: string, t: TFunction): string {
  const localized = localizedText(module, 'category', language)
  if (localized !== undefined && localized !== '') return localized
  const id = categoryId(module)
  const key = id ? own(categoryKeys, id) : undefined
  return key ? t(key) : module.category || module.category_id || t('admin.mk_category_other')
}

export function relatedModules(module: MarketModule, other: MarketModule): boolean {
  return module.id !== other.id && (
    (!!(module.category_id || module.category) && !!(other.category_id || other.category)
      && categoryKey(module) === categoryKey(other))
    || module.tags.some(tag => other.tags.includes(tag))
  )
}

const phaseKeys: Record<string, string> = {
  queued: 'admin.mk_phase_queued', resolving: 'admin.mk_phase_resolving',
  downloading: 'admin.mk_phase_downloading', verifying: 'admin.mk_phase_verifying',
  extracting: 'admin.mk_phase_extracting', starting: 'admin.mk_phase_starting',
  done: 'admin.mk_phase_done', error: 'admin.mk_install_failed',
}

export function progressLabel(progress: InstallProgress | undefined, t: TFunction): string {
  if (progress?.phase === 'dependencies') {
    return progress.params?.dependency
      ? t('admin.mk_phase_dependency', { name: progress.params.dependency })
      : t('admin.mk_phase_dependencies')
  }
  const key = progress && own(phaseKeys, progress.phase)
  // Unknown phases get a localized generic status, not arbitrary server prose.
  return key ? t(key) : t('admin.mk_installing')
}

const errorKeys: Record<string, string> = {
  INSTALL_FAILED: 'admin.mk_install_failed', UNINSTALL_FAILED: 'admin.mk_uninstall_failed',
  INSTALL_TIMEOUT: 'admin.mk_timeout', UNAUTHORIZED: 'admin.mk_error_unauthorized',
  FORBIDDEN: 'admin.mk_error_forbidden', CONFLICT: 'admin.mk_error_conflict',
  NOT_FOUND: 'admin.mk_error_not_found', VALIDATION_ERROR: 'admin.mk_error_validation',
}

export function marketplaceFailure(error: unknown, fallback: string): MarketplaceFailure {
  const value = error as { code?: string; response?: { data?: { error?: string } } } | null
  const code = value?.response?.data?.error ?? value?.code
  return { code: code && own(errorKeys, code) ? code : fallback, detail: apiErrorDetail(error) }
}

export function failureLabel(failure: MarketplaceFailure, t: TFunction): string {
  return t(own(errorKeys, failure.code) ?? 'admin.mk_install_failed')
}
