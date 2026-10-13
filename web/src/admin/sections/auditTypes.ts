/**
 * Wire shape of `crate::audit::model::AuditRow`, shared by every screen that
 * reads the administrative trail (the audit section and the per-account
 * activity tab of the user sheet). Declared once so the two cannot drift.
 */
export interface AuditEntry {
  id:                   number
  occurred_at:          string
  actor_id:             string | null
  actor_label:          string
  actor_role:           string | null
  actor_origin:         'session' | 'api_token' | 'internal' | 'system'
  actor_token_id:       string | null
  ip_address:           string | null
  user_agent:           string | null
  action:               string
  module_id:            string | null
  target_type:          string | null
  target_id:            string | null
  target_label:         string | null
  before:               Record<string, unknown> | null
  after:                Record<string, unknown> | null
  outcome:              'success' | 'denied' | 'error'
  detail:               string | null
  reversible:           boolean
  reverts_entry_id:     number | null
  reverted_by_entry_id: number | null
}

export interface AuditDiffRow { field: string; before: unknown; after: unknown }

/** Badge skin per outcome — token-backed so both themes remap it. */
export const AUDIT_OUTCOME_STYLE: Record<AuditEntry['outcome'], string> = {
  success: 'bg-success-light text-success',
  denied:  'bg-danger-light text-danger',
  error:   'bg-warning-light text-warning',
}
