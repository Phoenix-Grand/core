import { useCallback, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../core/api/client'
import { PRIV } from '../core/authz/types'
import { usePrivileges } from '../core/authz/usePrivileges'
import { useModulesStore } from '../core/store/modulesStore'
import { useWsStore } from '../core/store/wsStore'

/**
 * The installed modules, as the administration console reads them.
 *
 * ── One inventory, three readers ─────────────────────────────────────────────
 * The sidebar submenu, the module list and one module's page all describe the
 * same set. They share ONE query key so a toggle made on the page is reflected
 * in the menu without either knowing about the other — and so the browser makes
 * one request, not three.
 *
 * ── Live, without polling ────────────────────────────────────────────────────
 * A module can appear, disappear or fall over while the console is open, and
 * the core already says so: `ModuleRegistered`, `ModuleUnregistered` and
 * `ModuleHealthChanged` reach the browser over the existing WebSocket (see
 * `websocket/hub.rs`). We invalidate on those three rather than poll — the
 * event is already there, and a timer would only add latency and traffic.
 *
 * Two things that channel forces us to be careful about:
 *
 *  • It is broadcast to EVERY signed-in client, not just administrators. So the
 *    subscription is installed only for a caller holding `core.modules.read`;
 *    otherwise an ordinary user would answer a module restart with a burst of
 *    403s on `/admin/modules`.
 *  • A socket that drops loses every event it was not there for. So a
 *    reconnection (`connected` going false → true) resynchronises as well:
 *    without it, a module installed during the outage would stay invisible
 *    until the next full page load.
 */

// A module's PAGES travel with the inventory. The type and the reader live with
// the settings schema they describe — a pure module, so both can be tested
// without dragging the query layer in.
export { groupsOf, type ModuleSettingGroup } from './settings/moduleSettingSchema'
import type { ModuleSettingGroup } from './settings/moduleSettingSchema'

/** One row of `GET /api/v1/admin/modules`. */
export interface AdminModule {
  id:            string
  display_name:  string
  version:       string
  description:   string | null
  is_enabled:    boolean
  installed_at:  string
  /** The module's own USER settings page — never its administration surface. */
  settings_path: string | null
  /**
   * Lucide name of the module's glyph — the icon of its entry point, the same
   * one the shell and the waffle menu show. Served with the inventory so a
   * module that is stopped or switched off still has a face: those are the rows
   * an operator most needs to recognise.
   */
  icon?: string | null
  /**
   * The pages this module's panel is split into, in menu order.
   *
   * Served WITH the inventory rather than fetched per module: the navigation
   * tree grafts every module's groups under it, and asking each module in turn
   * would mean one round trip per installed module just to draw a menu.
   */
  setting_groups?: ModuleSettingGroup[]
}

/** The single cache key of the installed-module inventory. */
export const ADMIN_MODULES_KEY = ['admin-modules'] as const

/** Lifecycle events after which the inventory may have changed. */
const MODULE_EVENTS = new Set(['ModuleRegistered', 'ModuleUnregistered', 'ModuleHealthChanged'])

/**
 * Coalescing window, in ms.
 *
 * Module events arrive in BURSTS, not one at a time: restarting the instance
 * registers two dozen modules within a couple of seconds, and each of the
 * console's readers is subscribed. Without this, one restart means a handful of
 * identical `/admin/modules` requests. One timer at module scope collapses the
 * whole burst — and every subscriber's share of it — into a single refetch,
 * while staying far below what a human reads as a delay.
 */
const COALESCE_MS = 400
let coalesceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The installed modules, kept in step with the instance in real time.
 *
 * Returns an idle query (no request, no data) when the caller may not read
 * modules — every consumer therefore renders its "nothing to show" branch
 * rather than a refusal.
 */
export function useAdminModules() {
  const { can } = usePrivileges()
  const allowed = can(PRIV.MODULES_READ)
  const qc      = useQueryClient()

  useEffect(() => {
    if (!allowed) return
    const resync = () => {
      if (coalesceTimer) clearTimeout(coalesceTimer)
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null
        void qc.invalidateQueries({ queryKey: ADMIN_MODULES_KEY })
      }, COALESCE_MS)
    }
    return useWsStore.subscribe((state, prev) => {
      // Back after an outage: whatever happened meanwhile was never delivered.
      if (state.connected && !prev.connected) { resync(); return }
      if (state.messages.length === prev.messages.length) return
      const last = state.messages[state.messages.length - 1]
      if (last?.type !== 'event') return
      const type = (last.payload as { type?: string } | null)?.type
      if (type && MODULE_EVENTS.has(type)) resync()
    })
  }, [allowed, qc])

  return useQuery({
    queryKey: ADMIN_MODULES_KEY,
    queryFn:  () => api.get<{ modules: AdminModule[] }>('/admin/modules').then(r => r.data.modules),
    enabled:  allowed,
  })
}

