import type { MentionMatch } from './types'

// Fold one character for diacritic/case-insensitive matching. Decomposition
// (NFD) splits an accented letter into base + combining mark, and the mark is
// stripped - so "é" folds to "e" and "Ç" to "c".
function foldChar(ch: string): string {
  return ch.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function foldAll(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * Build a folded copy of `s` together with a map from each folded-string index
 * back to the ORIGINAL character index. This keeps the highlight aligned even
 * when folding changes length (a decomposed ligature, a stripped mark…), which
 * a plain `foldText(...).indexOf(...)` would silently corrupt.
 */
function buildFold(s: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  for (let i = 0; i < s.length; i++) {
    const f = foldChar(s[i])
    for (const c of f) {
      folded += c
      map.push(i)
    }
  }
  return { folded, map }
}

export interface HighlightSegment {
  text: string
  hit: boolean
}

/**
 * Split `label` into segments, marking the (first) run that matches `query`
 * accent- and case-insensitively. Returns a single non-hit segment when there
 * is no match or no query.
 */
export function highlightMatch(label: string, query: string): HighlightSegment[] {
  const q = foldAll(query.trim())
  if (!q) return [{ text: label, hit: false }]
  const { folded, map } = buildFold(label)
  const fi = folded.indexOf(q)
  if (fi < 0) return [{ text: label, hit: false }]
  const start = map[fi]
  const end = map[fi + q.length - 1] + 1
  const segs: HighlightSegment[] = []
  if (start > 0) segs.push({ text: label.slice(0, start), hit: false })
  segs.push({ text: label.slice(start, end), hit: true })
  if (end < label.length) segs.push({ text: label.slice(end), hit: false })
  return segs
}

/**
 * Detect a trigger occurrence at the caret. The trigger must be preceded by the
 * start of text or a whitespace, and followed by non-space characters (which
 * form the query). Scans `textBeforeCaret` - the text from the start of the
 * current line/node up to the caret.
 */
export function detectMention(textBeforeCaret: string, trigger = '@'): MentionMatch | null {
  const esc = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|\\s)(${esc})(\\S*)$`)
  const m = re.exec(textBeforeCaret)
  if (!m) return null
  const query = m[2]
  const end = textBeforeCaret.length
  const start = end - query.length - trigger.length
  return { query, trigger, start, end }
}
