// Data access of the target-audiences section.
//
// Two cache entries: the list, and the sheet of whichever audience is open.
// They are invalidated together on every mutation, because the list carries
// figures the sheet can change - adding a member moves both the member count and
// the reach, and applying an audience moves the "offered in N places" column of
// a row the caller was not looking at.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'

export const AUDIENCES_KEY = ['admin-audiences'] as const
export const audienceKey = (id: string) => ['admin-audience', id] as const
export const policyKey = (unit: string, module: string) =>
  ['admin-audience-policy', unit, module] as const

/** One row of the list. */
export interface Audience {
  id:           string
  name:         string
  description:  string | null
  /** The seeded "everyone" audience: no explicit members, never deletable. */
  is_everyone:  boolean
  /** Entries added by hand - what the sheet edits. */
  member_count: number
  /**
   * Distinct **active accounts** those entries resolve to. Differs from
   * `member_count` as soon as a member is a group, which is the recommended
   * case - so this is the figure that says how wide a proposal really is.
   */
  reach:        number
  /** How many (unit × module) pairs offer this audience. */
  applied_to:   number
  created_at:   string
  updated_at:   string
}

export interface AudienceMember {
  member_type: 'user' | 'group'
  member_id:   string
  label:       string
  email:       string | null
  /** Active accounts the group brings in. Null for an individual account. */
  group_reach: number | null
  /** The referenced account or group is gone. Should never happen; shown if it does. */
  is_dangling: boolean
  added_at:    string
}

export interface AppliedAt {
  module_id:     string
  org_unit_id:   string
  org_unit_name: string
  position:      number
}

export interface AudienceSheet {
  audience: Audience
  members:  AudienceMember[]
  applied:  AppliedAt[]
}

export function useAudiences() {
  return useQuery({
    queryKey: AUDIENCES_KEY,
    queryFn: async () => {
      const { data } = await api.get<{ audiences: Audience[]; max_applied: number }>(
        '/admin/audiences',
      )
      return data
    },
  })
}

export function useAudience(id: string | null) {
  return useQuery({
    queryKey: audienceKey(id ?? ''),
    enabled:  !!id,
    queryFn: async () => {
      const { data } = await api.get<AudienceSheet>(`/admin/audiences/${id}`)
      return data
    },
  })
}

/**
 * Every mutation of the section, sharing one invalidation.
 *
 * They are grouped rather than exported one by one so that no caller can add a
 * write that forgets to refresh the list: the counts shown there are derived
 * from what these calls change.
 */
export function useAudienceMutations(openId: string | null) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: AUDIENCES_KEY })
    if (openId) void qc.invalidateQueries({ queryKey: audienceKey(openId) })
    // The policy of any (unit, module) pair may now resolve differently.
    void qc.invalidateQueries({ queryKey: ['admin-audience-policy'] })
  }

  const create = useMutation({
    mutationFn: async (body: { name: string; description?: string | null }) =>
      (await api.post<{ audience: Audience }>('/admin/audiences', body)).data,
    onSuccess: refresh,
  })

  const update = useMutation({
    mutationFn: async (v: { id: string; name: string; description?: string | null }) =>
      (await api.patch(`/admin/audiences/${v.id}`, { name: v.name, description: v.description })).data,
    onSuccess: refresh,
  })

  const remove = useMutation({
    mutationFn: async (id: string) =>
      (await api.delete<{ was_applied_to: number }>(`/admin/audiences/${id}`)).data,
    onSuccess: refresh,
  })

  const addMembers = useMutation({
    mutationFn: async (v: { id: string; members: { member_type: string; member_id: string }[] }) =>
      (await api.post(`/admin/audiences/${v.id}/members`, { members: v.members })).data,
    onSuccess: refresh,
  })

  const removeMembers = useMutation({
    mutationFn: async (v: { id: string; members: { member_type: string; member_id: string }[] }) =>
      (await api.delete(`/admin/audiences/${v.id}/members`, { data: { members: v.members } })).data,
    onSuccess: refresh,
  })

  return { create, update, remove, addMembers, removeMembers }
}

export interface PolicyEntry {
  audience_id: string
  position:    number
  name:        string
  description: string | null
  is_everyone: boolean
}

/**
 * What a unit offers in a module.
 *
 * `applied` is what was written **on this unit** - what the form edits and what
 * a save replaces. `effective` is what is actually in force, which for a unit
 * with no rows of its own is inherited from the nearest ancestor that has some;
 * `inherited_from` then names that ancestor. The two are identical, and
 * `inherited_from` null, whenever the unit has its own policy.
 *
 * The same distinction the settings pages already draw between "inherited from
 * X" and "overridden here" - one tree must not carry two inheritance stories.
 */
export interface PolicyView {
  applied:        PolicyEntry[]
  effective:      PolicyEntry[]
  inherited_from: { org_unit_id: string; org_unit_name: string } | null
  max_applied:    number
}

export function useAudiencePolicy(orgUnitId: string | null, moduleId: string | null) {
  return useQuery({
    queryKey: policyKey(orgUnitId ?? '', moduleId ?? ''),
    enabled:  !!orgUnitId && !!moduleId,
    queryFn: async () => {
      const { data } = await api.get<PolicyView>('/admin/audiences/policy', {
        params: { org_unit_id: orgUnitId, module_id: moduleId },
      })
      return data
    },
  })
}

export function useSetPolicy() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: { org_unit_id: string; module_id: string; audience_ids: string[] }) =>
      (await api.put('/admin/audiences/policy', v)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-audience-policy'] })
      void qc.invalidateQueries({ queryKey: AUDIENCES_KEY })
    },
  })
}
