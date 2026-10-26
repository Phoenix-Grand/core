import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import en from './locales/en/core.json'
import fr from './locales/fr/core.json'

const config = vi.hoisted(() => ({ getPublicConfig: vi.fn() }))
vi.mock('../api/publicConfig', () => config)

beforeEach(() => {
  vi.resetModules()
  document.cookie = 'kubuno_lang=; path=/; max-age=0'
  localStorage.clear()
  document.documentElement.lang = 'en'
  config.getPublicConfig.mockReset()
})

afterEach(() => {
  vi.doUnmock('./locales/fr/core.json')
})

describe('language selection', () => {
  it('keeps English when an earlier French download finishes later', async () => {
    let finishFrench!: (value: { default: typeof fr }) => void
    vi.doMock('./locales/fr/core.json', () => new Promise(resolve => { finishFrench = resolve }))
    const { default: i18n, setLanguage } = await import('./index')
    setLanguage('fr')
    await vi.waitFor(() => expect(finishFrench).toBeTypeOf('function'))
    setLanguage('en')
    await vi.waitFor(() => expect(i18n.language).toBe('en'))
    finishFrench({ default: fr })
    await vi.dynamicImportSettled()
    expect(i18n.language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.cookie).toContain('kubuno_lang=en')
    expect(i18n.t('admin.m_scope_panel')).toBe('Settings scope')
  })

  it('keeps an explicit English account preference over the instance default', async () => {
    const { default: i18n, applyUserLanguage, syncInstanceLanguage } = await import('./index')
    await i18n.changeLanguage('en')
    applyUserLanguage('en')
    config.getPublicConfig.mockResolvedValue({ 'instance.locale': 'fr' })
    await syncInstanceLanguage()
    expect(i18n.language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.cookie).toContain('kubuno_lang=en')
  })

  it('renders previously French fallbacks and interpolated plurals in English', async () => {
    const { createInstance } = await import('i18next')
    const i18n = createInstance()
    await i18n.init({ lng: 'en', fallbackLng: 'en', defaultNS: 'core', resources: { en: { core: en }, fr: { core: fr } } })
    expect(i18n.t('account.disconnected', { defaultValue: 'Déconnecté' })).toBe('Signed out')
    expect(i18n.t('admin.m_scope_applies_to')).toBe('Settings applied to')
    expect(i18n.t('admin.m_filter_scope', { count: 1 })).toBe('1 setting found across the module')
    expect(i18n.t('admin.m_filter_scope', { count: 3 })).toBe('3 settings found across the module')
    expect(i18n.t('clipboard.items', { count: 1 })).toBe('1 item')
    expect(i18n.t('clipboard.items', { count: 2 })).toBe('2 items')
    expect(i18n.t('sharing.item_title', { name: 'Report' })).toBe('Share “Report”')
    expect(i18n.t('labels.shared_warning', { name: 'Team', owner: 'Sam' })).toBe('“Team” is a shared label. Its managers (Sam…) will see this item.')
  })
})
