import React, { useSyncExternalStore } from 'react'
import { useModulesStore } from '../store/modulesStore'

// ── Change notification ─────────────────────────────────────────────────────────
// Modules register their contributions when their bundle loads, which is usually AFTER the shell's first render
// (and a module may register more later). Whatever renders from these registries subscribes here, so it renders
// again on its own instead of depending on an unrelated re-render of a parent (which a `.kbview` screen, whose
// elements are memoised, does not give its hosted React components the way a TSX parent did).
let registryVersion = 0
const registryListeners = new Set<() => void>()

function registryChanged(): void {
  registryVersion++
  for (const l of [...registryListeners]) l()
}

function subscribeRegistry(listener: () => void): () => void {
  registryListeners.add(listener)
  return () => { registryListeners.delete(listener) }
}

/** Renders the calling component again whenever a slot, an override or a module admin section is (un)registered. */
export function useSlotRegistryVersion(): number {
  return useSyncExternalStore(subscribeRegistry, () => registryVersion, () => registryVersion)
}

// Core reserves these well-known slot names. Modules may use any string as a slot
// name for inter-module contributions (e.g. "files-open-with") - those are defined
// and consumed entirely within module code, not in the core.
export type SlotName =
  // Core shell slots
  | 'sidebar-new-actions'
  | 'topbar-actions'
  | 'settings-sections'
  | 'admin-panels'
  | 'search-providers'
  | 'user-menu-items'
  | 'dashboard-widgets'
  | 'dashboard-stats-cards'
  | 'context-menu-items'
  | 'sidebar-storage'
  | 'help-menu-items'
  | 'header-search'
  | 'header-leading'
  | 'header-actions-right'
  | 'sidebar-footer'
  | 'module-toolbar'
  | 'left-rail-icons'
  | 'right-rail-icons'
  | 'app-dialogs'
  | 'global-services'
  | (string & Record<never, never>) // allow module-defined slot names without losing autocomplete

/**
 * Slot name of a module's own admin page - `/admin/modules/<id>`.
 *
 * The name CARRIES the module id rather than being one shared slot filtered at
 * render time, for two reasons. First, the core must not know that `mail` (or
 * anyone else) contributes an admin view: `ModuleAdminPage` builds the name from
 * the id in the URL, so discovery stays purely dynamic and no module is ever
 * named in core code. Second, a shared `module-admin` slot would render every
 * contributor on every module's page unless the consumer filtered them, and a
 * filter that is easy to forget is a leak waiting to happen - here a wrong id
 * simply means nothing is registered under that name.
 *
 * A module registers with its own id on both sides:
 *   SlotRegistry.register(moduleAdminSlot('mail'), 'mail', MailAdminPanel)
 */
export const moduleAdminSlot = (moduleId: string): SlotName => `module-admin:${moduleId}`

/**
 * A view a module contributes to its OWN admin page, and WHERE it belongs.
 *
 * ── Why the placement travels with the contribution ──────────────────────────
 * `module-admin:<id>` alone answers "who renders something here"; it cannot
 * answer "on which page, and under which tab", which is the only question left
 * once a module's panel is more than one page. The module is the one that knows -
 * it declared those pages itself, in its manifest - so it says so here, with
 * the same vocabulary: `group` is a `[[setting_groups]]` id of that module.
 *
 * ── The two ways a section shows up ──────────────────────────────────────────
 *  • WITHOUT a label - rendered inline at the top of its group's page, above
 *    the tabs. That is for what has to be read before anything is changed: a
 *    diagnostic, a status. It competes with nothing.
 *  • WITH a label - a tab of its own, sitting next to the tabs the settings'
 *    `category` produce. That is for a surface as large as a settings page and
 *    as unrelated to it as a key store.
 *
 * ── Degrading, never breaking ────────────────────────────────────────────────
 * A section naming a group the module does not declare, or naming none at all,
 * is not dropped: it renders on the module's FIRST page. Losing a diagnostic
 * because a manifest was renamed would be far worse than showing it one page
 * early - and the module keeps working while its two halves are out of step.
 */
export interface ModuleAdminSection {
  /** The contributing module. Its page is `/admin/modules/<moduleId>`. */
  moduleId: string
  /** Stable, untranslated id - unique per module. Also the tab id. */
  id:       string
  /** `[[setting_groups]]` id of that module. Absent = its first page. */
  group?:   string
  /** Already-translated tab label. Absent = inline, above the tabs. */
  label?:   string
  /**
   * i18n key of the label, preferred over `label` when both are given: it is
   * resolved at RENDER time, so the tab follows a change of language instead of
   * keeping whatever the language was when the module registered.
   */
  labelKey?: string
  /** Lucide icon name for the tab; unknown names simply show none. */
  icon?:    string
  /** Order among the contributed items of the same page (lower first). */
  position?: number
  Component: React.ComponentType
}

const moduleAdminSections: ModuleAdminSection[] = []

