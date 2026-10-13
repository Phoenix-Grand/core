// Resolving the identifiers a scope names, and estimating how many accounts it
// covers.
//
// ── An estimate, and it says so ──────────────────────────────────────────────
// The server exposes no "how many accounts does this scope cover" endpoint, so
// the console evaluates `Scope::covers` over the accounts it was able to load
// (200 at most) and reports `partial` when the instance holds more. A count
// presented as a measurement when it is a sample is exactly the kind of number
// an operator over-trusts — so the caveat travels with the number.

import { useMemo } from 'react'
import { useGroupMembers, useGroupsLite, useOrgUnits, useUsersLite } from './api'
import type { Scope, ScopeRef } from './types'

export interface Directory {
  units:  { id: string; name: string; parent_id: string | null }[]
  groups: { id: string; name: string; member_count: number }[]
  users:  { id: string; username: string; display_name: string | null; email: string; org_unit_id: string | null }[]
  totalUsers: number
  /** Fewer accounts were loaded than the instance holds. */
  partial: boolean
  unitName:  (id: string) => string | undefined
  groupName: (id: string) => string | undefined
  userName:  (id: string) => string | undefined
  /** Ancestor chain of a unit, itself first — mirrors `Subject::unit_chain`. */
  unitChain: (id: string | null) => string[]
  isLoading: boolean
  /** The caller may not read the directory (403): names degrade to raw ids. */
  denied: boolean
}

export function useDirectory(enabled = true): Directory {
  const units  = useOrgUnits(enabled)
  const groups = useGroupsLite(enabled)
  const users  = useUsersLite(enabled)

  const unitById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; parent_id: string | null }>()
    for (const u of units.data ?? []) m.set(u.id, u)
    return m
  }, [units.data])

  const groupById = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of groups.data ?? []) m.set(g.id, g.name)
    return m
  }, [groups.data])

  const userById = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of users.data?.users ?? []) m.set(u.id, u.display_name || u.username || u.email)
    return m
  }, [users.data])

  const unitChain = useMemo(() => (id: string | null): string[] => {
    const chain: string[] = []
    let cursor = id
    // Bounded by the map size: a cycle in the tree must not hang the console.
    while (cursor && !chain.includes(cursor) && chain.length < 64) {
      chain.push(cursor)
      cursor = unitById.get(cursor)?.parent_id ?? null
    }
    return chain
  }, [unitById])

  return {
    units:  units.data ?? [],
    groups: groups.data ?? [],
    users:  users.data?.users ?? [],
    totalUsers: users.data?.total ?? 0,
    partial: (users.data?.total ?? 0) > (users.data?.users.length ?? 0),
    unitName:  (id) => unitById.get(id)?.name,
    groupName: (id) => groupById.get(id),
    userName:  (id) => userById.get(id),
    unitChain,
    isLoading: units.isLoading || groups.isLoading || users.isLoading,
    denied: units.isError || groups.isError || users.isError,
  }
}

/** `Scope::covers`, evaluated in the browser over one subject. */
function covers(scope: Scope, subject: { userId: string; chain: string[]; groups: string[] }): boolean {
  const hit = (r: ScopeRef): boolean => {
    if (r.type === 'user')  return r.id === subject.userId
    if (r.type === 'group') return subject.groups.includes(r.id)
    return r.descendants === false
      ? subject.chain[0] === r.id
      : subject.chain.includes(r.id)
  }
  // Exclusion first, and unconditionally: an exception is a promise.
  if ((scope.exclude ?? []).some(hit)) return false
  if ((scope.include ?? []).length === 0) return true
  return (scope.include ?? []).some(hit)
}

export interface ScopePreview {
  count:   number
  total:   number
  partial: boolean
  everyone: boolean
  available: boolean
  isLoading: boolean
}

/** "This rule will apply to N accounts", with its honesty attached. */
export function useScopePreview(scope: Scope, dir: Directory, enabled = true): ScopePreview {
  const groupIds = useMemo(
    () => [...new Set([...(scope.include ?? []), ...(scope.exclude ?? [])]
      .filter((r): r is { type: 'group'; id: string } => r.type === 'group')
      .map(r => r.id))],
    [scope],
  )
  const members = useGroupMembers(groupIds, enabled)

  const everyone = (scope.include?.length ?? 0) === 0 && (scope.exclude?.length ?? 0) === 0

  const count = useMemo(() => {
    if (everyone) return dir.totalUsers
    const byUser = new Map<string, string[]>()
    for (const [gid, uids] of Object.entries(members.data ?? {})) {
      for (const uid of uids) byUser.set(uid, [...(byUser.get(uid) ?? []), gid])
    }
    return dir.users.filter(u => covers(scope, {
      userId: u.id,
      chain:  dir.unitChain(u.org_unit_id),
      groups: byUser.get(u.id) ?? [],
    })).length
  }, [everyone, scope, dir, members.data])

  return {
    count,
    total:   dir.totalUsers,
    partial: !everyone && dir.partial,
    everyone,
    available: !dir.denied,
    isLoading: dir.isLoading || members.isLoading,
  }
}
