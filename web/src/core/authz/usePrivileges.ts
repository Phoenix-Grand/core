import { useCallback, useEffect, useMemo } from 'react'
import { useAuthStore } from '../store/authStore'
import type { CanFn } from './types'

/**
 * The caller's own effective privileges, and the single `can()` predicate the
 * whole console is derived from.
 *
 * ── Where the data comes from ────────────────────────────────────────────────
 * `GET /api/v1/me` carries a `privileges` block: the caller's effective
 * privileges with their scopes resolved, and the super-user flag. It is
 * information about oneself, so it demands no privilege - and it is narrowed to
 * what the *presented credential* may exercise, so an interface driven by a
 * scoped API token offers exactly the actions the server will accept.
 *
 * It used to be read from `GET /admin/users/:id/privileges` instead, which
 * requires `core.roles.read`. Two things followed, and both are gone: a
 * delegated administrator who did not also hold that key read back a 403 and was
 * shown no console at all, and every ordinary user provoked one failing request
 * per page load.
 *
 * ── What it costs ────────────────────────────────────────────────────────────
 * Nothing on a page load: `initialize()` already reads `/me` and keeps the block.
 * The store only issues a request on the paths that obtain a user without going
 * through it (signing in, the OAuth callback).
 */
export interface PrivilegeApi {
  /** Holds `key` anywhere (no unit), or over `unit` when one is given. */
  can: CanFn
  /** Holds every privilege, present and future. */
  isSuperuser: boolean
  /** May enter the administration surface at all (super-user or holds ≥ 1). */
  isAdmin: boolean
  /** The caller's own organisational unit, when they sit in one. */
  orgUnitId: string | null
  /** True while the resolution is still in flight (no verdict yet). */
  isLoading: boolean
}

interface Resolved {
  instance: boolean
  units:    Set<string>
}

export function usePrivileges(): PrivilegeApi {
  const user           = useAuthStore(s => s.user)
  const privileges     = useAuthStore(s => s.privileges)
  const loadPrivileges = useAuthStore(s => s.loadPrivileges)

  // Signed in but no block yet: fetch it once (the store deduplicates).
  useEffect(() => {
    if (user && !privileges) void loadPrivileges()
  }, [user, privileges, loadPrivileges])

  const map = useMemo(() => {
    const out = new Map<string, Resolved>()
    for (const p of privileges?.privileges ?? []) {
      out.set(p.key, { instance: p.instance, units: new Set(p.org_units) })
    }
    return out
  }, [privileges])

  const denied = useMemo(
    () => new Set(privileges?.denied ?? []),
    [privileges],
  )

  const isSuperuser = !!privileges?.is_superuser

  const can = useCallback<CanFn>(
    (key, unit) => {
      // Mirrors `AdminContext::has_for_unit` server-side, deny-list included: a
      // legacy API token keeps its owner's super-user flag and still may not
      // exercise the keys reserved to a person.
      if (denied.has(key)) return false
      if (isSuperuser) return true
      const held = map.get(key)
      if (!held) return false
      if (held.instance) return true
      // No unit asked for → "do they hold it anywhere?".
      if (unit === undefined) return true
      // An account in no unit is reachable at instance scope only - the same
      // default the server refuses to flip (see `PrivilegeScope::covers`).
      return unit !== null && held.units.has(unit)
    },
    [denied, isSuperuser, map],
  )

  return {
    can,
    isSuperuser,
    isAdmin:   !!privileges?.is_admin,
    orgUnitId: privileges?.org_unit_id ?? user?.org_unit_id ?? null,
    isLoading: !!user && !privileges,
  }
}
