import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// `@ui` first, as the host does (`viewsHost`): it reaches the core's stores, which reach the shell and these
// user controls - evaluated last, the controls find their base classes and components ready.
import '@ui'
import WaffleMenu from './WaffleMenu'
import AccountMenu from './AccountMenu'
import type { AccountEntry, LauncherApp } from './model'

// jsdom lacks ResizeObserver (the launcher measures its scroll bar's gutter with one).
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(async () => {
  // No dictionary: `{Res}` and `t()` show their keys, `t(key, { defaultValue })` its default.
  await i18n.init({ lng: 'fr', resources: {} })
})
afterEach(() => cleanup())

const apps: LauncherApp[] = [
  { id: 'drive', label: 'Drive', icon: 'FolderOpen', href: '/drive' },
  { id: 'mail', label: 'Mail', icon: 'Mail', href: '/mail' },
  { id: 'notes', label: 'Notes', icon: 'StickyNote', href: '/notes' },
  { id: 'docs', label: 'Documents', module: 'office', moduleLabel: 'Office' },
  { id: 'sheets', label: 'Tableur', module: 'office', moduleLabel: 'Office' },
]

describe('WaffleMenu (user control)', () => {
  it('launches an app, edits the favourites and keeps the ids it does not know', async () => {
    const events: unknown[] = []
    render(createElement(WaffleMenu, {
      apps,
      // `calendar` is no app of this launcher: an « OK » must not drop it.
      favorites: ['drive', 'calendar'],
      showMarketplace: true,
      marketplaceHref: '/admin/marketplace',
      onAppLaunched: (e: unknown) => events.push(['launch', e]),
      onEditModeChanged: (e: unknown) => events.push(['edit', e]),
      onFavoritesEdited: (e: unknown) => events.push(['saved', e]),
      onOpenMarketplace: () => events.push(['marketplace']),
    }))
    // The card shows the known favourite; the others are listed, the module's apps grouped.
    expect(screen.getByText('shell.favorites')).toBeTruthy()
    expect(screen.getByText('Office')).toBeTruthy()
    const drive = screen.getByText('Drive').closest('a')!
    expect(drive.getAttribute('href')).toBe('/drive')
    await act(async () => fireEvent.click(drive))
    expect(events).toContainEqual(['launch', { id: 'drive' }])
    await act(async () => fireEvent.click(screen.getByText('shell.more_modules')))
    expect(events).toContainEqual(['marketplace'])

    // The pencil starts the edit mode: Annuler / OK and the help line replace the title.
    await act(async () => fireEvent.click(document.querySelector('svg.lucide-pencil')!.closest('button')!))
    expect(events).toContainEqual(['edit', { editing: true }])
    expect(screen.getByText('shell.drag_apps')).toBeTruthy()
    expect(screen.queryByText('shell.more_modules')).toBeNull()
    // A click on another app adds it; OK saves the shown ones, then the unknown id.
    await act(async () => fireEvent.click(screen.getByText('Notes')))
    await act(async () => fireEvent.click(screen.getByText('shell.ok')))
    expect(events).toContainEqual(['saved', { favorites: ['drive', 'notes', 'calendar'] }])
    expect(events).toContainEqual(['edit', { editing: false }])
  })

  it('reorders a favourite dropped on another one', async () => {
    let saved: unknown
    render(createElement(WaffleMenu, { apps, favorites: ['drive', 'mail', 'notes'], onFavoritesEdited: (e: unknown) => { saved = e } }))
    await act(async () => fireEvent.click(document.querySelector('svg.lucide-pencil')!.closest('button')!))
    const tiles = () => [...document.querySelectorAll('[draggable="true"]')] as HTMLElement[]
    // jsdom has no DataTransfer: the grid only stores and reads the dragged id.
    const store: Record<string, string> = {}
    const dt = { effectAllowed: '', dropEffect: '', setData: (k: string, v: string) => { store[k] = v }, getData: (k: string) => store[k] ?? '' }
    await act(async () => { fireEvent.dragStart(tiles()[2], { dataTransfer: dt }) })
    await act(async () => { fireEvent.dragOver(tiles()[0], { dataTransfer: dt }) })
    await act(async () => { fireEvent.drop(tiles()[0], { dataTransfer: dt }) })
    await act(async () => fireEvent.click(screen.getByText('shell.ok')))
    expect(saved).toEqual({ favorites: ['notes', 'drive', 'mail'] })
  })
})

