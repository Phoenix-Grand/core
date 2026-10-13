// Data access of the migration console.
//
// ## Two cache entries, and one of them refreshes itself
//
// The list is short and changes only when somebody acts on it, so it is a plain
// query. The detail is not: a campaign that is running moves on its own, in a
// background job, and a page that shows a frozen progress bar is a page an
// operator stops trusting. So the detail polls — but only while there is
// something to see (`refetchInterval` returns `false` once nothing is left in
// flight), because a finished campaign that keeps hitting the server every few
// seconds is a page nobody closed.
//
// ## The credential never comes back
//
// Nothing in these types can hold a source password: the server does not return
// one, and adding a field for it here is the mistake this comment exists to
// prevent. It travels in one direction only — into `createCampaign` and into
// `probe`, once each.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'

export const MIGRATION_KEY = ['admin-data-migration'] as const

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'done' | 'failed'
export type AccountStatus  = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** Which services this instance can migrate, and whether their module is up. */
export interface MigrationService {
  id:        string
  module_id: string
  available: boolean
}

export interface CampaignTally {
  accounts: number
  pending:  number
  running:  number
  done:     number
  failed:   number
  copied:   number
  total:    number
}

export interface Campaign {
  id:              string
  name:            string
  service:         string
  module_id:       string
  source_kind:     string
  source_host:     string
  source_port:     number
  source_security: string
  since_date:      string | null
  exclude_folders: string[]
  status:          CampaignStatus
  created_by:      string | null
  actor_label:     string | null
  created_at:      string
  started_at:      string | null
  finished_at:     string | null
  /** Why the campaign itself could not run — a sentence, already French. */
  error:           string | null
  tally:           CampaignTally
}

export interface MigrationAccount {
  id:             string
  campaign_id:    string
  source_login:   string
  target_user_id: string
  target_email:   string | null
  target_name:    string | null
  status:         AccountStatus
  items_copied:   number
  items_total:    number
  attempts:       number
  error:          string | null
  started_at:     string | null
  finished_at:    string | null
  updated_at:     string
}

export interface SourceFolder {
  name:         string
  display_name: string
  kind:         string
  messages:     number
}

export interface CampaignsPayload {
  campaigns: Campaign[]
  services:  MigrationService[]
}

export interface CampaignDetailPayload {
  campaign: Campaign
  accounts: MigrationAccount[]
}

/** What the wizard sends. The only shape here that carries a password. */
export interface CampaignInput {
  name:    string
  service: string
  source:  { kind: string; host: string; port: number; security: string }
  since?:  string | null
  exclude_folders: string[]
  accounts: { source_login: string; password: string; target_user_id: string }[]
  start:   boolean
}

export function useCampaigns() {
  return useQuery({
    queryKey: MIGRATION_KEY,
    queryFn:  async () => (await api.get<CampaignsPayload>('/admin/data-migration')).data,
  })
}

export function useCampaignDetail(id: string | null) {
  return useQuery({
    queryKey: [...MIGRATION_KEY, id],
    enabled:  !!id,
    queryFn:  async () =>
      (await api.get<CampaignDetailPayload>(`/admin/data-migration/${id}`)).data,
    // Only while something moves. See the header.
    refetchInterval: query => {
      const data = query.state.data as CampaignDetailPayload | undefined
      if (!data) return false
      const moving = data.campaign.status === 'running'
        || data.accounts.some(a => a.status === 'running' || a.status === 'pending')
      return moving ? 4000 : false
    },
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => { qc.invalidateQueries({ queryKey: MIGRATION_KEY }) }
}

/** Opens a session on the source and reports what is there. Slow by nature. */
export function useProbeSource() {
  return useMutation({
    mutationFn: async (input: {
      service: string
      source: { kind: string; host: string; port: number; security: string }
      login: string
      password: string
    }) =>
      (await api.post<{ ok: boolean; folders?: SourceFolder[]; error?: string }>(
        '/admin/data-migration/probe', input)).data,
  })
}

export function useCreateCampaign() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (input: CampaignInput) =>
      (await api.post<{ campaign: Campaign }>('/admin/data-migration', input)).data.campaign,
    onSuccess: invalidate,
  })
}

export function useStartCampaign() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ campaign: Campaign }>(`/admin/data-migration/${id}/start`)).data.campaign,
    onSuccess: invalidate,
  })
}

export function usePauseCampaign() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ campaign: Campaign }>(`/admin/data-migration/${id}/pause`)).data.campaign,
    onSuccess: invalidate,
  })
}

export function useRetryAccount() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({ id, accountId }: { id: string; accountId: string }) =>
      (await api.post<{ accounts: MigrationAccount[] }>(
        `/admin/data-migration/${id}/accounts/${accountId}/retry`)).data.accounts,
    onSuccess: invalidate,
  })
}

export function useDeleteCampaign() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/data-migration/${id}`)).data,
    onSuccess: invalidate,
  })
}

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../../core/api/errorMessage'
