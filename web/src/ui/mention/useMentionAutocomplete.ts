import { useCallback, useRef, useState } from 'react'
import type { MentionItem, MentionMatch, MentionProvider } from './types'
import { detectMention } from './foldHighlight'
import { defaultMentionProviders } from './providerSource'

export interface MentionCaretContext {
  /** Text from the start of the current line/node up to the caret. */
  textBeforeCaret: string
  /** Viewport rect used to anchor the dropdown near the caret. */
  anchorRect: DOMRect | null
}

export interface UseMentionAutocompleteOptions {
  /** Explicit providers; when omitted, falls back to the registered source. */
  providers?: MentionProvider[]
  /** Trigger character (default `'@'`). */
  trigger?: string
  /** Max items shown / requested (default 6). */
  limit?: number
  /** Debounce before hitting providers, in ms (default 150). */
  debounceMs?: number
  /** Invoked when the user validates an item (Enter/Tab/click). */
  onSelect: (item: MentionItem, match: MentionMatch) => void
}

/**
 * Headless autocomplete engine shared by an `<input>` and a contenteditable.
 * The caller feeds it the caret context on every change (`handleCaret`) and
 * forwards key events (`handleKeyDown`); the hook owns the trigger detection,
 * the debounced + abortable provider search (merged and deduped), and the
 * keyboard navigation. It renders nothing - pair it with `<MentionList>`.
 */
export function useMentionAutocomplete(opts: UseMentionAutocompleteOptions) {
  const trigger = opts.trigger ?? '@'
  const limit = opts.limit ?? 6
  const debounceMs = opts.debounceMs ?? 150

  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MentionItem[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [query, setQuery] = useState('')
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [loading, setLoading] = useState(false)

  const matchRef = useRef<MentionMatch | null>(null)
  // The query the current dropdown is showing. Re-detecting the SAME query (e.g.
  // on a keyup fired by an arrow-key navigation) must NOT restart the search nor
  // reset the active index - otherwise every ↑/↓ would snap the highlight back.
  const shownQuery = useRef<string | null>(null)
  // A query the user explicitly dismissed with Escape. We must NOT reopen the
  // dropdown for it (the keyup that follows Escape would otherwise re-detect the
  // same @word and pop it straight back up). Cleared as soon as the query changes.
  const dismissed = useRef<string | null>(null)
  const seq = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const close = useCallback(() => {
    matchRef.current = null
    shownQuery.current = null
    abortRef.current?.abort()
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
    setItems([])
    setActiveIndex(0)
    setQuery('')
    setLoading(false)
  }, [])

  const runSearch = useCallback((q: string) => {
    const provs = opts.providers ?? defaultMentionProviders()
    if (!provs.length) {
      setItems([])
      setLoading(false)
      return
    }
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    const mySeq = ++seq.current
    setLoading(true)
    Promise.all(
      provs.map((p) => p.search(q, { limit, signal: ac.signal }).catch(() => [] as MentionItem[])),
    ).then((results) => {
      if (seq.current !== mySeq) return // a newer keystroke superseded this one
      const seen = new Set<string>()
      const merged: MentionItem[] = []
      for (const list of results) {
        for (const it of list) {
          const key = it.email ? it.email.toLowerCase() : it.id
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(it)
          if (merged.length >= limit) break
        }
        if (merged.length >= limit) break
      }
      setItems(merged)
      setActiveIndex(0)
      setLoading(false)
    })
  }, [opts.providers, limit])

  /** Feed the current caret context; opens/updates/closes the dropdown. */
  const handleCaret = useCallback((ctx: MentionCaretContext) => {
    const m = detectMention(ctx.textBeforeCaret, trigger)
    if (!m) {
      dismissed.current = null
      if (matchRef.current) close()
      return
    }
    matchRef.current = m
    setAnchorRect(ctx.anchorRect)
    // The user pressed Escape on this exact query → keep it dismissed.
    if (dismissed.current === m.query) return
    dismissed.current = null
    // Same query as the one already shown → keep the list and the active index
    // (this call came from a caret move, not a new character).
    if (shownQuery.current === m.query) return
    shownQuery.current = m.query
    setQuery(m.query)
    setOpen(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => runSearch(m.query), debounceMs)
  }, [trigger, debounceMs, runSearch, close])

  const selectItem = useCallback((it: MentionItem) => {
    const m = matchRef.current
    close()
    if (m) opts.onSelect(it, m)
  }, [close, opts])

  const selectActive = useCallback(() => {
    const it = items[activeIndex]
    if (it) selectItem(it)
  }, [items, activeIndex, selectItem])

  /**
   * Handle a key event while the dropdown may be open. Returns `true` when the
   * key was consumed (the caller should `preventDefault`). ESCAPE closes and
   * intentionally leaves the literal `@word` in place - that is how a user types
   * a plain word starting with `@`.
   */
  const handleKeyDown = useCallback((e: { key: string }): boolean => {
    if (!open) return false
    switch (e.key) {
      case 'ArrowDown':
        setActiveIndex((i) => (items.length ? (i + 1) % items.length : 0))
        return true
      case 'ArrowUp':
        setActiveIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
        return true
      case 'Enter':
      case 'Tab':
        if (items.length) {
          selectActive()
          return true
        }
        return false
      case 'Escape':
        dismissed.current = shownQuery.current // don't let the keyup reopen it
        close()
        return true
      default:
        return false
    }
  }, [open, items, selectActive, close])

  return {
    open,
    items,
    activeIndex,
    query,
    anchorRect,
    loading,
    handleCaret,
    handleKeyDown,
    close,
    setActiveIndex,
    selectItem,
    selectActive,
  }
}
