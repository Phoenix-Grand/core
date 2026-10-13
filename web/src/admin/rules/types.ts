// Wire types of the administration rule engine (`crate::rules`).
//
// Every shape here mirrors what `handlers/admin/rules.rs` serialises. Nothing in
// this file enumerates triggers, fields, operators-per-field or action
// parameters: those come from `GET /admin/rules/catalog` at runtime, which is
// what lets a module installed five minutes ago be editable without a frontend
// release.

/** The closed operator vocabulary (`rules::condition::Operator`). */
export type Operator =
  | 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'in' | 'not_in' | 'exists' | 'not_exists' | 'is_true' | 'is_false'

/** Operators that read no value — the editor hides the value field for them. */
export const UNARY_OPERATORS: readonly Operator[] = ['exists', 'not_exists', 'is_true', 'is_false']

/** Operators whose value is a list. */
export const LIST_OPERATORS: readonly Operator[] = ['in', 'not_in']

/** The four modes a rule may be stored in, plus the one an execution carries. */
export type Mode = 'inactive' | 'simulate' | 'monitor' | 'enforce'
export type ExecutionMode = Mode | 'backtest'

export type Outcome =
  | 'matched' | 'acted' | 'no_match' | 'out_of_scope' | 'out_of_rollout'
  | 'below_threshold' | 'depth_exceeded' | 'error'

export type Severity = 'critical' | 'warning' | 'info'

// ── Condition tree ───────────────────────────────────────────────────────────

/**
 * One node of the wire condition tree.
 *
 * The four shapes below are what the core understands today. The open-ended
 * variant is deliberate: a module may teach the engine a new leaf shape (a
 * content detector with a confidence threshold, say), and the builder renders it
 * through the leaf-kind registry rather than through a `switch` in this file.
 * An unknown node is shown read-only and preserved byte-for-byte — never
 * silently dropped on save.
 */
export type CondNode =
  | { type: 'all'; of: CondNode[] }
  | { type: 'any'; of: CondNode[] }
  | { type: 'not'; of: CondNode }
  | CompareNode
  | DetectorNode
  | ExtensionNode

export interface CompareNode {
  type:  'compare'
  field: string
  op:    Operator
  value?: unknown
}

/**
 * The `detector` leaf (`rules::detect::DetectorLeaf`).
 *
 * Thresholds, never logic: a catalogue key and how much of it is enough. The
 * pattern lives in the detector — a row an administrator manages, tests and
 * audits on its own screen — which is what let content inspection arrive
 * without an expression language arriving with it.
 */
export interface DetectorNode {
  type:     'detector'
  detector: string
  /** 0…1. Displayed as a percentage, which is how everybody reads 0.8. */
  min_confidence:     number
  min_matches:        number
  /** Distinct values. Never above `min_matches` — the server refuses it. */
  min_unique_matches: number
  /** Names of `content` fields of the trigger. Empty = every part supplied. */
  parts:    string[]
}

/** Any leaf shape this build does not know natively. */
export interface ExtensionNode {
  type: string
  [key: string]: unknown
}

// ── Catalogue ────────────────────────────────────────────────────────────────

export interface FieldDef {
  name:      string
  /** `string` | `number` | `bool` | `uuid` | `timestamp`. Drives the value control. */
  type:      string
  label:     string
  operators: Operator[]
}

export interface TriggerRow {
  key:         string
  module_id:   string
  event_type:  string
  label:       string
  description: string | null
  fields:      FieldDef[]
  /** The declaring module is gone: the server refuses to write a rule on it. */
  is_orphan:   boolean
}

export interface ParamDef {
  name:     string
  /** `string` | `number` | `bool` | `enum`. */
  type:     string
  label:    string
  required: boolean
  values:   unknown[] | null
}

export interface ActionRow {
  key:           string
  module_id:     string
  label:         string
  description:   string | null
  params_schema: ParamDef[]
  is_blocking:   boolean
  is_reversible: boolean
  is_orphan:     boolean
}

/**
 * One content detector, as the rule catalogue offers it.
 *
 * The **enabled** ones only: a disabled detector is refused on save, so
 * offering it would let an operator write a rule the server then rejects. The
 * three thresholds are the detector's own — the builder proposes them as the
 * starting point of a leaf rather than inventing defaults of its own.
 */
export interface DetectorRow {
  key:         string
  label:       string
  description: string | null
  category:    string
  /** `regex` | `wordlist` | `checksum`. Descriptive; drives no behaviour here. */
  kind:        string
  min_confidence:     number
  min_matches:        number
  min_unique_matches: number
}

/** Ceilings the server enforces on every write. Shown, never guessed. */
export interface RuleLimits {
  condition_depth:  number
  condition_leaves: number
  actions:          number
  scope_refs:       number
  /** Detector leaves per rule — a ceiling of its own, on top of the leaf budget. */
  detector_leaves:  number
}

export interface Catalog {
  triggers:  TriggerRow[]
  actions:   ActionRow[]
  operators: Operator[]
  modes:     Mode[]
  limits:    RuleLimits
  /** The kinds of leaf a tree may hold. There is no third: the wire is an enum. */
  leaf_types?: string[]
  detectors?:  DetectorRow[]
  /** Field type marking a content part — a text to inspect, not a fact to compare. */
  content_field_type?: string
}

