// The leaf-kind registry — the extension point of the condition builder.
//
// ── What a "leaf kind" is ────────────────────────────────────────────────────
// A group node (`all` / `any` / `none`) is structure and belongs to the builder.
// Everything at the bottom of the tree is a LEAF, and a leaf is a *kind*: the
// comparison this build ships (`compare`), and whatever a module teaches the
// engine later — a content detector with a confidence threshold, a rate over a
// window, a reputation lookup. Each kind declares five things and nothing else:
//
//   • how to create one,          • how to edit one,
//   • how to say it in a sentence (the readability panel is not optional),
//   • how to evaluate it in the browser (so "Test the condition" lights it up),
//   • what a plausible sample fact for it looks like (so the tester prefills).
//
// ── Why the builder has no `switch` on node type ─────────────────────────────
// Adding a kind must not require touching ConditionTree.tsx, RuleSummary.tsx or
// the tester. A module registers its kind at import time and the three surfaces
// pick it up. A node whose kind nobody registered is rendered read-only and
// preserved verbatim on save — an unknown leaf is somebody else's feature, not
// a corrupt tree, and dropping it silently would change what the rule does.

import type { ComponentType } from 'react'
import type { TFunction } from 'i18next'
import { Combobox, Input } from '@ui'
import type { Catalog, CondNode, FieldDef, Operator, TriggerRow } from './types'
import { LIST_OPERATORS, UNARY_OPERATORS } from './types'
import { compare, lookup, type Json } from './compare'

/** Everything a leaf kind may need about the rule being edited. */
export interface LeafContext {
  trigger: TriggerRow | undefined
  /**
   * The whole catalogue. A kind whose vocabulary is not carried by the trigger
   * reads it from here — the detector leaf names a detector, and the list of
   * detectors is served next to the triggers rather than inside one.
   */
  catalog: Catalog | undefined
  t:       TFunction
}

export interface LeafEditorProps {
  node:     CondNode
  onChange: (next: CondNode) => void
  ctx:      LeafContext
  disabled?: boolean
}

/**
 * A ceiling that belongs to ONE kind, on top of the shared leaf budget.
 *
 * Declared here rather than read by the builder, for the same reason the rest
 * of this file exists: the builder counts nodes, it does not know what makes a
 * node expensive. A kind that costs a regex scan per content part says so, and
 * gets its counter and its refusal without ConditionTree growing a branch.
 */
export interface LeafQuota {
  /** From the catalogue. `undefined` ⇒ this build knows of no ceiling. */
  max:   (ctx: LeafContext) => number | undefined
  /** The counter, worded by the kind: "Détections 2 / 8". */
  label: (t: TFunction, used: number, max: number) => string
  /** Shown when the tree already holds more than the ceiling. */
  over:  (t: TFunction, max: number) => string
}

export interface LeafKindDef {
  /** Wire discriminator (`node.type`). */
  type: string
  /** Menu entry of "add a condition". */
  label: (t: TFunction) => string
  /** Offered only when this answers true (defaults to always). */
  isAvailable?: (ctx: LeafContext) => boolean
  create: (ctx: LeafContext) => CondNode
  Editor: ComponentType<LeafEditorProps>
  /** One clause of the natural-language summary. */
  describe: (node: CondNode, ctx: LeafContext, t: TFunction) => string
  /**
   * Client-side refusal, worded for the operator. `null` ⇒ nothing to say.
   *
   * Only for what the server refuses too: the point is to spare a 422 the
   * operator meets ten minutes after writing the rule, never to invent a stricter
   * rule than the engine's.
   */
  validate?: (node: CondNode, ctx: LeafContext, t: TFunction) => string | null
  quota?: LeafQuota
  /**
   * Browser-side verdict. Return `'unknown'` when the kind genuinely cannot be
   * decided client-side — the tester then says so instead of guessing, which is
   * the difference between a debugger and a decoration.
   */
  evaluate: (node: CondNode, facts: Json) => boolean | 'unknown'
  /** Fragment merged into the prefilled sample fact of the tester. */
  sampleFacts?: (node: CondNode, ctx: LeafContext) => Record<string, unknown>
}

const REGISTRY = new Map<string, LeafKindDef>()

export function registerLeafKind(def: LeafKindDef): void {
  REGISTRY.set(def.type, def)
}

export function leafKinds(ctx: LeafContext): LeafKindDef[] {
  return [...REGISTRY.values()].filter(k => (k.isAvailable ? k.isAvailable(ctx) : true))
}

export function leafKindOf(node: CondNode): LeafKindDef | undefined {
  const type = (node as { type?: string }).type
  return type ? REGISTRY.get(type) : undefined
}

export function isKnownLeaf(node: CondNode): boolean {
  return leafKindOf(node) !== undefined
}

