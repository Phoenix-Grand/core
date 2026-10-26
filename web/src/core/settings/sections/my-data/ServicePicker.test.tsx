import { fireEvent, render, screen } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { setResourceResolver } from '@kubuno/views'
import en from '../../../i18n/locales/en/core.json'

beforeAll(() => vi.stubGlobal('matchMedia', (media: string) => ({
  matches: false, media, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {},
})))
afterAll(() => { setResourceResolver(key => key); vi.unstubAllGlobals() })

it('renders the API service in English and preserves required selections and IDs', async () => {
  const i18n = createInstance()
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } })
  setResourceResolver((key, _set, args) => i18n.t(key, args))
  const { default: ServicePicker } = await import('./ServicePicker')
  const services = [
    { id: 'core', module_id: 'core', label: 'Mon compte', description: 'Le profil, les appartenances, les appareils connus et le journal de vos actions.', format: 'JSON + CSV', required: true },
    { id: 'notes', module_id: 'notes', label: 'Custom notes service', description: null, format: 'Markdown', required: false },
  ]
  const change = vi.fn()
  render(<I18nextProvider i18n={i18n}><ServicePicker services={services} selected={new Set(['core', 'notes'])} onChange={change} /></I18nextProvider>)
  expect(screen.getByText('My account', { exact: true })).toBeInTheDocument()
  expect(screen.getByText(en.settings.mde_core_description + ' · JSON + CSV')).toBeInTheDocument()
  expect(screen.queryByText('Mon compte')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: en.settings.mde_select_none }))
  expect(change).toHaveBeenLastCalledWith(new Set(['core']))
  fireEvent.click(screen.getByRole('button', { name: en.settings.mde_select_all }))
  expect(change).toHaveBeenLastCalledWith(new Set(['core', 'notes']))
  expect(services[0].label).toBe('Mon compte')
})
