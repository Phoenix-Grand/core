import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Search, X } from 'lucide-react'
import { useIsMobile } from '@ui'
import { usePrivileges } from '../../core/authz/usePrivileges'
import { useAuthStore } from '../../core/store/authStore'
import { useSearchStore } from '../../core/store/searchStore'
import { canSeeTab } from '../adminNav'
import AdminSearchPanel from '../search/AdminSearchPanel'
import { pushRecent, readRecents, recentTab, type RecentTarget } from '../search/adminSearchRecents'
import type { AdminResult } from '../search/adminSearchIndex'
import {
  DESKTOP_CAPS, MOBILE_CAPS, useAdminSearchSources,
} from '../search/useAdminSearchSources'

/**
 * The admin console's search field — the way an experienced administrator gets
 * anywhere and does anything.
 *
 * Mounted in place of the shell's own bar while on `/admin` (registered through
 * `useSearchStore` in AdminPage). What it owns: the field, the keyboard, and the
 * decision of what a given key does. What it does NOT own: matching and ranking
 * (`search/adminSearchIndex.ts`), the catalogues (`search/useAdminSearchSources.ts`)
 * and the painting (`search/AdminSearchPanel.tsx`).
 *
 * ── Keyboard contract ────────────────────────────────────────────────────────
 *   ⌘/Ctrl+K, /   open the field from anywhere in the console (see AdminPage —
 *                 the shortcut must live where the field is not yet mounted)
 *   ↑ ↓           walk EVERY result, categories included: the operator ranks
 *                 answers, not sections
 *   ↵             activate the highlighted row — and the first row is always
 *                 highlighted, so "type, Enter" is a complete gesture
 *   Esc           close the list; a second Esc leaves search mode (the shell's)
 *
 * ── Why the empty field opens the list ───────────────────────────────────────
 * It used to render nothing until something was typed, which wasted the one
 * moment the console knows exactly what to offer: the five places this operator
 * came from, and a handful of things worth doing. An empty menu is a dead end;
 * this one is a shortcut.
 */
export default function AdminSearchBar() {
  const { t }    = useTranslation()
  const navigate = useNavigate()
  const mobile   = useIsMobile()
  const { can, isSuperuser } = usePrivileges()
  const userId = useAuthStore(s => s.user?.id ?? null)

  const [q, setQ]                 = useState('')
  const [open, setOpen]           = useState(false)
  const [debounced, setDebounced] = useState('')
  const [active, setActive]       = useState(0)
  const [stored, setStored]       = useState<RecentTarget[]>(() => readRecents(userId))

  const rootRef  = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const uid      = useId()
  const listId   = `${uid}-list`
  const optionId = useCallback((i: number) => `${uid}-opt-${i}`, [uid])

  // Only the SERVER search waits: a local list that lags 200 ms behind the
  // keystrokes reads as a broken field, not as a saved request.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 200)
    return () => clearTimeout(id)
  }, [q])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Re-read when the signed-in account changes (the trail is per account).
  useEffect(() => { setStored(readRecents(userId)) }, [userId])

  // A privilege can be revoked after a target was recorded — the stored trail is
  // re-checked against the live verdict, never trusted on its own.
  const recents = useMemo(() => stored.filter(r => {
    const tab = recentTab(r.url)
    return !tab || canSeeTab(tab, can)
  }), [stored, can])

  const caps = mobile ? MOBILE_CAPS : DESKTOP_CAPS
  const { results, suggestions, nearMisses, usersLoading } = useAdminSearchSources({
    query: q, debounced, enabled: open, can, isSuperuser, t, caps,
  })

  // What ↑/↓ walks: the results when something is typed, the landing list
  // otherwise. One array, so the keyboard and the paint cannot disagree.
  const navigable: AdminResult[] = useMemo(() => {
    if (q.trim()) return results
    const asResults: AdminResult[] = recents.map(r => ({
      key: `recent:${r.url}`, kind: r.kind, label: r.label, sublabel: r.sublabel, url: r.url, score: 0,
    }))
    return [...asResults, ...suggestions]
  }, [q, results, recents, suggestions])

  // The first row is always the pre-selected one — "type then Enter" must do
  // something sensible without ever pressing an arrow.
  useEffect(() => { setActive(0) }, [q, navigable.length])

  // Leaving the panel open over the console after a jump would hide the very
  // screen the operator asked for — so the shell's search mode is closed too.
  const leave = useCallback((url: string) => {
    setOpen(false)
    setQ('')
    useSearchStore.getState().requestSearchOpen(false)
    navigate(url)
  }, [navigate])

  const pick = useCallback((result: AdminResult) => {
    setStored(pushRecent(userId, result))
    leave(result.url)
  }, [leave, userId])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (open) {
        // Consume it: the shell closes its whole search mode on Escape, and the
        // first press should only dismiss the list.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      if (navigable.length === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setActive(i => (i + delta + navigable.length) % navigable.length)
      return
    }
    if (e.key === 'Home' && open && navigable.length) { e.preventDefault(); setActive(0); return }
    if (e.key === 'End'  && open && navigable.length) { e.preventDefault(); setActive(navigable.length - 1); return }
    if (e.key === 'Enter') {
      const target = navigable[active]
      if (target) { e.preventDefault(); pick(target) }
    }
  }

  return (
    <div ref={rootRef} className="relative w-full">
      {/* Field. Every colour comes from a theme token: the previous hard-coded
          #ffffff / #eaeef5 / #e0e0e0 painted a white bar on a dark theme (now via bg-search-bg). */}
      <div
        className={`flex h-12 items-center rounded-full border transition-colors
                    ${open ? 'border-border bg-surface-0' : 'border-transparent bg-search-bg'}`}
        style={{ boxShadow: open ? 'var(--kb-shadow-2)' : 'none' }}
      >
        <div className="shrink-0 pl-4 pr-2"><Search size={20} className="text-text-secondary" /></div>
        <input
          ref={inputRef}
          type="text"
          value={q}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={open && navigable[active] ? optionId(active) : undefined}
          aria-label={t('admin.search_ph')}
          placeholder={t('admin.search_ph')}
          autoComplete="off"
          spellCheck={false}
          onChange={e => { setQ(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-tertiary"
        />
        {q && (
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); setQ(''); inputRef.current?.focus() }}
            aria-label={t('shell.clear')}
            className="shrink-0 px-3 text-text-tertiary hover:text-text-primary"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {open && (
        <div
          className="absolute left-0 right-0 top-full z-[70] mt-2 max-h-[70vh] overflow-y-auto overscroll-contain
                     rounded-xl border border-border bg-surface-0"
          style={{ boxShadow: 'var(--kb-shadow-3)' }}
        >
          <AdminSearchPanel
            listId={listId}
            optionId={optionId}
            results={results}
            activeIndex={active}
            setActive={setActive}
            onPick={pick}
            onNavigate={leave}
            query={q}
            recents={recents}
            suggestions={suggestions}
            nearMisses={nearMisses}
            loading={usersLoading}
            mobile={mobile}
          />

          {/* Desktop footer: the two keys that make the list usable. Hidden on
              mobile, where there is no keyboard to teach. */}
          {!mobile && navigable.length > 0 && (
            <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-text-tertiary"
                 style={{ fontSize: 'var(--kb-text-meta)' }}>
              <span>{t('admin.search_kbd_move')}</span>
              <span>{t('admin.search_kbd_open')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