export const ModuleAdminRegistry = {
  /**
   * Declares one section of the module's own admin page. Re-registering the
   * same `moduleId` + `id` REPLACES the previous one, so a module bundle that
   * is evaluated twice (hot reload, a remount) does not draw its panel twice.
   */
  register(section: ModuleAdminSection) {
    const i = moduleAdminSections.findIndex(
      s => s.moduleId === section.moduleId && s.id === section.id,
    )
    if (i >= 0) moduleAdminSections[i] = section
    else moduleAdminSections.push(section)
    registryChanged()
  },

  /** What `moduleId` contributes, in display order. */
  sectionsFor(moduleId: string): ModuleAdminSection[] {
    return moduleAdminSections
      .filter(s => s.moduleId === moduleId)
      .sort((a, b) => (a.position ?? 100) - (b.position ?? 100))
  },
}

interface SlotEntry {
  moduleId: string
  Component: React.ComponentType
  /** Optional applicability predicate. When given, the slot's consumer can leave
   *  out the contributors that do not apply to a given context (e.g.
   *  "files-open-with": keep only the modules able to open the file at hand).
   *  The argument is defined by the slot's consumer. */
  match?: (arg?: unknown) => boolean
}

interface OverrideEntry {
  moduleId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Component: React.ComponentType<any>
}

const registry  = new Map<SlotName, SlotEntry[]>()
const overrides = new Map<string, OverrideEntry>()

export const SlotRegistry = {
  register(slot: SlotName, moduleId: string, Component: React.ComponentType, match?: (arg?: unknown) => boolean) {
    if (!registry.has(slot)) registry.set(slot, [])
    registry.get(slot)!.push({ moduleId, Component, match })
    registryChanged()
  },

  getSlot(slot: SlotName): SlotEntry[] {
    return registry.get(slot) ?? []
  },

  /** Whether at least one ACTIVE module contributes to `slot` - the same
   *  filtering `<Slot>` applies, exposed so a page can decide its layout BEFORE
   *  rendering (e.g. not claiming a module has nothing to configure when it
   *  does contribute a section of its own). */
  hasActive(slot: SlotName, activeIds: Set<string>): boolean {
    return (registry.get(slot) ?? []).some(e => activeIds.has(e.moduleId))
  },

  // Register a component that replaces a built-in component from another module.
  // The replacement is only used when `moduleId` appears in the active modules list.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerOverride(key: string, moduleId: string, Component: React.ComponentType<any>) {
    overrides.set(key, { moduleId, Component })
    registryChanged()
  },

  // Returns the override component if its owning module is active, otherwise null.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getActiveOverride<T = Record<string, unknown>>(key: string, activeIds: Set<string>): React.ComponentType<T> | null {
    const entry = overrides.get(key)
    if (!entry || !activeIds.has(entry.moduleId)) return null
    return entry.Component as React.ComponentType<T>
  },

  unregisterModule(moduleId: string) {
    for (const [slot, entries] of registry) {
      registry.set(slot, entries.filter((e) => e.moduleId !== moduleId))
    }
    for (const [key, entry] of overrides) {
      if (entry.moduleId === moduleId) overrides.delete(key)
    }
    settingsRoutes.delete(moduleId)
    for (let i = notifGroups.length - 1; i >= 0; i--) {
      if (notifGroups[i].moduleId === moduleId) notifGroups.splice(i, 1)
    }
    for (let i = moduleAdminSections.length - 1; i >= 0; i--) {
      if (moduleAdminSections[i].moduleId === moduleId) moduleAdminSections.splice(i, 1)
    }
    registryChanged()
  },
}

// ── Per-module settings (admin global + per-user) ───────────────────────────────
// Each module exposes up to two settings pages:
//   • admin → instance-wide settings, admin only      (default `/<moduleId>/settings`)
//   • user  → per-user settings + overrides           (default `/<moduleId>/user-settings`)
// The header gear button routes to the USER page whenever the user is inside that
// module's routes. Resolution is keyed by the CURRENT route's module (not a global
// slot), so it scales to every module.
interface SettingsRoutes {
  admin?: string
  user?:  string
}
const settingsRoutes = new Map<string, SettingsRoutes>()

function setRoute(moduleId: string, patch: SettingsRoutes) {
  settingsRoutes.set(moduleId, { ...settingsRoutes.get(moduleId), ...patch })
  registryChanged()
}

