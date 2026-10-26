import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { invalidateResources, setResourceResolver } from '@kubuno/views'
import en from '../../core/i18n/locales/en/core.json'
import fr from '../../core/i18n/locales/fr/core.json'
import { api } from '../../core/api/client'
import MarketplacePanel from './MarketplacePanel'

vi.mock('../../core/api/client', () => ({ api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }))
vi.mock('../../core/store/modulesStore', () => ({ useModulesStore: { getState: () => ({ fetchModules: vi.fn() }) } }))

const module = {
  id: 'drive', name: 'Drive', version: '1.0', official: true, category: 'Bureautique',
  summary: 'Stockage de fichiers', tags: [], installed: false, installed_version: null, removable: false,
  localizations: { en: { summary: 'File storage and sharing.' }, fr: { summary: 'Stockage et partage de fichiers.' } },
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

async function mount() {
  const i18n = createInstance()
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, fr: { translation: fr } } })
  setResourceResolver(key => i18n.t(key))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<I18nextProvider i18n={i18n}><QueryClientProvider client={client}>
    <MarketplacePanel onBack={() => {}} />
  </QueryClientProvider></I18nextProvider>)
  await screen.findByText('File storage and sharing.')
  const change = async (lng: string) => act(async () => { await i18n.changeLanguage(lng); invalidateResources() })
  return { change, client }
}

it('renders translated catalog data and switches English/French without refetching or regrouping', async () => {
  vi.mocked(api.get).mockResolvedValue({ data: { modules: [module] } })
  const { change, client } = await mount()
  expect(screen.getByRole('heading', { name: 'Office' })).toBeInTheDocument()
  const requests = vi.mocked(api.get).mock.calls.length
  await change('fr')
  expect(screen.getByText('Stockage et partage de fichiers.')).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Bureautique' })).toBeInTheDocument()
  await change('en')
  expect(screen.getByText('File storage and sharing.')).toBeInTheDocument()
  expect(vi.mocked(api.get).mock.calls.length).toBe(requests)
  expect(screen.getAllByText('Drive')).toHaveLength(1)
  client.clear()
})

it('translates an API failure while keeping its original diagnostic details accessible', async () => {
  vi.mocked(api.get).mockResolvedValue({ data: { modules: [module] } })
  vi.mocked(api.post).mockRejectedValue({ code: 'FORBIDDEN', message: 'Diagnostic serveur original' })
  const { change, client } = await mount()
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await screen.findByText(en.admin.mk_error_forbidden)
  expect(api.post).toHaveBeenCalledWith('/admin/marketplace/drive/install')
  expect(screen.getByText('Technical details')).toBeInTheDocument()
  expect(screen.getByText('Diagnostic serveur original').closest('details')).not.toHaveAttribute('open')
  await change('fr')
  expect(screen.getByText(fr.admin.mk_error_forbidden)).toBeInTheDocument()
  expect(screen.getByText('Détails techniques')).toBeInTheDocument()
  client.clear()
})

it('updates active progress and the completed notification when language changes', async () => {
  let finish = false
  vi.mocked(api.get).mockImplementation(async url => ({ data: String(url).endsWith('/status')
    ? { progress: finish
      ? { phase: 'done', report: { name: 'Drive', version: '1.0', started: true } }
      : { phase: 'extracting', message: 'Extraction du paquet…' } }
    : { modules: [module] } }))
  vi.mocked(api.post).mockResolvedValue({ data: { status: 'started' } })
  const { change, client } = await mount()
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await screen.findByText('Extracting package…', {}, { timeout: 2500 })
  await change('fr')
  expect(screen.getByText('Extraction du paquet…')).toBeInTheDocument()
  finish = true
  await waitFor(() => expect(screen.getByText('« Drive » v1.0 installé et démarré.')).toBeInTheDocument(), { timeout: 2500 })
  await change('en')
  expect(screen.getByText('“Drive” v1.0 installed and started.')).toBeInTheDocument()
  client.clear()
})
