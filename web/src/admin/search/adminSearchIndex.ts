import type { LucideIcon } from 'lucide-react'
import { foldText } from '@ui'

/**
 * ── Matching and ranking for the admin search ────────────────────────────────
 *
 * Two properties matter more than cleverness here.
 *
 * TOLERANCE. An administrator types fast, lower-case and without accents.
 * "unites" must find "Unités", "reinit mdp" must find "Réinitialiser le mot de
 * passe". Both sides are therefore folded — Unicode-decomposed, stripped of
 * diacritics, lower-cased — by `foldText`, the very function the `@ui` Combobox
 * filters with, so the whole product agrees on what "the same text" means.
 *
 * ORDER. A result list that is merely *correct* is useless: what the operator
 * wants must be first. Matching is therefore scored, not boolean:
 *
 *     the query STARTS the label            100   "reinit" → Réinitialiser…
 *     a WORD of the label starts with it     70   "passe"  → …mot de passe
 *     the label merely contains it           40   "asse"   → …passe
 *     only a SYNONYM starts with it          25   "mdp"    → (synonym)
 *     only a synonym contains it             12
 *
 * Every term of the query must match something, or the entry is rejected: a
 * two-word query is a conjunction, not a wish list. The final score is the mean
 * of the per-term scores, plus a small bonus for short labels, so an exact short
 * title outranks a long one that happens to contain the same word.
 */

// ── Scores ────────────────────────────────────────────────────────────────────
const S_LABEL_PREFIX = 100
const S_WORD_PREFIX  = 70
const S_SUBSTRING    = 40
const S_SYN_PREFIX   = 25
const S_SYN_SUB      = 12

/** What a placeholder target loses. Large enough that it never wins a tie. */
export const SOON_PENALTY = 10_000

/** Placeholders are also barred from the first three rows outright. */
export const SOON_MIN_RANK = 3

/** Splits a query into folded terms. Empty terms are dropped. */
export function queryTerms(q: string): string[] {
  return foldText(q).split(/[\s,;/]+/).filter(Boolean)
}

/** Words of a folded haystack, for the "word prefix" test. */
const words = (folded: string): string[] => folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/**
 * One entry, folded once: a search runs the whole catalogue on every keystroke,
 * so the normalisation must not be redone per comparison.
 */
export interface Folded {
  label:      string
  labelWords: string[]
  synonyms:   string
  synWords:   string[]
  length:     number
}

export function fold(label: string, synonyms = ''): Folded {
  const l = foldText(label)
  const s = foldText(synonyms)
  return { label: l, labelWords: words(l), synonyms: s, synWords: words(s), length: l.length }
}

/** Score of a single term against a folded entry. 0 = no match at all. */
function scoreTerm(f: Folded, term: string): number {
  if (f.label.startsWith(term)) return S_LABEL_PREFIX
  if (f.labelWords.some(w => w.startsWith(term))) return S_WORD_PREFIX
  if (f.label.includes(term)) return S_SUBSTRING
  if (f.synWords.some(w => w.startsWith(term))) return S_SYN_PREFIX
  if (f.synonyms.includes(term)) return S_SYN_SUB
  return 0
}

/**
 * Score of a whole query. Returns 0 when any term is unmatched — the entry is
 * then not a result at all.
 */
export function scoreEntry(f: Folded, terms: string[]): number {
  if (terms.length === 0) return 0
  let total = 0
  for (const term of terms) {
    const s = scoreTerm(f, term)
    if (s === 0) return 0
    total += s
  }
  // Mean, so a long query does not out-score a short one by sheer term count.
  // The length bonus (≤ 10) only ever breaks ties between equal-quality hits.
  return total / terms.length + Math.max(0, 10 - f.length / 8)
}

/**
 * Loose score, for "did you mean" suggestions on an empty result list: the best
 * single term wins, unmatched terms are forgiven. Never used for real results —
 * it would let one matching word drag in entries the operator did not ask for.
 */
export function scoreLoose(f: Folded, terms: string[]): number {
  let best = 0
  for (const term of terms) {
    // A one-letter term matches nearly everything; it may confirm but not carry.
    if (term.length < 2) continue
    best = Math.max(best, scoreTerm(f, term))
  }
  return best
}

// ── Result shape ──────────────────────────────────────────────────────────────

/** Categories, in the order they are painted. */
export type AdminResultKind =
  | 'action' | 'user' | 'group' | 'org-unit' | 'module' | 'setting' | 'page'

export const KIND_ORDER: AdminResultKind[] = [
  'action', 'user', 'group', 'org-unit', 'module', 'setting', 'page',
]

export interface AdminResult {
  /** Stable within a render — used as React key and as the ARIA option id. */
  key:        string
  kind:       AdminResultKind
  label:      string
  /** Second line: e-mail, description, setting key… */
  sublabel?:  string
  /** Menu path, shown as a breadcrumb under an action or a page. */
  segments?:  string[]
  url:        string
  score:      number
  /** Target is a declared placeholder: badged, ranked down, kept out of the top. */
  soon?:      boolean
  Icon?:      LucideIcon
  /** Users only — the row paints the real avatar when there is one. */
  avatarUrl?: string | null
}

/** Orders one category's hits (placeholders last, by construction) and caps them. */
export function rankCategory(results: AdminResult[], cap: number): AdminResult[] {
  const sorted = [...results].sort((a, b) =>
    (b.score - (b.soon ? SOON_PENALTY : 0)) - (a.score - (a.soon ? SOON_PENALTY : 0))
    || a.label.localeCompare(b.label))
  return sorted.slice(0, cap)
}

/**
 * Keeps every placeholder behind every real result, list-wide.
 *
 * This is the strong form of "never a placeholder in the first three rows": a
 * target that does not exist yet can never displace one that does, whatever
 * category it came from. It can only surface near the top when there are fewer
 * than three real answers — which is to say, when there is nothing to hide it
 * behind and naming it is more useful than an empty list. It is badged either
 * way, so it is never mistaken for a working destination.
 */
export function demoteSoon(flat: AdminResult[]): AdminResult[] {
  if (!flat.some(r => r.soon)) return flat
  return [...flat.filter(r => !r.soon), ...flat.filter(r => r.soon)]
}

/** One painted block: consecutive results of the same category. */
export interface ResultRun { kind: AdminResultKind; items: AdminResult[] }

/**
 * Splits the flat, keyboard-ordered list into consecutive same-category runs.
 *
 * Painting from the flat order — instead of grouping by category and hoping the
 * two agree — is what makes arrow navigation match what the eye reads, even
 * after a placeholder has been demoted past the categories that follow it.
 */
export function groupRuns(flat: AdminResult[]): ResultRun[] {
  const runs: ResultRun[] = []
  for (const item of flat) {
    const last = runs[runs.length - 1]
    if (last && last.kind === item.kind) last.items.push(item)
    else runs.push({ kind: item.kind, items: [item] })
  }
  return runs
}
