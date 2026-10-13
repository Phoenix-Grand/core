import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'

/**
 * The "Abonnement et licence" page reads one route and writes two verbs.
 *
 * One route because the page is one reading: the licence, the instance's own
 * identity, the installed modules and the support contract arrive together, and
 * the blocks the caller may not read arrive as `null` rather than as a 403 that
 * would blank the page (see `handlers/admin/subscription.rs`).
 */

export const SUBSCRIPTION_KEY = ['admin-subscription'] as const

/** What the software is distributed under. Constants, not settings. */
export interface LicenceInfo {
  spdx:             string
  text_url:         string
  source_url:       string
  organisation_url: string
}

export interface InstanceInfo {
  name:         string | null
  instance_id:  string
  installed_at: string
  core_version: string
}

export interface AccountCounts {
  total:  number
  active: number
}

export interface InstalledModule {
  id:           string
  display_name: string
  version:      string
  license:      string | null
  homepage_url: string | null
  is_enabled:   boolean
  installed_at: string
}

export interface SupportContract {
  subject:       string
  plan:          string | null
  perimeter:     string | null
  contact:       string | null
  issued_at:     string | null
  expires_at:    string | null
  registered_at: string
  expired:       boolean
  /** `null` once expired — a countdown past zero is not a countdown. */
  days_left:     number | null
  /**
   * Recomputed by the server on every read, not stored: a contract registered
   * before the publisher's signing key existed becomes verified on its own the
   * day that key ships.
   */
  verified:      boolean
  key_id:        string | null
}

export interface SupportInfo {
  community: {
    source_url:       string
    issues_url:       string
    organisation_url: string
  }
  contract: SupportContract | null
  /** Whether this build carries any trusted signing key at all. */
  verification_available: boolean
}

export interface SubscriptionPayload {
  licence:  LicenceInfo
  instance: InstanceInfo
  /** `null` when the caller does not hold `core.stats.read`. */
  accounts: AccountCounts | null
  /** `null` when the caller does not hold `core.modules.read`. */
  modules:  InstalledModule[] | null
  support:  SupportInfo
}

export function useSubscription() {
  return useQuery({
    queryKey: SUBSCRIPTION_KEY,
    queryFn:  async () => (await api.get<SubscriptionPayload>('/admin/subscription')).data,
  })
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => { qc.invalidateQueries({ queryKey: SUBSCRIPTION_KEY }) }
}

/**
 * Registers (or replaces) the support key.
 *
 * The key travels once, in the request body, and is never read back: the server
 * answers with the decoded contract, never with the key itself.
 */
export function useRegisterSupportKey() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (key: string) =>
      (await api.post<{ contract: SupportContract }>(
        '/admin/subscription/support-key', { key },
      )).data.contract,
    onSuccess: invalidate,
  })
}

export function useRemoveSupportKey() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async () => {
      await api.delete('/admin/subscription/support-key')
    },
    onSuccess: invalidate,
  })
}

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../../core/api/errorMessage'
