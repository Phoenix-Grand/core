// Wire types of `/api/v1/admin/alerts`, mirroring `crate::alerts`.
//
// The console renders what the server decided — including WHAT TO DO about an
// alert. It never derives an action from the alert's shape: the catalogue lives
// in Rust, next to the producers, so the two can never point at different
// screens.

import { adminUrl } from '../adminAction'

export type AlertSeverity = 'critical' | 'warning' | 'info'

export type AlertStatus =
  /** Nobody has looked at it yet. */
  | 'new'
  /** Somebody took it — the state that stops two operators doing the same work. */
  | 'acknowledged'
  /** Stated as fixed. A recurrence after this opens a NEW alert. */
  | 'resolved'
  /** Does not apply here. Recurrences keep landing on it, silently. */
  | 'ignored'

/** Painting order: worst first, so the urgent work is never below the rest. */
export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0, warning: 1, info: 2,
}

/** Is the alert still in the queue? */
export const isOpen = (s: AlertStatus): boolean => s === 'new' || s === 'acknowledged'

/**
 * A recommended action.
 *
 * `tab` + `verb` form `/admin/<tab>?action=<verb>` — the console's
 * deep-action convention (see `adminAction.ts`). `executes` marks the verbs the
 * alert centre performs itself with a POST instead of navigating away.
 */
export interface AlertAction {
  id:         string
  tab:        string
  verb?:      string
  target_id?: string
  /** Extra query parameters the destination reads (`user`, `audit_action`…). */
  params?:    [string, string][]
  /** English wording; the console prefers `admin.alact_<id>`. */
  label:      string
  /** Already filtered server-side: an action here is one the caller may run. */
  privilege:  string
  executes:   boolean
}

export interface Alert {
  id:       string
  source:   string
  /** Catalogue identifier, e.g. `security.login_burst`. */
  kind:     string
  severity: AlertSeverity
  status:   AlertStatus
  /** English title; the console prefers `admin.al_<kind>_title`. */
  title:    string
  summary:  string | null
  /** Interpolation arguments of the localised wording, and the detail context. */
  payload:  Record<string, unknown>
  module_id:       string | null
  subject_user_id: string | null
  subject_label:   string | null
  org_unit_id:     string | null
  /** How many times the same problem was observed — what dedup saved us from. */
  occurrences:   number
  first_seen_at: string
  last_seen_at:  string
  assignee_id:    string | null
  assignee_label: string | null
  assigned_at:    string | null
  closed_at:      string | null
  created_at:     string
  actions:        AlertAction[]
}

export type AlertEventKind =
  | 'created' | 'status' | 'severity' | 'assigned' | 'comment' | 'recurrence'

export interface AlertEvent {
  id:          number
  kind:        AlertEventKind
  actor_id:    string | null
  actor_label: string
  from_value:  string | null
  to_value:    string | null
  body:        string | null
  occurred_at: string
}

export interface AlertSummary {
  open:         number
  new:          number
  acknowledged: number
  critical:     number
  warning:      number
  info:         number
  ignored:      number
  resolved:     number
  /** Open alerts assigned to the caller. */
  mine:         number
  /**
   * When the producers last completed a pass. `null` means they never have —
   * and "nothing to report" is not the same sentence as "nothing has looked".
   */
  last_scan_at: string | null
}

export interface AlertView {
  id:         string
  name:       string
  filters:    Record<string, string>
  created_at: string
}

export interface AlertFacets {
  kinds:     string[]
  sources:   string[]
  assignees: { id: string; label: string }[]
  /** The whole catalogue, so the filter offers a type not yet produced here. */
  all_kinds: string[]
}

/** The filter set of the queue. Every value is a string so it saves verbatim. */
export interface AlertFilters {
  status:   string
  severity: string
  kind:     string
  assignee: string
  q:        string
  from:     string
  to:       string
}

export const EMPTY_FILTERS: AlertFilters = {
  status: '', severity: '', kind: '', assignee: '', q: '', from: '', to: '',
}

/** Only non-empty filters reach the query string, so the cache key stays stable. */
export function toParams(f: AlertFilters): Record<string, string> {
  const out: Record<string, string> = {}
  if (f.status)   out.status = f.status
  if (f.severity) out.severity = f.severity
  if (f.kind)     out.kind = f.kind
  if (f.assignee) out.assignee = f.assignee
  if (f.q)        out.q = f.q
  // <input type="date"> yields YYYY-MM-DD; the backend expects RFC 3339.
  if (f.from)     out.from = `${f.from}T00:00:00Z`
  if (f.to)       out.to = `${f.to}T23:59:59Z`
  return out
}

/**
 * URL of an action, through the console's single URL builder. The action carries
 * its extra parameters as pairs (the wire form), so they are turned into the
 * object `adminUrl` takes rather than re-implementing the spelling here — which
 * is precisely how this file used to drift from the rest of the console.
 */
export function actionHref(action: AlertAction): string {
  return adminUrl({
    tab:    action.tab,
    action: action.verb,
    id:     action.target_id,
    params: Object.fromEntries(action.params ?? []),
  })
}
