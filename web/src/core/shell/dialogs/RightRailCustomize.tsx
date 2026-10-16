import { useState } from 'react'
import { ArrowDown, ArrowUp, SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, FloatingWindow, Toggle } from '@ui'
import { applyPrefs, type RightRailPrefs } from '../../hooks/useRightRailPrefs'
import type { RailEntry } from '../../store/rightPanelStore'

/**
 * Customisation of the right rail: which panels appear, and in which order.
 *
 * Edits are held in a DRAFT and written once on confirm, like the waffle launcher.
 * Saving on every click would fire a `PATCH /me` per keystroke-sized change, and two
 * responses landing out of order would put a stale `preferences` back into the store -
 * the race that already bit the module preferences.
 *
 * Order is changed with ↑/↓ rather than drag-and-drop: with a handful of rows it is
 * just as quick, works with a keyboard, and has no hidden failure mode.
 */
export default function RightRailCustomize({
  entries, prefs, onSave, onClose,
}: {
  entries: RailEntry[]
  prefs:   RightRailPrefs
  onSave:  (next: RightRailPrefs) => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  // Start from the order the user actually sees, then append whatever is hidden -
  // a hidden row still needs a position, or showing it again would send it to the end.
  const [rows, setRows] = useState<string[]>(() => {
    const visible = applyPrefs(entries, prefs).map(e => e.moduleId)
    const rest = entries.map(e => e.moduleId).filter(id => !visible.includes(id))
    return [...visible, ...rest]
  })
  const [hidden, setHidden] = useState<string[]>(() => prefs.hidden.filter(id => entries.some(e => e.moduleId === id)))

  const byId = new Map(entries.map(e => [e.moduleId, e]))

  const move = (index: number, delta: number) => {
    setRows(prev => {
      const next = [...prev]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const toggle = (id: string) =>
    setHidden(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))

  return (
    <FloatingWindow
      title={t('shell.rail_customize', { defaultValue: 'Personnaliser le panneau' })}
      icon={<SlidersHorizontal size={16} />}
      onClose={onClose}
      backdrop
      defaultWidth={420}
      // Tall enough for the whole list without scrolling: 8 modules register a
      // panel today, and a cramped list is what makes reordering feel fiddly.
      defaultHeight={560}
      padding={16}
    >
      <p className="mb-3 text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
        {t('shell.rail_customize_help', {
          defaultValue: 'Choisissez les panneaux affichés dans le rail de droite et leur ordre.',
        })}
      </p>

      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {rows.map((id, i) => {
          const entry = byId.get(id)
          if (!entry) return null
          const Icon = entry.icon
          const isHidden = hidden.includes(id)
          return (
            <li key={id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-surface-1">
              <Icon size={18} className={isHidden ? 'text-text-tertiary' : 'text-text-secondary'} />
              <span className={`flex-1 truncate text-sm ${isHidden ? 'text-text-tertiary' : 'text-text-primary'}`}>
                {entry.label}
              </span>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={t('shell.rail_move_up', { defaultValue: 'Monter' })}
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors
                           hover:bg-surface-2 hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <ArrowUp size={15} />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === rows.length - 1}
                aria-label={t('shell.rail_move_down', { defaultValue: 'Descendre' })}
                className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors
                           hover:bg-surface-2 hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent
                           focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <ArrowDown size={15} />
              </button>
              <Toggle checked={!isHidden} onChange={() => toggle(id)} aria-label={entry.label} />
            </li>
          )
        })}
      </ul>

      <div className="mt-3 flex flex-shrink-0 justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel', { defaultValue: 'Annuler' })}
        </Button>
        <Button onClick={() => { onSave({ order: rows, hidden }); onClose() }}>
          {t('common.save', { defaultValue: 'Enregistrer' })}
        </Button>
      </div>
    </FloatingWindow>
  )
}
