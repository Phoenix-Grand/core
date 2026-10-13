// The `detector` leaf — "this content carries sensitive data of a named kind".
//
// ── Why it is a separate file that registers itself ──────────────────────────
// Content inspection is somebody else's feature: the detectors, their patterns,
// their trial screen and their audit trail live under `../detectors`. What the
// condition builder needed was not knowledge of any of that, but one entry in
// its registry. So this file registers a kind and nothing else — no `switch` was
// added to ConditionTree, to the summary or to the tester for it to exist.
//
// ── Thresholds, never logic ──────────────────────────────────────────────────
// The leaf carries a catalogue key and three numbers. There is no pattern here
// and nothing to interpret, which is what let content inspection arrive without
// an expression language arriving with it. The three numbers are independent on
// purpose and each answers a different question:
//
//   • confidence  — how sure a single match must be before it counts at all;
//   • matches     — how much of the text is about the thing;
//   • unique      — how many DISTINCT values it carries, which is the only one
//                   of the three that measures how many people are exposed.
//                   Fifty copies of one account number are not fifty accounts.
//
// A leaf asking for more distinct values than occurrences is unreachable —
// distinct values are a subset of occurrences — and the server refuses it. The
// editor refuses it first, and says why, because a threshold that can never be
// met would sit in the console looking armed.
//
// ── Why it cannot be evaluated in the browser ────────────────────────────────
// `evaluate` answers `'unknown'`, always. The detectors are server-side: their
// patterns, their checksums, their proximity windows and their scan ceilings. A
// second implementation here would be a second truth, it would drift from the
// first, and the moment it drifted it would hand an operator a reassuring green
// tick for a rule that does not fire. The tester already knows how to say "this
// build cannot decide it" — that is the honest answer and it is the one given.

import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { TFunction } from 'i18next'
import { FlaskConical } from 'lucide-react'
import { Checkbox, Combobox, Input } from '@ui'
import { asPercent, categoryLabel, categoryOrder } from '../detectors/labels'
import { registerLeafKind, type LeafContext, type LeafEditorProps } from './leafKinds'
import { adminUrl } from '../adminAction'
import type { CondNode, DetectorNode, DetectorRow, FieldDef } from './types'

/** The server's own bounds, restated so the editor stops short of a 422. */
const MIN_COUNT = 1
const MAX_COUNT = 10_000

function clampCount(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_COUNT
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(raw)))
}

/** Two decimals: the wire carries an `f32`, so 0.7 arrives as 0.699999988… */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** A node read as a detector leaf, with every default the server would apply. */
function asDetector(node: CondNode): DetectorNode {
  const n = node as Partial<DetectorNode>
  return {
    type:               'detector',
    detector:           typeof n.detector === 'string' ? n.detector : '',
    min_confidence:     typeof n.min_confidence === 'number' ? n.min_confidence : 0.7,
    min_matches:        typeof n.min_matches === 'number' ? n.min_matches : 1,
    min_unique_matches: typeof n.min_unique_matches === 'number' ? n.min_unique_matches : 1,
    parts:              Array.isArray(n.parts) ? n.parts.filter(p => typeof p === 'string') : [],
  }
}

// ── The two vocabularies, both read from the catalogue ───────────────────────

/** The enabled detectors, ordered as the detector screen orders them. */
function detectorsOf(ctx: LeafContext): DetectorRow[] {
  const list = ctx.catalog?.detectors ?? []
  return [...list].sort((a, b) =>
    categoryOrder(a.category) - categoryOrder(b.category) || a.label.localeCompare(b.label))
}

/**
 * The content parts of the current trigger.
 *
 * From the trigger's own fields, never from a list baked in here: a module that
 * declares a trigger with an "extracted attachment text" part gets it offered
 * without a line changing in the console.
 */
function contentPartsOf(ctx: LeafContext): FieldDef[] {
  const marker = ctx.catalog?.content_field_type ?? 'content'
  return (ctx.trigger?.fields ?? []).filter(f => f.type === marker)
}

function partLabel(ctx: LeafContext, name: string): string {
  const label = contentPartsOf(ctx).find(f => f.name === name)?.label
  if (!label) return name
  // Mid-sentence in the summary, so a leading capital reads as a mistake —
  // unless the label opens on an acronym ("IBAN du bénéficiaire").
  if (label.length > 1 && label[1] === label[1].toUpperCase()) return label
  return label.charAt(0).toLowerCase() + label.slice(1)
}

