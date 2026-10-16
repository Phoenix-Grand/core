import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import type {
  Approval, DeviceDetailResponse, DeviceFacets, DeviceFilters, DeviceListResponse,
  MyDevicesResponse, SessionFilters,
} from './types'
import { toParams } from './types'

/**
 * Data access of the inventory, for both audiences.
 *
 * The administration hooks and the personal ones sit in the same file so the
 * symmetry stays visible: they call different routes only because the server
 * checks a different perimeter, never because they show different things.
 */

export const DEVICES_KEY = ['admin-devices'] as const
export const SESSIONS_KEY = ['admin-sessions'] as const
export const MY_DEVICES_KEY = ['my-devices'] as const

// ── Administration ───────────────────────────────────────────────────────────

export function useDevices(filters: DeviceFilters, enabled = true) {
  return useQuery({
    queryKey: [...DEVICES_KEY, filters],
    enabled,
    queryFn: () => api
      .get<DeviceListResponse>('/admin/devices', { params: { ...toParams({ ...filters }), limit: 200 } })
      .then(r => r.data),
  })
}

export function useDeviceFacets(enabled = true) {
  return useQuery({
    queryKey: [...DEVICES_KEY, 'facets'],
    enabled,
    queryFn: () => api.get<DeviceFacets>('/admin/devices/facets').then(r => r.data),
    staleTime: 5 * 60_000,
  })
}

export function useDevice(id: string | null) {
  return useQuery({
    queryKey: [...DEVICES_KEY, 'detail', id],
    enabled: !!id,
    queryFn: () => api.get<DeviceDetailResponse>(`/admin/devices/${id}`).then(r => r.data),
  })
}

export function useAdminSessions(filters: SessionFilters, enabled = true) {
  return useQuery({
    queryKey: [...SESSIONS_KEY, filters],
    enabled,
    queryFn: () => api
      .get<{ sessions: import('./types').DeviceSession[]; total: number }>('/admin/sessions', {
        params: { ...toParams({ ...filters }), limit: 200 },
      })
      .then(r => r.data),
  })
}

/** Anything that changes a device invalidates the list, the sheet and the sessions. */
function useDeviceMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DEVICES_KEY })
      void qc.invalidateQueries({ queryKey: SESSIONS_KEY })
    },
  })
}

export function useSetApproval() {
  return useDeviceMutation(({ id, approval, reason }: { id: string; approval: Approval; reason?: string }) =>
    api.post(`/admin/devices/${id}/approval`, { approval, reason }))
}

export function useSignOutDevice() {
  return useDeviceMutation((id: string) => api.post(`/admin/devices/${id}/sign-out`))
}

/**
 * Forgets a device.
 *
 * Erases nothing on the machine - see the copy the console shows before it
 * runs. Named `forget`, never `wipe`, because the name is the first place the
 * misreading starts.
 */
export function useForgetDevice() {
  return useDeviceMutation((id: string) => api.delete(`/admin/devices/${id}`))
}

// ── The account's own devices ────────────────────────────────────────────────

export function useMyDevices() {
  return useQuery({
    queryKey: MY_DEVICES_KEY,
    queryFn: () => api.get<MyDevicesResponse>('/me/devices').then(r => r.data),
  })
}

function useMyDeviceMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MY_DEVICES_KEY })
      void qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })
}

export function useRenameMyDevice() {
  return useMyDeviceMutation(({ id, label }: { id: string; label: string | null }) =>
    api.patch(`/me/devices/${id}`, { label }))
}

export function useSignOutMyDevice() {
  return useMyDeviceMutation((id: string) => api.post(`/me/devices/${id}/sign-out`))
}

/**
 * "This was not me."
 *
 * Revokes every session of the account - including the one pressing the
 * button - forces a password change and alerts the operator. The caller is
 * expected to send the user to the sign-in page immediately afterwards.
 */
export function useDisownMyDevice() {
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api.post<{ revoked_sessions: number; password_change_required: boolean }>(
        `/me/devices/${id}/not-me`, { note },
      ).then(r => r.data),
  })
}
