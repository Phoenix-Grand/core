import { fireEvent, render, screen } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import en from '../../core/i18n/locales/en/core.json'
import { GroupForm } from './GroupsPanel.parts'

beforeAll(() => vi.stubGlobal('matchMedia', (media: string) => ({
  matches: false, media, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {},
})))
afterAll(() => vi.unstubAllGlobals())

const group = {
  id: 'system-group', name: 'Utilisateurs', description: 'Groupe de base — tous les nouveaux utilisateurs',
  is_system: true, is_default: true, permissions: ['api_tokens.create'], release_exempt: false,
}

async function form(initial: typeof group | undefined = group) {
  const i18n = createInstance()
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } })
  const onSave = vi.fn()
  render(<I18nextProvider i18n={i18n}><GroupForm initial={initial} onSave={onSave} onCancel={() => {}} /></I18nextProvider>)
  return onSave
}

it('shows English defaults and omits untouched metadata when saving another property', async () => {
  const save = await form()
  expect(screen.getByRole('textbox', { name: en.admin.g_name })).toHaveValue('Users')
  expect(screen.getByRole('textbox', { name: en.admin.g_description })).toHaveValue('Base group — all new users')
  fireEvent.click(screen.getByRole('checkbox', { name: en.admin.g_release_exempt + en.admin.g_release_exempt_desc }))
  fireEvent.click(screen.getByRole('button', { name: en.settings.save }))
  expect(save).toHaveBeenCalledWith({ permissions: ['api_tokens.create'], is_default: true, release_exempt: true })
})

it('saves a changed description without rewriting the untouched French name', async () => {
  const save = await form()
  fireEvent.change(screen.getByRole('textbox', { name: en.admin.g_description }), { target: { value: 'Custom description' } })
  fireEvent.click(screen.getByRole('button', { name: en.settings.save }))
  expect(save.mock.calls[0][0]).toMatchObject({ description: 'Custom description' })
  expect(save.mock.calls[0][0]).not.toHaveProperty('name')
})

it('keeps deliberately cleared descriptions and explicitly entered names', async () => {
  const save = await form()
  fireEvent.change(screen.getByRole('textbox', { name: en.admin.g_description }), { target: { value: '' } })
  fireEvent.change(screen.getByRole('textbox', { name: en.admin.g_name }), { target: { value: 'Utilisateurs' } })
  fireEvent.click(screen.getByRole('button', { name: en.settings.save }))
  expect(save.mock.calls[0][0]).toMatchObject({ name: 'Utilisateurs', description: '' })
})

it('submits the entered text for a newly created group', async () => {
  const i18n = createInstance()
  await i18n.init({ lng: 'en', resources: { en: { translation: en } } })
  const save = vi.fn()
  render(<I18nextProvider i18n={i18n}><GroupForm onSave={save} onCancel={() => {}} /></I18nextProvider>)
  fireEvent.change(screen.getByRole('textbox', { name: en.admin.g_name }), { target: { value: 'Notre équipe' } })
  fireEvent.click(screen.getByRole('button', { name: en.settings.save }))
  expect(save.mock.calls[0][0]).toMatchObject({ name: 'Notre équipe', description: '' })
})