export const ModuleSettingsRegistry = {
  /** Legacy: declare the module's per-user settings route (default `/<moduleId>/settings`).
   *  Kept for modules not yet migrated to the admin/user split. */
  register(moduleId: string, route?: string) {
    setRoute(moduleId, { user: route ?? `/${moduleId}/settings` })
  },
  /** Declare the module's admin (instance-wide) settings route. */
  registerAdmin(moduleId: string, route?: string) {
    setRoute(moduleId, { admin: route ?? `/${moduleId}/settings` })
  },
  /** Declare the module's per-user settings route. */
  registerUser(moduleId: string, route?: string) {
    setRoute(moduleId, { user: route ?? `/${moduleId}/user-settings` })
  },
  /** Per-user settings route for `moduleId` if registered and active, else null.
   *  This is what the header gear button navigates to. */
  getRoute(moduleId: string | undefined, activeIds: Set<string>): string | null {
    if (!moduleId) return null
    const route = settingsRoutes.get(moduleId)?.user
    return route && activeIds.has(moduleId) ? route : null
  },
  /** Admin (instance-wide) settings route for `moduleId` if registered and active. */
  getAdminRoute(moduleId: string | undefined, activeIds: Set<string>): string | null {
    if (!moduleId) return null
    const route = settingsRoutes.get(moduleId)?.admin
    return route && activeIds.has(moduleId) ? route : null
  },
  /** Whether `pathname` is a registered settings page (full-bleed, no toolbar). */
  isSettingsRoute(pathname: string): boolean {
    for (const r of settingsRoutes.values()) {
      if (r.admin === pathname || r.user === pathname) return true
    }
    return false
  },
}

// ── Notification activity registry ──────────────────────────────────────────────
// Any module that emits notifications declares one or more activity groups; they
// are rendered as an E-mail/Push matrix in the core Settings → Notifications tab.
// The user's per-activity choices are stored in `users.preferences.notifications`.
export interface NotifActivity {
  /** Stable id, unique within the group. */
  id: string
  /** Human label (already translated; modules pass `t(..., { defaultValue })`). */
  label: string
  /** Default channel states when the user hasn't chosen yet. */
  emailDefault?: boolean
  pushDefault?: boolean
}
export interface NotifGroup {
  /** Owning module ('core' = always shown; others shown only when the module is active). */
  moduleId: string
  /** Group heading (e.g. "Tâches"). */
  title: string
  /** Sort order among groups (lower first; default 100). */
  order?: number
  activities: NotifActivity[]
}

const notifGroups: NotifGroup[] = []

export const NotificationRegistry = {
  /** Register (or replace, by moduleId+title) a notification activity group. */
  register(group: NotifGroup) {
    const i = notifGroups.findIndex(g => g.moduleId === group.moduleId && g.title === group.title)
    if (i >= 0) notifGroups[i] = group
    else notifGroups.push(group)
    registryChanged()
  },
  /** Groups to display: core groups always, module groups only when active. */
  getGroups(activeIds: Set<string>): NotifGroup[] {
    return notifGroups
      .filter(g => g.moduleId === 'core' || activeIds.has(g.moduleId))
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
  },
}

interface SlotProps {
  name: SlotName
  fallback?: React.ReactNode
  /* Rendering context passed to the modules' contributions - notably `dark`, so
   * that a top bar button adapts to the tinted bars of ribbon applications instead
   * of drawing unreadable dark text there. A module ignoring these props is not
   * affected. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [prop: string]: any
}

/** Reactive counterpart of `SlotRegistry.hasActive` - re-evaluated whenever the
 *  active module list changes, so a page laid out around a contribution follows
 *  a module being switched off. */
export function useHasSlot(name: SlotName): boolean {
  useSlotRegistryVersion()
  const activeModules = useModulesStore(s => s.activeModules)
  return SlotRegistry.hasActive(name, new Set(activeModules.map(m => m.module_id)))
}

/**
 * The sections `moduleId` contributes to its own admin page - `[]` while the
 * module is switched off, like every other slot: a disabled module's bundle may
 * still be loaded in this tab, and rendering its panel would say it is running.
 */
export function useModuleAdminSections(moduleId: string): ModuleAdminSection[] {
  useSlotRegistryVersion()
  const activeModules = useModulesStore(s => s.activeModules)
  const active = activeModules.some(m => m.module_id === moduleId)
  return active ? ModuleAdminRegistry.sectionsFor(moduleId) : []
}

/**
 * Renders what the active modules contribute to `name`. It subscribes to the registry: a contribution registered
 * after the first render (a module bundle loaded later) shows up without anything else rendering again.
 */
export function Slot({ name, fallback, ...ctx }: SlotProps) {
  useSlotRegistryVersion()
  const activeModules = useModulesStore(s => s.activeModules)
  const activeIds = new Set(activeModules.map(m => m.module_id))

  const entries = SlotRegistry.getSlot(name).filter(e => activeIds.has(e.moduleId))
  if (entries.length === 0) return <>{fallback}</>
  return (
    <>
      {/* A module may contribute several components to one slot (drive: open, save, folder picker…): the key
          is the module and the rank of its contribution, unique and stable while the module stays loaded. */}
      {entries.map(({ moduleId, Component }, k) => (
        <Component key={`${moduleId}:${entries.slice(0, k).filter(e => e.moduleId === moduleId).length}`} {...ctx} />
      ))}
    </>
  )
}
