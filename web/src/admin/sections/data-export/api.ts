// Data access of the export console.
//
// ## One query, and it polls only while something moves
//
// Everything the page opens on comes from `GET /admin/data-export` in one round
// trip: the policy, whether this operator may trigger one, what is running, the
// history, and the services the live modules currently offer. A page that needed
// four requests to paint would show four different moments of the same instance.
//
// It polls while a run is in flight - an export advances in a background job and
// a frozen progress bar is a page an operator stops trusting - and stops as soon
// as nothing is left running, because a finished history that keeps hitting the
// server every three seconds is a tab nobody closed.
//
// ## The archive is never fetched through this client
//
// A download is a full-page navigation to `/api/v1/admin/data-export/:id/download`
// (see `downloadUrl`). Pulling a multi-gigabyte ZIP through axios would buffer it
// in the tab's memory before the browser ever offered to save it, and the one
// instance where that matters is the one large enough to need an export.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'
import { usePrivileges } from '../../../core/authz/usePrivileges'
import { DATA_EXPORT_READ } from './privileges'

export const DATA_EXPORT_KEY = ['admin-data-export'] as const

export type ExportScope  = 'instance' | 'accounts'
export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'cancelled' | 'expired'
export type SubjectStatus = 'pending' | 'done' | 'partial' | 'failed'

/** One body of data an archive may include. `core` is always present. */
export interface ExportService {
  id:          string
  module_id:   string
  label:       string
  format:      string | null
  description: string | null
  /** The core's own record: offered, never unticked. */
  required:    boolean
}

export interface ExportPolicy {
  hold_hours:         number
  retention_days:     number
  max_file_mb:        number
  module_timeout_s:   number
  require_2fa:        boolean
  min_admin_age_days: number
  destination:        string
}

/**
 * Why this operator may not trigger an export. A list of stable reasons the
 * console translates - never a bare boolean, because every one of them has a fix
 * the person can act on.
 */
export interface ExportBlocker {
  reason:    string
  days?:     number
  required?: number
  detail?:   string
  export_id?: string
}

export interface ExportEligibility {
  ok:       boolean
  blockers: ExportBlocker[]
}

export interface ExportRun {
  id:             string
  scope:          ExportScope
  services:       string[]
  with_instance:  boolean
  requested_by:   string | null
  actor_label:    string | null
  status:         ExportStatus
  requested_at:   string
  started_at:     string | null
  finished_at:    string | null
  duration_ms:    number | null
  /** When the hold elapses and the archive becomes downloadable. */
  available_at:   string
  /** When the retention pass deletes it, downloaded or not. */
  expires_at:     string
  subjects_total: number
  subjects_done:  number
  file_name:      string | null
  destination:    string | null
  size_bytes:     number | null
  entries_count:  number | null
  error:          string | null
  file_deleted:   boolean
  deleted_at:     string | null
  download_count: number
  last_downloaded_at: string | null
}

export interface ExportProgress {
  subjects_total: number
  subjects_done:  number
  percent:        number
}

export interface ExportSubject {
  id:          string
  user_id:     string | null
  user_label:  string
  folder:      string
  status:      SubjectStatus
  size_bytes:  number | null
  services_ok: string[]
  services_ko: string[]
  error:       string | null
}

export interface DataExportOverview {
  policy:      ExportPolicy
  eligibility: ExportEligibility
  active:      ExportRun | null
  progress:    ExportProgress | null
  history:     ExportRun[]
  /** The server's clock, so the hold is never judged against a skewed browser. */
  now:         string
  active_accounts: number
  services:    ExportService[]
  covers:      string[]
  not_covers:  string[]
  contract:    number
  can_execute: boolean
}

export function useDataExport() {
  const { can } = usePrivileges()
  const allowed = can(DATA_EXPORT_READ)

  return useQuery({
    queryKey: DATA_EXPORT_KEY,
    enabled:  allowed,
    queryFn:  () => api.get<DataExportOverview>('/admin/data-export').then(r => r.data),
    refetchInterval: query =>
      (query.state.data as DataExportOverview | undefined)?.active ? 3_000 : false,
    staleTime: 5_000,
  })
}

/** Which accounts one export covered, and what each of them produced. */
export function useExportSubjects(exportId: string | null) {
  return useQuery({
    queryKey: [...DATA_EXPORT_KEY, 'subjects', exportId],
    enabled:  !!exportId,
    queryFn:  () =>
      api.get<{ subjects: ExportSubject[] }>(`/admin/data-export/${exportId}/subjects`)
        .then(r => r.data.subjects),
    staleTime: 10_000,
  })
}

function useExportMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DATA_EXPORT_KEY })
      // Requesting, cancelling and deleting an export all raise or resolve an
      // alert; the badge must not lag behind the page that caused it.
      void qc.invalidateQueries({ queryKey: ['admin-alerts'] })
    },
  })
}

export interface RequestExportBody {
  scope:          ExportScope
  user_ids?:      string[]
  services:       string[]
  with_instance:  boolean
}

export function useRequestExport() {
  return useExportMutation<RequestExportBody>(body => api.post('/admin/data-export', body))
}

export function useCancelExport() {
  return useExportMutation<string>(id => api.post(`/admin/data-export/${id}/cancel`, {}))
}

export function useDeleteExport() {
  return useExportMutation<string>(id => api.delete(`/admin/data-export/${id}`))
}

/**
 * Where the archive lives. A plain URL rather than a request: the browser
 * streams it straight to disk, with its own progress and its own resume, and
 * nothing of it ever sits in this tab's memory.
 */
export const downloadUrl = (id: string): string =>
  `/api/v1/admin/data-export/${id}/download`

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../../core/api/errorMessage'
