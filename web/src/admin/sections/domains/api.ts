// Data access of the domain registry.
//
// One cache entry for the whole page: the list is short (an instance has a
// handful of domains, not a directory of them), every mutation changes several
// rows at once - a promotion demotes another, an alias appears under its parent
// - and refetching the lot is both simpler and more honest than patching a
// cached row into a state the server did not confirm.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'

export const DOMAINS_KEY = ['admin-domains'] as const

export type DomainKind = 'primary' | 'secondary' | 'alias'

export interface Domain {
  id:              string
  name:            string
  kind:            DomainKind
  parent_id:       string | null
  parent_name:     string | null
  verified:        boolean
  verified_at:     string | null
  last_checked_at: string | null
  /** Why the last probe did not find the record - a sentence, already French. */
  last_error:      string | null
  /** `"10 mx.exemple.fr."`, exactly as the domain publishes them. */
  mx_hosts:        string[]
  has_spf:         boolean | null
  has_dmarc:       boolean | null
  mail_checked_at: string | null
  created_at:      string
  /** Accounts carrying an address at this domain - what a removal would break. */
  account_count:   number
  /** The TXT value to publish, prefix included. */
  expected_record: string
  record_name:     string
  record_type:     string
}

export interface DomainsPayload {
  domains: Domain[]
  overview: {
    total: number
    verified: number
    pending: number
    aliases: number
    primary_name: string | null
  }
  /** What the instance sends mail as, so the page can flag a mismatch. */
  from_address: string | null
  from_domain:  string | null
  token_prefix: string
}

export function useDomains() {
  return useQuery({
    queryKey: DOMAINS_KEY,
    queryFn:  async () => (await api.get<DomainsPayload>('/admin/domains')).data,
  })
}

export function useDomainDetail(id: string | null) {
  return useQuery({
    queryKey: [...DOMAINS_KEY, id],
    enabled:  !!id,
    queryFn:  async () => (await api.get<{ domain: Domain; removal_blockers: string[] }>(
      `/admin/domains/${id}`)).data,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => { qc.invalidateQueries({ queryKey: DOMAINS_KEY }) }
}

export function useAddDomain() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (input: { name: string; kind: DomainKind; parent_id?: string }) =>
      (await api.post<{ domain: Domain }>('/admin/domains', input)).data.domain,
    onSuccess: invalidate,
  })
}

/** Reads the DNS now. Slow by nature - the button shows it. */
export function useVerifyDomain() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ domain: Domain }>(`/admin/domains/${id}/verify`)).data.domain,
    onSuccess: invalidate,
  })
}

export function useMailCheck() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ domain: Domain }>(`/admin/domains/${id}/mail-check`)).data.domain,
    onSuccess: invalidate,
  })
}

export function usePromoteDomain() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) => (await api.post(`/admin/domains/${id}/primary`)).data,
    onSuccess: invalidate,
  })
}

export function useRemoveDomain() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/admin/domains/${id}`)).data,
    onSuccess: invalidate,
  })
}

/** The server's message when it has one - it is more specific than ours. */
export function errorMessage(err: unknown, fallback: string): string {
  const detail = (err as { response?: { data?: { message?: string; error?: string } } })
    ?.response?.data
  return detail?.message ?? detail?.error ?? fallback
}