/**
 * What a module is doing right now, as three states that must not be merged.
 *
 *  • `disabled`    — an administrator switched it off. A decision, not a fault.
 *  • `unreachable` — it is switched ON and no instance has registered. That is
 *                    an incident: its pages do not open and nobody was told.
 *  • `running`     — enabled, and an instance is serving it.
 *  • `unknown`     — the live registry has not loaded yet. Reported as such so
 *                    that the first second after a page load does not paint
 *                    every module as broken.
 */
export type ModuleLiveState = 'disabled' | 'unreachable' | 'running' | 'unknown'

/**
 * Reads the live state from the registry the shell already holds
 * (`GET /api/v1/modules`, refreshed on the very same lifecycle events by
 * `main.tsx`) — no extra request, and no privilege beyond being signed in.
 */
export function useModuleLiveState(): (module: AdminModule) => ModuleLiveState {
  const active = useModulesStore(s => s.activeModules)
  const ready  = useModulesStore(s => s.modulesReady)
  return useCallback((module: AdminModule): ModuleLiveState => {
    if (!module.is_enabled) return 'disabled'
    if (!ready)             return 'unknown'
    return active.some(a => a.module_id === module.id) ? 'running' : 'unreachable'
  }, [active, ready])
}

/** i18n key of a live state, for a chip or a menu row title. */
export const LIVE_STATE_KEY: Record<ModuleLiveState, string> = {
  disabled:    'admin.m_disabled',
  unreachable: 'admin.m_unreachable',
  running:     'admin.m_running',
  unknown:     'admin.m_running',
}

export interface ToggleResult { id: string; is_enabled: boolean; also_disabled: string[] }

/**
 * Enables or disables a module, optimistically.
 *
 * The flip is applied to the cache before the request leaves — the toggle must
 * not wait on a round trip — and rolled back if the server refuses. Callers add
 * their own `onSuccess`/`onError` at `mutate()` time (React Query runs both).
 */
export function useToggleModule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, is_enabled }: { id: string; is_enabled: boolean }) =>
      api.patch<{ message: string; also_disabled: string[] }>(`/admin/modules/${id}`, { is_enabled })
        .then(r => ({ ...r.data, id, is_enabled }) as ToggleResult),

    onMutate: async ({ id, is_enabled }) => {
      await qc.cancelQueries({ queryKey: ADMIN_MODULES_KEY })
      const previous = qc.getQueryData<AdminModule[]>(ADMIN_MODULES_KEY)
      qc.setQueryData<AdminModule[]>(ADMIN_MODULES_KEY, old =>
        old?.map(m => (m.id === id ? { ...m, is_enabled } : m)) ?? [])
      return { previous }
    },

    onSuccess: (data) => {
      // Cascade: disabling a module disables whatever depends on it.
      if (!data.is_enabled && data.also_disabled.length > 0) {
        qc.setQueryData<AdminModule[]>(ADMIN_MODULES_KEY, old =>
          old?.map(m => (data.also_disabled.includes(m.id) ? { ...m, is_enabled: false } : m)) ?? [])
      }
    },

    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(ADMIN_MODULES_KEY, context.previous)
    },

    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ADMIN_MODULES_KEY })
      void qc.invalidateQueries({ queryKey: ['admin-stats'] })
      void useModulesStore.getState().fetchModules()
    },
  })
}
