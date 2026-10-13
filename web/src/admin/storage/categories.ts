import { useMemo } from 'react'
import type { TFunction } from 'i18next'
import { MAX_SERIES, NEUTRAL_SERIES, useSeriesScale } from './charts'
import type { CatalogEntry, CategoryUsage } from './api'

/**
 * The category vocabulary, as far as the frontend is allowed to know it.
 *
 * **Only the labels live here.** Which categories are billed, and which occupy
 * the volume, is stated by the server's `catalog` and by the flags each row
 * carries — never by this file. A build that hard-coded the rules would keep
 * drawing yesterday's answer the day the server changed its mind, and would have
 * nothing at all to say about a category it has never heard of.
 */
const LABEL_KEY: Record<string, string> = {
  content:    'admin.sto_cat_content',
  trash:      'admin.sto_cat_trash',
  versions:   'admin.sto_cat_versions',
  retention:  'admin.sto_cat_retention',
  thumbnails: 'admin.sto_cat_thumbnails',
  index:      'admin.sto_cat_index',
  cache:      'admin.sto_cat_cache',
  staging:    'admin.sto_cat_staging',
  system:     'admin.sto_cat_system',
  delegated:  'admin.sto_cat_delegated',
}

/** The identifier the anti-double-count rule is expressed through. */
export const DELEGATED = 'delegated'

/** The one an operator empties before granting more quota. */
export const TRASH = 'trash'

/**
 * A readable name for a category id, including one this build predates.
 *
 * The fallback prints the raw identifier rather than "Other": an operator faced
 * with an unnamed slice can at least search for the word, and the alternative
 * silently merges two unrelated things under one label.
 */
export function categoryLabel(t: TFunction, id: string): string {
  const key = LABEL_KEY[id]
  return key ? t(key) : t('admin.sto_cat_unknown', { id })
}

/** Whether this build knows the identifier by name. */
export function isKnownCategory(id: string): boolean {
  return id in LABEL_KEY
}

export interface CategoryRules {
  /** Position in the server's catalog. Unknown ids sort last, but stay stable. */
  order:  (id: string) => number
  billable: (row: CategoryUsage) => boolean
  held:     (row: CategoryUsage) => boolean
}

/**
 * The catalog turned into lookups.
 *
 * The row's own flags are the fallback, not the source: the catalog is what the
 * server calls authoritative, and a row that disagrees with it is a transport
 * accident rather than a second opinion.
 */
export function useCategoryRules(catalog: CatalogEntry[] | undefined): CategoryRules {
  return useMemo(() => {
    const list = catalog ?? []
    const index = new Map(list.map((c, i) => [c.id, i]))
    const rules = new Map(list.map(c => [c.id, c]))
    return {
      order:    (id: string) => index.get(id) ?? list.length + 1,
      billable: (row: CategoryUsage) => rules.get(row.category)?.billable ?? row.billable,
      held:     (row: CategoryUsage) => rules.get(row.category)?.held ?? row.held,
    }
  }, [catalog])
}

export interface CategorySlice {
  row:      CategoryUsage
  label:    string
  color:    string
  billable: boolean
}

export interface CategoryReading {
  /** Held categories with a volume, in catalog order — never in rank order. */
  slices:     CategorySlice[]
  /** Past the eight-hue scale, folded into one entry. `null` when it is empty. */
  folded:     { count: number; bytes: number } | null
  /** Everything held, as the rows account for it. */
  heldBytes:  number
  /** The share of that which is charged to a quota. */
  billedBytes: number
  /** The row the operator is asked to look at first, if it carries anything. */
  trash:      CategoryUsage | null
}

/**
 * Turns a category list into something drawable.
 *
 * Colour is bound to the category's place in the **catalog**, filtered to the
 * categories actually present: a category keeps its hue as the numbers move, and
 * the scale is not spent on rows that draw nothing. `delegated` is excluded here
 * by its own `held: false` — it belongs to no total, and every caller renders it
 * separately and says so.
 */
export function useCategoryReading(
  rows: CategoryUsage[] | undefined,
  rules: CategoryRules,
  t: TFunction,
): CategoryReading {
  const series = useSeriesScale()

  return useMemo(() => {
    const all = rows ?? []
    const held = all
      .filter(r => rules.held(r) && r.used_bytes > 0)
      .sort((a, b) => rules.order(a.category) - rules.order(b.category))

    const shown = held.slice(0, MAX_SERIES)
    const tail  = held.slice(MAX_SERIES)

    return {
      slices: shown.map((row, i) => ({
        row,
        label:    categoryLabel(t, row.category),
        color:    series[i] ?? NEUTRAL_SERIES,
        billable: rules.billable(row),
      })),
      folded: tail.length > 0
        ? { count: tail.length, bytes: tail.reduce((s, r) => s + r.used_bytes, 0) }
        : null,
      heldBytes:   held.reduce((s, r) => s + r.used_bytes, 0),
      billedBytes: held.filter(r => rules.billable(r)).reduce((s, r) => s + r.used_bytes, 0),
      trash:       all.find(r => r.category === TRASH && r.used_bytes > 0) ?? null,
    }
  }, [rows, rules, series, t])
}