// ── Scope ────────────────────────────────────────────────────────────────────

export type ScopeRef =
  | { type: 'org_unit'; id: string; descendants?: boolean }
  | { type: 'group';    id: string }
  | { type: 'user';     id: string }

export interface Scope {
  include: ScopeRef[]
  exclude: ScopeRef[]
}

export const EMPTY_SCOPE: Scope = { include: [], exclude: [] }

// ── The rule ─────────────────────────────────────────────────────────────────

export interface ActionSpec {
  action: string
  params: Record<string, unknown>
}

export interface Rule {
  id:                 string
  name:               string
  description:        string | null
  trigger:            string
  conditions:         CondNode
  actions:            ActionSpec[]
  mode:               Mode
  scope:              Scope
  threshold_count:    number | null
  threshold_window_s: number | null
  rollout_percent:    number
  severity:           string
  priority:           number
  version:            number
  created_at:         string
  updated_at:         string
}

/** `GET /admin/rules`. `indexed` is what the engine is *actually* running. */
export interface RulesListResponse {
  rules:          Rule[]
  indexed:        number
  engine_enabled: boolean
}

export interface VersionRow {
  version:          number
  snapshot:         unknown
  change_note:      string | null
  changed_by:       string | null
  changed_by_label: string | null
  created_at:       string
}

export interface ExecutionRow {
  id:             number
  rule_id:        string
  rule_name:      string | null
  rule_version:   number
  mode:           ExecutionMode
  outcome:        Outcome
  event_type:     string
  actor_user_id:  string | null
  org_unit_id:    string | null
  resource_type:  string | null
  resource_id:    string | null
  /**
   * Structural detail only — counters, the threshold state and the per-action
   * verdicts. The engine never records what a rule inspected, so there is no
   * column here for the content and the console must not invent one.
   */
  detail:         ExecutionDetail
  actions_total:  number
  actions_ok:     number
  actions_failed: number
  depth:          number
  duration_ms:    number
  occurred_at:    string
}

export interface ActionVerdict {
  action: string
  status: string
  error?: string | null
}

export interface ExecutionDetail {
  leaves_evaluated?: number
  scope_applied?:    boolean
  rollout_percent?:  number
  threshold?:        { hits: number; needed: number; window_s: number }
  actions?:          ActionVerdict[]
}

// ── Backtest ─────────────────────────────────────────────────────────────────

export interface BacktestReport {
  window_from?:    string
  window_to?:      string
  event_type?:     string
  events_scanned?: number
  matched?:        number
  would_act?:      number
  out_of_scope?:   number
  out_of_rollout?: number
  truncated?:      boolean
  logged_matches?: number
  by_day?:         { day: string; count: number }[]
  by_org_unit?:    { unit: string; count: number }[]
  /** What the replay cannot answer. Rendered next to the numbers, never hidden. */
  limitations?:    string[]
}

export interface BacktestRow {
  id:           string
  rule_id:      string
  rule_version: number
  window_from:  string
  window_to:    string
  status:       'pending' | 'running' | 'done' | 'failed' | string
  report:       BacktestReport
  error:        string | null
  created_at:   string
  completed_at: string | null
}

/** Widest window the event log can honestly replay (`backtest::MAX_WINDOW_DAYS`). */
export const BACKTEST_MAX_WINDOW_DAYS = 30

// ── The editor's form model ──────────────────────────────────────────────────

/** What the editor holds and what `POST`/`PATCH /admin/rules` receives. */
export interface RuleInput {
  name:               string
  description:        string | null
  trigger:            string
  conditions:         CondNode
  actions:            ActionSpec[]
  mode:               Mode
  scope:              Scope
  threshold_count:    number | null
  threshold_window_s: number | null
  rollout_percent:    number
  severity:           Severity
  priority:           number
  change_note?:       string | null
}

export function emptyRuleInput(): RuleInput {
  return {
    name:               '',
    description:        null,
    trigger:            '',
    conditions:         { type: 'all', of: [] },
    actions:            [],
    // A rule is born doing nothing — the same default `validate::RuleInput`
    // applies server-side, restated here so the editor never shows "enforce"
    // as a starting point.
    mode:               'inactive',
    scope:              { include: [], exclude: [] },
    threshold_count:    null,
    threshold_window_s: null,
    rollout_percent:    100,
    severity:           'warning',
    priority:           100,
  }
}

export function ruleToInput(rule: Rule): RuleInput {
  return {
    name:               rule.name,
    description:        rule.description,
    trigger:            rule.trigger,
    conditions:         rule.conditions,
    actions:            rule.actions,
    mode:               rule.mode,
    scope:              { include: rule.scope?.include ?? [], exclude: rule.scope?.exclude ?? [] },
    threshold_count:    rule.threshold_count,
    threshold_window_s: rule.threshold_window_s,
    rollout_percent:    rule.rollout_percent,
    severity:           (['critical', 'warning', 'info'].includes(rule.severity)
      ? rule.severity
      : 'warning') as Severity,
    priority:           rule.priority,
  }
}
