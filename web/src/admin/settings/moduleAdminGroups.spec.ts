// Addressing a module's PAGES — the third path segment of
// `/admin/modules/<module>/<group>`.
//
// This is the one place in the console where a pane is not in a closed list:
// the pages belong to the module, which declares them in its own manifest, so
// the core cannot enumerate them without naming modules. What the tests below
// pin is that deferring the VOCABULARY did not defer the SHAPE — the second
// segment is still the record and only the record, and a page id nobody
// declares still resolves to something rather than to a blank page.
import { describe, expect, it } from 'vitest'
import { adminPath, buildAdminUrl, placeFromPath } from '../adminRoute'
import { groupsOf, type ModuleSettingGroup } from './moduleSettingSchema'

/** Just the part of an inventory row these tests are about. */
const module = (setting_groups?: ModuleSettingGroup[]) => ({ setting_groups })

describe('placeFromPath — a module and its pages', () => {
  it('reads the module alone, with no page', () => {
    expect(placeFromPath('/admin/modules/mail'))
      .toEqual({ tab: 'modules', entity: 'mail', pane: null })
  })

  it('reads a page the core has never heard of', () => {
    expect(placeFromPath('/admin/modules/mail/authentication'))
      .toEqual({ tab: 'modules', entity: 'mail', pane: 'authentication' })
  })

  it('never turns the record into a page', () => {
    // The very risk `dynamicPanes` is confined to third position to avoid: this
    // must stay the module `authentication`, not the page of no module.
    expect(placeFromPath('/admin/modules/authentication'))
      .toEqual({ tab: 'modules', entity: 'authentication', pane: null })
  })

  it('leaves a closed-list section alone', () => {
    // `users` declares its panes; an unlisted one is still dropped there.
    expect(placeFromPath('/admin/users/u-1/security'))
      .toEqual({ tab: 'users', entity: 'u-1', pane: 'security' })
    expect(placeFromPath('/admin/users/u-1/nawak'))
      .toEqual({ tab: 'users', entity: 'u-1', pane: null })
  })
})

describe('adminPath / buildAdminUrl — the same declaration, writing', () => {
  it('spells a page under its module', () => {
    expect(adminPath('modules', 'mail', 'filtering')).toBe('/admin/modules/mail/filtering')
    expect(buildAdminUrl({ tab: 'modules', params: { module: 'mail', pane: 'filtering' } }))
      .toBe('/admin/modules/mail/filtering')
  })

  it('refuses a page with no module to hang it on', () => {
    // Writing `/admin/modules/filtering` would mint an address that reads back
    // as the MODULE `filtering`. The pane is dropped instead.
    expect(adminPath('modules', null, 'filtering')).toBe('/admin/modules')
    expect(buildAdminUrl({ tab: 'modules', params: { pane: 'filtering' } }))
      .toBe('/admin/modules?pane=filtering')
  })

  it('round-trips', () => {
    const url = adminPath('modules', 'mail', 'transport')
    expect(placeFromPath(url)).toEqual({ tab: 'modules', entity: 'mail', pane: 'transport' })
  })

  it('still refuses an undeclared pane on a closed-list section', () => {
    expect(adminPath('users', 'u-1', 'nawak')).toBe('/admin/users/u-1')
  })
})

describe('groupsOf — what the inventory says a module is split into', () => {
  const groups = [
    { id: 'overview', label: "Vue d'ensemble" },
    { id: 'services', label: 'Services et ports' },
  ]

  it('reads the declared pages, in the order they arrive', () => {
    expect(groupsOf(module(groups)).map(g => g.id))
      .toEqual(['overview', 'services'])
  })

  it('reads a module that declares none as ungrouped', () => {
    expect(groupsOf(module())).toEqual([])
    expect(groupsOf(module([]))).toEqual([])
    expect(groupsOf(null)).toEqual([])
  })

  it('tolerates the other spelling of the field', () => {
    expect(groupsOf({ groups }).map(g => g.id)).toEqual(['overview', 'services'])
  })

  it('drops an entry with no id — it could not be addressed', () => {
    const broken = [{ id: '', label: 'Sans adresse' }, ...groups]
    expect(groupsOf(module(broken)).map(g => g.id))
      .toEqual(['overview', 'services'])
  })
})

describe('a page id that no longer exists', () => {
  const groups = [
    { id: 'overview', label: "Vue d'ensemble" },
    { id: 'services', label: 'Services et ports' },
  ]

  /** What `ModuleAdminPage` resolves the address to. */
  const resolve = (pane: string) => groups.find(g => g.id === pane) ?? groups[0] ?? null

  it('falls back to the first page rather than showing nothing', () => {
    // A bookmark taken before the page was renamed or merged away.
    expect(resolve('quotas')?.id).toBe('overview')
    expect(resolve('')?.id).toBe('overview')
  })

  it('opens the page that was asked for when it does exist', () => {
    expect(resolve('services')?.id).toBe('services')
  })
})