/** Verdict of one leaf, whatever its kind. Unknown kinds cannot be decided. */
export function evaluateLeaf(node: CondNode, facts: Json): boolean | 'unknown' {
  const kind = leafKindOf(node)
  return kind ? kind.evaluate(node, facts) : 'unknown'
}

export function describeLeaf(node: CondNode, ctx: LeafContext, t: TFunction): string {
  const kind = leafKindOf(node)
  if (kind) return kind.describe(node, ctx, t)
  return t('admin.rl_leaf_unknown', { type: (node as { type?: string }).type ?? '?' })
}

/**
 * Everything the leaves of a tree refuse, in the order they appear.
 *
 * An unknown kind contributes nothing: this build cannot judge somebody else's
 * leaf, and blocking a save on a shape it does not understand would make the
 * console the reason a rule cannot be edited.
 */
export function leafErrors(leaves: CondNode[], ctx: LeafContext, t: TFunction): string[] {
  const out: string[] = []
  for (const leaf of leaves) {
    const message = leafKindOf(leaf)?.validate?.(leaf, ctx, t)
    if (message && !out.includes(message)) out.push(message)
  }
  return out
}

/** One kind's ceiling, with how much of it is used. */
export interface LeafQuotaState {
  type:  string
  used:  number
  max:   number
  label: string
  over:  string
}

/**
 * Per-kind counters, for the builder's counter row and for the save guard.
 *
 * A kind is listed as soon as it declares a ceiling this build can read — even
 * at zero, so an operator sees "Détections 0 / 8" before they need it rather
 * than discovering the ceiling by hitting it.
 */
export function leafQuotas(leaves: CondNode[], ctx: LeafContext, t: TFunction): LeafQuotaState[] {
  const out: LeafQuotaState[] = []
  for (const kind of leafKinds(ctx)) {
    if (!kind.quota) continue
    const max = kind.quota.max(ctx)
    if (max === undefined) continue
    const used = leaves.filter(l => leafKindOf(l)?.type === kind.type).length
    out.push({
      type:  kind.type,
      used,
      max,
      label: kind.quota.label(t, used, max),
      over:  kind.quota.over(t, max),
    })
  }
  return out
}

// ── The comparison, the one kind the core ships ──────────────────────────────

interface CompareShape { type: 'compare'; field: string; op: Operator; value?: unknown }

/**
 * The fields a comparison may name.
 *
 * A field declaring no operator is not comparable — that is how the server
 * marks a content part, and a comparison against one is refused at write time.
 * Offering it would give the operator a field whose operator list is empty and
 * no way to tell why.
 */
function fieldsOf(ctx: LeafContext): FieldDef[] {
  return (ctx.trigger?.fields ?? []).filter(f => (f.operators?.length ?? 0) > 0)
}

function fieldDef(ctx: LeafContext, name: string): FieldDef | undefined {
  return fieldsOf(ctx).find(f => f.name === name)
}

/** Text ⇄ value, driven by the field's declared type and by the operator. */
function parseValue(raw: string, type: string | undefined, op: Operator): unknown {
  if (LIST_OPERATORS.includes(op)) {
    return raw.split(',').map(s => s.trim()).filter(Boolean)
      .map(s => (type === 'number' ? Number(s) : s))
  }
  if (type === 'number') {
    const n = Number(raw.trim())
    return raw.trim() === '' ? '' : (Number.isFinite(n) ? n : raw)
  }
  if (type === 'bool') return raw === 'true'
  return raw
}

function valueToText(value: unknown, op: Operator): string {
  if (LIST_OPERATORS.includes(op)) {
    return Array.isArray(value) ? value.map(v => String(v)).join(', ') : ''
  }
  if (value === undefined || value === null) return ''
  return String(value)
}

/** Human phrasing of a value, for the summary. */
function valuePhrase(value: unknown, op: Operator, t: TFunction): string {
  if (UNARY_OPERATORS.includes(op)) return ''
  if (LIST_OPERATORS.includes(op)) {
    const items = Array.isArray(value) ? value : []
    return items.length ? items.map(v => `« ${String(v)} »`).join(', ') : t('admin.rl_value_empty')
  }
  if (value === undefined || value === null || value === '') return t('admin.rl_value_empty')
  return `« ${String(value)} »`
}

