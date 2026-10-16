// Data access of "Download my data".
//
// ## Three routes, and none of them names an account
//
// The subject is always the caller, taken from the token by the server. There is
// no account identifier anywhere in this file - not as a parameter, not as a
// query string - because the surface that cannot express somebody else's id
// cannot be tricked into asking for their data.
//
// ## What a 404 means here
//
// `data_export.self_service` can be switched off for an instance, an
// organisational unit, a group or one account. Where it is off, the server
// answers 404 to all three routes and the section is not rendered at all - the
// nav entry itself is gated on the `/me` feature switch (see
// `settings/navigation.tsx`). This query therefore never has to picture a
// "refused" state: it is only ever mounted where the feature exists.
//
// ## The archive is never fetched through this client
//
// A download is a full-page navigation (see `downloadUrl`). Pulling a
// multi-gigabyte ZIP through axios would buffer it in the tab's memory before
// the browser ever offered to save it - and the account large enough to need an
// export is exactly the one it would break on.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../api/client'

export const MY_EXPORT_KEY = ['me-data-export'] as const

export type MyExportStatus =
  | 'pending' | 'running' | 'ready' | 'failed' | 'cancelled' | 'expired'

/** One body of data the archive may include. `core` is always present. */
export interface MyExportService {
  id:          string
  /** Which module declared it - `core` for the account sheet itself. */
  module_id:   string
  label:       string
  format:      string | null
  description: string | null
  /** The account sheet: offered, never unticked. */
  required:    boolean
}

export interface MyExportPolicy {
  /** Hours before a produced archive can be fetched. Zero on a default instance. */
  hold_hours:     number
  /** Days the archive stays available once it can be fetched. */
  retention_days: number
  /** How many times one archive may be downloaded. */
  max_downloads:  number
  /** Largest per-file ceiling that may be requested, in MiB. */
  max_file_mb:    number
}

export interface MyExportRun {
  id:             string
  status:         MyExportStatus
  services:       string[]
  requested_at:   string
  finished_at:    string | null
  available_at:   string
  expires_at:     string
  subjects_total: number
  subjects_done:  number
  file_name:      string | null
  size_bytes:     number | null
  error:          string | null
  file_deleted:   boolean
  download_count: number
  download_limit: number | null
  max_file_mb:    number | null
  /** Resolved by the server: can it be fetched right now? */
  downloadable:   boolean
  /** Fetches left, or `null` when there is no ceiling. */
  downloads_left: number | null
}

export interface MyExportProgress {
  subjects_total: number
  subjects_done:  number
  percent:        number
}

export interface MyExportOverview {
  services: MyExportService[]
  policy:   MyExportPolicy
  /** The archive format produced. One value: stated, not offered. */
  format:   string
  active:   MyExportRun | null
  progress: MyExportProgress | null
  history:  MyExportRun[]
  /** The server's clock, so a date is never judged against a skewed browser. */
  now:      string
  covers:     string[]
  not_covers: string[]
}

/**
 * Everything the page opens on, in one round trip - and it polls only while
 * something is actually moving. A page that needed three requests to paint would
 * show three different moments of the same instance.
 */
export function useMyExport() {
  return useQuery({
    queryKey: MY_EXPORT_KEY,
    queryFn:  () => api.get<MyExportOverview>('/me/export').then(r => r.data),
    refetchInterval: query =>
      (query.state.data as MyExportOverview | undefined)?.active ? 3_000 : false,
    staleTime: 5_000,
  })
}

export interface RequestMyExportBody {
  services:     string[]
  max_file_mb?: number
}

export function useRequestMyExport() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RequestMyExportBody) => api.post('/me/export', body),
    onSuccess:  () => { void qc.invalidateQueries({ queryKey: MY_EXPORT_KEY }) },
  })
}

/**
 * Where the archive lives. A plain URL rather than a request: the browser
 * streams it straight to disk, with its own progress and its own resume, and
 * nothing of it ever sits in this tab's memory.
 */
export const downloadUrl = (id: string): string => `/api/v1/me/export/${id}/download`

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../../api/errorMessage'
