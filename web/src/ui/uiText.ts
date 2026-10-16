import type { TFunction } from 'i18next'

/**
 * Localisation plumbing shared by the `@ui` primitives that carry their own text
 * (DataTable, Combobox, Stepper, Toast, EmptyState…).
 *
 * `@ui` is a standalone library consumed by 18 independent module bundles, so it
 * must never `import 'react-i18next'` and reach for a provider that may not be
 * mounted. The established convention (see `Tabs`) is therefore an OPTIONAL `t`
 * prop: when the caller passes its own `TFunction` the strings come from the
 * host catalogue (`ui.*` in `core/i18n/locales/<lng>/core.json`), and otherwise
 * they fall back to the English defaults below. A primitive is thus always
 * readable, never blank, and never crashes outside an i18n tree.
 */

/** English fallbacks - also the reference wording for the `ui.*` catalogue. */
export const UI_FALLBACK: Record<string, string> = {
  // Generic
  'ui.close':        'Close',
  'ui.cancel':       'Cancel',
  'ui.clear':        'Clear',
  'ui.retry':        'Retry',
  'ui.learn_more':   'Learn more',
  'ui.more_actions': 'More actions',
  'ui.actions':      'Actions',

  // Combobox
  'ui.cb_search':      'Search…',
  'ui.cb_select':      'Select…',
  'ui.cb_no_results':  'No match',
  'ui.cb_clear':       'Clear selection',

  // ProgressBar
  'ui.pb_progress': 'Progress',

  // Stepper
  'ui.st_step':      'Step',
  'ui.st_of':        'of',
  'ui.st_done':      'Completed',
  'ui.st_error':     'Needs attention',
  'ui.st_optional':  'Optional',

  // DataTable
  'ui.dt_select_all':    'Select all rows',
  'ui.dt_select_row':    'Select row',
  'ui.dt_selected':      'selected',
  'ui.dt_clear_sel':     'Clear selection',
  'ui.dt_columns':       'Columns',
  'ui.dt_sort_asc':      'Sort ascending',
  'ui.dt_sort_desc':     'Sort descending',
  'ui.dt_prev_page':     'Previous page',
  'ui.dt_next_page':     'Next page',
  'ui.dt_page':          'Page',
  'ui.dt_rows_per_page': 'Rows per page',
  'ui.dt_loading':       'Loading rows…',
  'ui.dt_empty_title':   'Nothing here yet',
  'ui.dt_empty_desc':    'Items you add will show up in this table.',
  'ui.dt_nores_title':   'No result',
  'ui.dt_nores_desc':    'No row matches the current filters.',
  'ui.dt_clear_filters': 'Clear filters',
  'ui.dt_error_title':   'Could not load the data',
  'ui.dt_error_desc':    'The request failed. Check the connection and try again.',
  // Copy context menu
  'ui.dt_copy_cell':      'Copy this cell',
  'ui.dt_copy_row':       'Copy this row',
  'ui.dt_copy_card':      'Copy this card',
  'ui.dt_copy_column':    'Copy the column “{{name}}”',
  'ui.dt_copy_selection': 'Copy the selected text',
  'ui.dt_copied':         'Copied',
  'ui.dt_resize_column':  'Resize the column “{{name}}”',
}

/**
 * Build a translator for a primitive: uses the caller's `t` when provided,
 * otherwise the English fallback. Unknown keys degrade to the key itself rather
 * than to an empty string, so a missing entry is visible instead of silent.
 */
export function uiT(t?: TFunction): (key: string, vars?: Record<string, unknown>) => string {
  return (key, vars) => {
    if (t) {
      // `defaultValue` keeps the English wording when a locale lacks the key.
      const out = t(key, { defaultValue: UI_FALLBACK[key] ?? key, ...vars })
      if (typeof out === 'string') return out
    }
    let out = UI_FALLBACK[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{{${k}}}`, String(v))
    return out
  }
}

/**
 * Fold a string for local, human-friendly matching: Unicode-decomposed, stripped
 * of diacritics, lower-cased. This is what makes typing "unites" match "Unités" -
 * and, symmetrically, "Unités" match "unites". Decomposition (NFD) splits an
 * accented letter into base + combining mark, and the mark is then removed.
 */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** True when `needle` (folded) is contained in `haystack` (folded). */
export function foldIncludes(haystack: string, needle: string): boolean {
  if (!needle) return true
  return foldText(haystack).includes(foldText(needle))
}