const accounts: AccountEntry[] = [
  { id: '2', name: "Bob O'Brien", email: 'bob@kubuno.local', server: 'kubuno.local', connected: true, unread: 3 },
  { id: '3', name: 'Zoé Martin', email: 'zoe@kubuno.local', server: 'kubuno.local', connected: false },
  { id: 'r1', name: 'Camille', email: 'camille@asso.org', server: 'kubuno.asso.org', connected: true, remote: true },
]

describe('AccountMenu (user control)', () => {
  it('lists the other accounts and raises an event for every click', async () => {
    const events: unknown[] = []
    const on = (name: string) => (e?: unknown) => events.push(e === undefined ? [name] : [name, e])
    render(createElement(AccountMenu, {
      user: { name: 'Camille Durand', email: 'camille@kubuno.local', initials: 'CD' },
      accounts,
      showAdmin: true,
      manageHref: '/settings', labelsHref: '/labels', adminHref: '/admin',
      onOpenAccount: on('open'), onRemoveAccount: on('remove'), onManageAccount: on('manage'), onAddAccount: on('add'),
      onOpenLabels: on('labels'), onOpenAdmin: on('admin'), onSignOut: on('signout'), onChangeAvatar: on('avatar'),
      onCloseRequested: on('close'),
    }))
    // Rows: a live session (a button, its unread count), a dead one, another instance's.
    const bob = screen.getByText("Bob O'Brien").closest('button')!
    expect(bob.textContent).toContain('3')
    await act(async () => fireEvent.click(bob))
    expect(screen.getByText('Déconnecté')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText('Connexion')))
    expect(screen.getByText('kubuno.asso.org')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByText('Ouvrir')))
    await act(async () => fireEvent.click(screen.getAllByText('Supprimer')[1]))
    expect(events.slice(0, 4)).toEqual([['open', { id: '2' }], ['open', { id: '3' }], ['open', { id: 'r1' }], ['remove', { id: 'r1' }]])

    // The links keep their addresses; a plain click is the host's to act on.
    expect(screen.getByText('shell.manage_account').closest('a')!.getAttribute('href')).toBe('/settings')
    await act(async () => fireEvent.click(screen.getByText('shell.manage_account')))
    await act(async () => fireEvent.click(screen.getByText('Étiquettes')))
    await act(async () => fireEvent.click(screen.getByText('user.admin')))
    await act(async () => fireEvent.click(screen.getByText('shell.add_account')))
    await act(async () => fireEvent.click(screen.getByText('Se déconnecter de tous les comptes')))
    await act(async () => fireEvent.click(screen.getByLabelText('shell.change_photo')))
    expect(events.slice(4)).toEqual([['manage'], ['labels'], ['admin'], ['add'], ['signout'], ['avatar']])

    // The accounts card folds, showing the first accounts' initials.
    await act(async () => fireEvent.click(screen.getByText('shell.hide_more_accounts')))
    expect(screen.getByText('shell.show_more_accounts')).toBeTruthy()
    expect(screen.queryByText("Bob O'Brien")).toBeNull()
    expect(screen.getByText('B')).toBeTruthy()
  })

  it('without other accounts: no accounts card, a plain sign-out', () => {
    render(createElement(AccountMenu, { user: { name: 'Camille', email: 'c@k.local', initials: 'CA' }, accounts: [] }))
    expect(screen.queryByText('shell.hide_more_accounts')).toBeNull()
    expect(screen.getByText('user.logout')).toBeTruthy()
    expect(screen.queryByText('user.admin')).toBeNull()
  })
})