function CompareEditor({ node, onChange, ctx, disabled }: LeafEditorProps) {
  const { t } = ctx
  const cmp = node as CompareShape
  const fields = fieldsOf(ctx)
  const def = fieldDef(ctx, cmp.field)
  // The operator list comes from the FIELD, never from a hard-coded table: the
  // server refuses `starts_with` on a timestamp, so the editor must not offer it.
  const operators: Operator[] = def?.operators ?? []

  const fieldOptions = fields.map(f => ({
    value: f.name,
    label: f.label,
    description: f.name,
    keywords: `${f.name} ${f.type}`,
  }))
  const opOptions = operators.map(o => ({ value: o, label: t(`admin.rl_op_${o}`) }))

  const setField = (name: string) => {
    const next = fieldDef(ctx, name)
    // Keep the operator when the new field still allows it, otherwise fall back
    // to the first one it declares — an operator it refuses is a 422 waiting.
    const op = next?.operators.includes(cmp.op) ? cmp.op : (next?.operators[0] ?? 'eq')
    onChange({ type: 'compare', field: name, op, value: UNARY_OPERATORS.includes(op) ? null : '' })
  }

  const setOp = (op: Operator) => {
    const keep = UNARY_OPERATORS.includes(op) ? null
      : LIST_OPERATORS.includes(op) ? (Array.isArray(cmp.value) ? cmp.value : [])
      : (Array.isArray(cmp.value) ? '' : cmp.value ?? '')
    onChange({ ...cmp, op, value: keep })
  }

  const unary = UNARY_OPERATORS.includes(cmp.op)

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <Combobox
        value={cmp.field || null}
        onChange={setField}
        options={fieldOptions}
        placeholder={t('admin.rl_pick_field')}
        disabled={disabled}
        width={200}
        aria-label={t('admin.rl_field')}
      />
      <Combobox
        value={cmp.op || null}
        onChange={v => setOp(v as Operator)}
        options={opOptions}
        placeholder={t('admin.rl_pick_operator')}
        disabled={disabled || !cmp.field}
        width={190}
        aria-label={t('admin.rl_operator')}
      />
      {!unary && (
        def?.type === 'bool' ? (
          <Combobox
            value={String(cmp.value ?? 'true')}
            onChange={v => onChange({ ...cmp, value: v === 'true' })}
            options={[
              { value: 'true',  label: t('admin.rl_bool_true') },
              { value: 'false', label: t('admin.rl_bool_false') },
            ]}
            disabled={disabled}
            width={130}
            aria-label={t('admin.rl_value')}
          />
        ) : (
          <Input
            value={valueToText(cmp.value, cmp.op)}
            onChange={e => onChange({ ...cmp, value: parseValue(e.target.value, def?.type, cmp.op) })}
            placeholder={LIST_OPERATORS.includes(cmp.op) ? t('admin.rl_value_list_ph') : t('admin.rl_value_ph')}
            disabled={disabled}
            className="min-w-0 flex-1"
            aria-label={t('admin.rl_value')}
          />
        )
      )}
    </div>
  )
}

registerLeafKind({
  type:  'compare',
  label: t => t('admin.rl_leaf_compare'),
  create: (ctx) => {
    const first = fieldsOf(ctx)[0]
    return {
      type: 'compare',
      field: first?.name ?? '',
      op: (first?.operators[0] ?? 'eq') as Operator,
      value: '',
    }
  },
  Editor: CompareEditor,
  describe: (node, ctx, t) => {
    const cmp = node as CompareShape
    const label = fieldDef(ctx, cmp.field)?.label ?? cmp.field ?? '?'
    if (!cmp.field) return t('admin.rl_leaf_incomplete')
    const op = t(`admin.rl_op_${cmp.op}`)
    const value = valuePhrase(cmp.value, cmp.op, t)
    return value ? `${label} ${op} ${value}` : `${label} ${op}`
  },
  evaluate: (node, facts) => {
    const cmp = node as CompareShape
    if (!cmp.field) return 'unknown'
    return compare(lookup(facts, cmp.field), cmp.op, cmp.value)
  },
  sampleFacts: (node, ctx) => {
    const cmp = node as CompareShape
    if (!cmp.field) return {}
    const def = fieldDef(ctx, cmp.field)
    // A value the comparison would plausibly see, so the prefilled fact is a
    // starting point rather than an empty object the operator has to invent.
    let sample: unknown = ''
    if (LIST_OPERATORS.includes(cmp.op)) sample = Array.isArray(cmp.value) ? cmp.value[0] ?? '' : ''
    else if (UNARY_OPERATORS.includes(cmp.op)) sample = def?.type === 'bool' ? true : 'exemple'
    else sample = cmp.value ?? ''
    if (sample === '' || sample === undefined) {
      sample = def?.type === 'number' ? 0 : def?.type === 'bool' ? true : 'exemple'
    }
    // Dotted paths become nested objects, exactly as the lookup walks them.
    const segments = cmp.field.split('.').filter(Boolean)
    if (segments.length === 0) return {}
    const root: Record<string, unknown> = {}
    let cursor = root
    segments.forEach((seg, i) => {
      if (i === segments.length - 1) cursor[seg] = sample
      else {
        cursor[seg] = {}
        cursor = cursor[seg] as Record<string, unknown>
      }
    })
    return root
  },
})

/** Sample fact contributed by one leaf, whatever its kind. */
export function sampleOfLeaf(node: CondNode, ctx: LeafContext): Record<string, unknown> {
  return leafKindOf(node)?.sampleFacts?.(node, ctx) ?? {}
}
