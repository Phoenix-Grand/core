import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../core/api/client'
import { useAuthStore } from '../../core/store/authStore'
import type { Privilege, Role, RoleAssignment } from '../../core/authz/types'

// Server-backed data of the delegated-administration console. One place for the
// query keys, so a write can invalidate exactly what it changed - including the
// caller's own effective privileges, which a grant may well have just widened.

export const ROLES_KEY       = ['admin-roles']
export const PRIVILEGES_KEY  = ['admin-privileges']
export const ASSIGNMENTS_KEY = ['admin-role-assignments']

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../core/api/errorMessage'

export function usePrivilegeCatalogue(enabled = true) {
  return useQuery({
    queryKey: PRIVILEGES_KEY,
    queryFn:  () => api.get<{ privileges: Privilege[] }>('/admin/privileges').then(r => r.data.privileges),
    enabled,
    staleTime: 5 * 60_000,
  })
}

export function useRoles(enabled = true) {
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn:  () => api.get<{ roles: Role[] }>('/admin/roles').then(r => r.data.roles),
    enabled,
    staleTime: 30_000,
  })
}

export function useAssignments(params: { role_id?: string; user_id?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...ASSIGNMENTS_KEY, params],
    queryFn:  () =>
      api
        .get<{ assignments: RoleAssignment[] }>('/admin/role-assignments', { params })
        .then(r => r.data.assignments),
    enabled,
    staleTime: 30_000,
  })
}

/**
 * Refreshes everything a role write can have changed. The caller's *own*
 * privileges are re-read on purpose: granting or revoking a role can change what
 * the operator themselves may see, and a stale answer there means a menu that no
 * longer matches reality. They live in the auth store (from `/me`), not in the
 * query cache, so they are refreshed rather than invalidated.
 */
function useInvalidateAuthz() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ROLES_KEY })
    qc.invalidateQueries({ queryKey: ASSIGNMENTS_KEY })
    void useAuthStore.getState().loadPrivileges(true)
    qc.invalidateQueries({ queryKey: ['admin-users'] })
    qc.invalidateQueries({ queryKey: ['admin-stats'] })
  }
}

export interface RolePayload {
  slug?:        string
  name:         string
  description?: string | null
  privileges:   string[]
}

/**
 * A role update. Every field is optional and an absent one means "leave it
 * alone" server-side - which is what lets the editor send only what the operator
 * actually changed, rather than echoing a translated label back into the row.
 * `privileges` must be absent for a system role: the server refuses the field on
 * one, even carrying an identical set.
 */
export type RoleUpdatePayload = Partial<Omit<RolePayload, 'slug'>>

export function useCreateRole(onDone?: () => void) {
  const invalidate = useInvalidateAuthz()
  return useMutation({
    mutationFn: (p: RolePayload) => api.post('/admin/roles', p).then(r => r.data),
    onSuccess:  () => { invalidate(); onDone?.() },
  })
}

export function useUpdateRole(id: string, onDone?: () => void) {
  const invalidate = useInvalidateAuthz()
  return useMutation({
    mutationFn: (p: RoleUpdatePayload) => api.patch(`/admin/roles/${id}`, p).then(r => r.data),
    onSuccess:  () => { invalidate(); onDone?.() },
  })
}

export function useDeleteRole(onDone?: () => void) {
  const invalidate = useInvalidateAuthz()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/roles/${id}`).then(r => r.data),
    onSuccess:  () => { invalidate(); onDone?.() },
  })
}

export interface AssignmentPayload {
  role_id:      string
  user_id?:     string
  group_id?:    string
  scope:        'instance' | 'org_unit'
  org_unit_id?: string | null
  expires_at?:  string | null
}

export function useCreateAssignment(onDone?: () => void) {
  const invalidate = useInvalidateAuthz()
  return useMutation({
    mutationFn: (p: AssignmentPayload) => api.post('/admin/role-assignments', p).then(r => r.data),
    onSuccess:  () => { invalidate(); onDone?.() },
  })
}

export function useDeleteAssignment(onDone?: () => void) {
  const invalidate = useInvalidateAuthz()
  return useMutation({
    mutationFn: (id: string) => api.delete(`/admin/role-assignments/${id}`).then(r => r.data),
    onSuccess:  () => { invalidate(); onDone?.() },
  })
}