/** "a, b ou c" — the comma-then-conjunction form every locale expects. */
function joinOr(items: string[], t: TFunction): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(t('admin.rl_join_comma'))} ${t('admin.rl_det_or')} ${items[items.length - 1]}`
}

// ── The editor row ───────────────────────────────────────────────────────────

function DetectorLeafEditor({ node, onChange, ctx, disabled }: LeafEditorProps) {
  const { t } = ctx
  const navigate = useNavigate()
  const leaf = asDetector(node)

  const detectors = useMemo(() => detectorsOf(ctx), [ctx])
  const parts     = useMemo(() => contentPartsOf(ctx), [ctx])
  const current   = detectors.find(d => d.key === leaf.detector)
  // Same address for the href and the click handler: a real link the operator
  // can middle-click, and an in-app navigation when they simply click.
  const detectorHref = adminUrl({ tab: 'detectors', params: { detector: current?.key } })

  const options = detectors.map(d => ({
    value:       d.key,
    label:       d.label,
    description: d.description ?? d.key,
    group:       categoryLabel(t, d.category),
    keywords:    `${d.key} ${d.category} ${d.kind}`,
  }))

  const set = (patch: Partial<DetectorNode>) => onChange({ ...leaf, ...patch })

  // Picking a detector adopts ITS thresholds: they were tuned on its own screen,
  // against its own samples, and a leaf that silently kept the previous
  // detector's numbers would be tuned for a pattern it no longer names.
  const setDetector = (key: string) => {
    const row = detectors.find(d => d.key === key)
    set({
      detector:           key,
      min_confidence:     round2(row?.min_confidence ?? leaf.min_confidence),
      min_matches:        clampCount(row?.min_matches ?? leaf.min_matches),
      min_unique_matches: clampCount(row?.min_unique_matches ?? leaf.min_unique_matches),
    })
  }

  const togglePart = (name: string, on: boolean) => {
    const next = on ? [...leaf.parts, name] : leaf.parts.filter(p => p !== name)
    // Ordered as the trigger declares them, so the summary reads the same way
    // whichever order the boxes were ticked in.
    set({ parts: parts.map(f => f.name).filter(n => next.includes(n)) })
  }

  const unreachable = leaf.min_unique_matches > leaf.min_matches
  const percent = Math.round(leaf.min_confidence * 100)

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Combobox
          value={leaf.detector || null}
          onChange={setDetector}
          options={options}
          placeholder={t('admin.rl_det_pick')}
          emptyLabel={t('admin.rl_det_none')}
          disabled={disabled}
          width={230}
          aria-label={t('admin.rl_det_detector')}
          t={t}
        />

        <label className="inline-flex items-center gap-1.5 text-text-secondary"
          style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.rl_det_confidence')}
          <Input
            type="number" min={0} max={100} step={5}
            value={String(percent)}
            disabled={disabled}
            className="w-[4.5rem]"
            aria-label={t('admin.rl_det_confidence_aria')}
            onChange={e => set({
              min_confidence: round2(Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100),
            })}
          />
          <span aria-hidden>%</span>
        </label>

        <label className="inline-flex items-center gap-1.5 text-text-secondary"
          style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.rl_det_matches')}
          <Input
            type="number" min={MIN_COUNT} max={MAX_COUNT}
            value={String(leaf.min_matches)}
            disabled={disabled}
            className="w-[5rem]"
            aria-label={t('admin.rl_det_matches_aria')}
            onChange={e => set({ min_matches: clampCount(Number(e.target.value)) })}
          />
        </label>

        <label className="inline-flex items-center gap-1.5 text-text-secondary"
          style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.rl_det_unique')}
          <Input
            type="number" min={MIN_COUNT} max={MAX_COUNT}
            value={String(leaf.min_unique_matches)}
            disabled={disabled}
            // The sentence below carries the explanation; the field only has to
            // show WHICH of the three numbers is the one to bring down.
            className={unreachable ? 'w-[5rem] border-danger' : 'w-[5rem]'}
            aria-invalid={unreachable || undefined}
            aria-label={t('admin.rl_det_unique_aria')}
            onChange={e => set({ min_unique_matches: clampCount(Number(e.target.value)) })}
          />
        </label>

        {current && (
          // The detector is tuned where it can be tried against a real sample —
          // this row states thresholds, that screen shows what they do.
          <a
            href={detectorHref}
            onClick={e => { e.preventDefault(); navigate(detectorHref) }}
            className="inline-flex items-center gap-1 text-primary hover:underline"
            style={{ fontSize: 'var(--kb-text-meta)' }}
          >
            <FlaskConical size={13} aria-hidden />
            {t('admin.rl_det_open_trial')}
          </a>
        )}
      </div>

      {unreachable && (
        <p className="text-danger" role="alert" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.rl_det_unreachable', {
            unique: leaf.min_unique_matches,
            matches: leaf.min_matches,
          })}
        </p>
      )}

      {parts.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {t('admin.rl_det_parts')}
          </span>
          {parts.map(f => (
            <Checkbox
              key={f.name}
              checked={leaf.parts.includes(f.name)}
              onChange={v => togglePart(f.name, v)}
              disabled={disabled}
              label={f.label}
              // The primitive's default label colour is a literal, so it stays
              // near-black on a dark theme. Overridden with the token.
              labelClassName="text-text-primary"
            />
          ))}
        </div>
      )}

      {leaf.parts.length === 0 && (
        <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          {t('admin.rl_det_parts_none_hint')}
        </p>
      )}
    </div>
  )
}

// ── Registration ─────────────────────────────────────────────────────────────

registerLeafKind({
  type:  'detector',
  label: t => t('admin.rl_leaf_detector'),

  // Two reasons it may be absent, and both would otherwise produce a rule the
  // server refuses: a trigger that submits no content has nothing to inspect,
  // and an instance whose detectors are all disabled has nothing to name.
  isAvailable: ctx =>
    (ctx.catalog?.leaf_types ?? ['compare', 'detector']).includes('detector')
    && contentPartsOf(ctx).length > 0
    && detectorsOf(ctx).length > 0,

  create: (ctx) => {
    const first = detectorsOf(ctx)[0]
    return {
      type:               'detector',
      detector:           first?.key ?? '',
      // The detector's own thresholds, not defaults of the console's invention.
      min_confidence:     round2(first?.min_confidence ?? 0.7),
      min_matches:        clampCount(first?.min_matches ?? 1),
      min_unique_matches: clampCount(first?.min_unique_matches ?? 1),
      // No part named = every part the caller submits, which is the widest and
      // therefore the safest starting point.
      parts:              [],
    } satisfies DetectorNode
  },

  Editor: DetectorLeafEditor,

  describe: (node, ctx, t) => {
    const leaf = asDetector(node)
    if (!leaf.detector) return t('admin.rl_leaf_incomplete')

    const row = detectorsOf(ctx).find(d => d.key === leaf.detector)
    // A detector that is gone or disabled must READ as gone: the rule is stored
    // and armed, and the reason it never fires is exactly this line.
    if (!row) return t('admin.rl_det_missing', { key: leaf.detector })

    const named = leaf.parts.map(p => partLabel(ctx, p))
    const partsPhrase = named.length === 0 ? t('admin.rl_det_parts_all') : joinOr(named, t)

    const thresholds = [t('admin.rl_det_th_confidence', { percent: asPercent(leaf.min_confidence) })]
    if (leaf.min_matches > 1) {
      thresholds.push(t('admin.rl_det_th_matches', { count: leaf.min_matches }))
    }
    if (leaf.min_unique_matches > 1) {
      thresholds.push(t('admin.rl_det_th_unique', { count: leaf.min_unique_matches }))
    }

    return t(named.length > 1 ? 'admin.rl_det_describe_many' : 'admin.rl_det_describe_one', {
      parts:      partsPhrase,
      detector:   row.label,
      thresholds: thresholds.join(t('admin.rl_join_comma')),
    })
  },

  // Never anything else. See the header: a browser-side detector would be a
  // second truth, and the first thing it would produce is a false green tick.
  evaluate: () => 'unknown',

  validate: (node, ctx, t) => {
    const leaf = asDetector(node)
    if (!leaf.detector) return t('admin.rl_det_err_no_detector')
    if (!detectorsOf(ctx).find(d => d.key === leaf.detector)) {
      return t('admin.rl_det_err_missing', { key: leaf.detector })
    }
    if (leaf.min_unique_matches > leaf.min_matches) {
      return t('admin.rl_det_err_unreachable', {
        detector: detectorsOf(ctx).find(d => d.key === leaf.detector)?.label ?? leaf.detector,
        unique:   leaf.min_unique_matches,
        matches:  leaf.min_matches,
      })
    }
    const known = contentPartsOf(ctx).map(f => f.name)
    const stray = leaf.parts.find(p => !known.includes(p))
    if (stray) return t('admin.rl_det_err_part', { part: stray })
    return null
  },

  quota: {
    max:   ctx => ctx.catalog?.limits?.detector_leaves,
    label: (t, used, max) => t('admin.rl_det_counter', { used, max }),
    over:  (t, max) => t('admin.rl_det_over_quota', { max }),
  },

  // No sample fact: content never enters `rules::facts`, so there is nothing
  // this leaf could plausibly add to the tester's prefilled object.
})
