// The natural-language rendering of a rule.
//
// ── Why this is a feature and not an ornament ────────────────────────────────
// A condition tree is written once, by one person, and read afterwards by
// everyone else — during an incident, during an audit, six months later. If the
// only way to know what a rule does is to re-read its tree node by node, then
// nobody audits it and the rule becomes folklore. The sentence below is what
// makes a rule reviewable by somebody who did not write it.
//
// It is regenerated on every keystroke from the SAME model that will be sent to
// the server, never from a stale copy: a summary that lags behind the form is a
// summary that lies at exactly the moment it matters.
//
// ── Emphasis ────────────────────────────────────────────────────────────────
// Segments the reader must not skim are wrapped in `**…**`, split by the
// renderer. Translators keep the markers, which is why they travel inside the
// catalogue strings rather than being bolted on here.

import type { TFunction } from 'i18next'
import { toWire, type UiNode } from './condition'
import { describeLeaf, type LeafContext } from './leafKinds'
import { modeLabel, severityLabel, windowLabel } from './labels'
import type { ActionRow, RuleInput, Scope, ScopeRef, TriggerRow } from './types'

export interface SummaryContext extends LeafContext {
  trigger:  TriggerRow | undefined
  actions:  ActionRow[]
  /** Resolvers for the directory ids a scope names. Missing ⇒ the raw id. */
  unitName:  (id: string) => string | undefined
  groupName: (id: string) => string | undefined
  userName:  (id: string) => string | undefined
}

// ── Conditions ───────────────────────────────────────────────────────────────

function describeNode(node: UiNode, ctx: SummaryContext, t: TFunction, depth = 0): string {
  if (node.kind === 'leaf') return describeLeaf(node.node, ctx, t)

  const parts = node.children.map(c => describeNode(c, ctx, t, depth + 1))
  if (parts.length === 0) {
    // An empty `all` matches everything; an empty `any` matches nothing. Both
    // are legitimate and both must read as what they are.
    if (node.op === 'any') return t('admin.rl_sum_never')
    return t('admin.rl_sum_always')
  }
  if (parts.length === 1 && node.op !== 'none') return parts[0]

  if (node.op === 'none') {
    return t('admin.rl_cond_none', { items: parts.join(t('admin.rl_join_comma')) })
  }
  const joiner = node.op === 'all' ? ` ${t('admin.rl_join_and')} ` : ` ${t('admin.rl_join_or')} `
  const joined = parts.join(joiner)
  // Parenthesise a nested group so "A ET (B OU C)" cannot be misread as
  // "(A ET B) OU C" — the single most expensive ambiguity a rule can carry.
  return depth > 0 ? `(${joined})` : joined
}

// ── Scope ────────────────────────────────────────────────────────────────────

function describeRef(ref: ScopeRef, ctx: SummaryContext, t: TFunction): string {
  if (ref.type === 'org_unit') {
    const name = ctx.unitName(ref.id) ?? ref.id
    return ref.descendants === false
      ? t('admin.rl_ref_unit', { name })
      : t('admin.rl_ref_unit_sub', { name })
  }
  if (ref.type === 'group') return t('admin.rl_ref_group', { name: ctx.groupName(ref.id) ?? ref.id })
  return t('admin.rl_ref_user', { name: ctx.userName(ref.id) ?? ref.id })
}

function describeScope(scope: Scope, ctx: SummaryContext, t: TFunction): string {
  const include = (scope.include ?? []).map(r => describeRef(r, ctx, t))
  const exclude = (scope.exclude ?? []).map(r => describeRef(r, ctx, t))
  const sep = t('admin.rl_join_comma')

  if (include.length === 0 && exclude.length === 0) return t('admin.rl_sum_scope_all')
  if (include.length === 0) return t('admin.rl_sum_scope_all_except', { excluded: exclude.join(sep) })
  if (exclude.length === 0) return t('admin.rl_sum_scope_only', { included: include.join(sep) })
  return t('admin.rl_sum_scope_only_except', {
    included: include.join(sep),
    excluded: exclude.join(sep),
  })
}

// ── Actions ──────────────────────────────────────────────────────────────────

function describeAction(
  spec: { action: string; params: Record<string, unknown> },
  ctx: SummaryContext,
  t: TFunction,
): string {
  const def = ctx.actions.find(a => a.key === spec.action)
  const label = def?.label ?? spec.action
  // Only the parameters the operator actually filled in: repeating every empty
  // optional field would bury the two that matter.
  const filled = Object.entries(spec.params ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => {
      const p = def?.params_schema.find(x => x.name === k)
      return `${p?.label ?? k} : « ${String(v)} »`
    })
  return filled.length ? `${label} (${filled.join(t('admin.rl_join_comma'))})` : label
}

// ── The sentence ─────────────────────────────────────────────────────────────

/**
 * The whole rule as one paragraph, with `**…**` around what must not be skimmed.
 */
export function describeRule(input: RuleInput, tree: UiNode, ctx: SummaryContext, t: TFunction): string {
  const triggerLabel = ctx.trigger?.label ?? (input.trigger || t('admin.rl_sum_no_trigger'))

  let sentence = t('admin.rl_sum_when', { trigger: triggerLabel })

  const wire = toWire(tree)
  const hasCondition = JSON.stringify(wire) !== JSON.stringify({ type: 'all', of: [] })
  sentence += hasCondition
    ? t('admin.rl_sum_if', { conditions: describeNode(tree, ctx, t) })
    : t('admin.rl_sum_nocond')

  if (input.threshold_count && input.threshold_window_s) {
    sentence += t('admin.rl_sum_threshold', {
      count:  input.threshold_count,
      window: windowLabel(t, input.threshold_window_s),
    })
  }

  sentence += input.actions.length
    ? t('admin.rl_sum_then', {
      actions: input.actions
        .map(a => describeAction(a, ctx, t))
        .join(` ${t('admin.rl_join_and')} `),
    })
    : t('admin.rl_sum_no_action')

  sentence += ' ' + describeScope(input.scope, ctx, t)

  if (input.rollout_percent < 100) {
    sentence += ' ' + t('admin.rl_sum_rollout', { percent: input.rollout_percent })
  }

  // Severity is worth a clause only when something can carry it.
  if (input.mode !== 'inactive') {
    sentence += ' ' + t('admin.rl_sum_severity', { severity: severityLabel(t, input.severity) })
  }

  sentence += ' ' + t('admin.rl_sum_mode', { mode: modeLabel(t, input.mode) })
  if (input.mode === 'simulate') sentence += ' ' + t('admin.rl_sum_mode_simulate_note')
  if (input.mode === 'inactive') sentence += ' ' + t('admin.rl_sum_mode_inactive_note')

  return sentence
}

/** Splits a `**…**` string into its emphasised and plain runs. */
export function splitEmphasis(text: string): { text: string; strong: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(part => part !== '')
    .map(part => part.startsWith('**') && part.endsWith('**')
      ? { text: part.slice(2, -2), strong: true }
      : { text: part, strong: false })
}
