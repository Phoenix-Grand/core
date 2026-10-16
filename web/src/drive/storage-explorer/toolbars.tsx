/**
 * Above-the-list control bars: the desktop sort/type/view bar (themable
 * `drive.toolbar`) and its touch counterpart.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, List, LayoutGrid, Check } from 'lucide-react'
import { Dropdown, MobileSheet, MobileSheetItem, MobileSheetSeparator } from '@ui'
import { sortDirLabels } from './detailsModel'
import type { SortField, TFunc } from './types'

// ── MobileControlBar (barre de contrôle tactile) ──────────────────────────────
//
// Remplace la SortFilterBar sur mobile : la barre de bureau (dropdown de tri,
// filtre Type, menu « Afficher » à 8 modes) est trop dense pour un pouce. Ici :
// une puce de tri qui ouvre une feuille, et une bascule liste/grille - les deux
// seuls réglages qui comptent sur un petit écran.

export function MobileControlBar({ sortField, sortDir, onSortField, onSortDir, grid, onGrid, t }: {
  sortField:   SortField
  sortDir:     'asc' | 'desc'
  onSortField: (f: SortField) => void
  onSortDir:   (d: 'asc' | 'desc') => void
  grid:        boolean
  onGrid:      (v: boolean) => void
  t:           TFunc
}) {
  const [sheet, setSheet] = useState(false)
  // Same four criteria as the desktop SortFilterBar - and the same i18n keys.
  const fields: { value: SortField; label: string }[] = [
    { value: 'name', label: t('common.name') },
    { value: 'date', label: t('app.sort_date') },
    { value: 'size', label: t('common.size') },
    { value: 'type', label: t('filter.type') },
  ]
  const dirs = sortDirLabels(sortField, t)
  const current = fields.find(f => f.value === sortField)?.label ?? ''

  return (
    <div className="flex items-center justify-between gap-2 pb-3">
      {/* Puce de tri : libellé + flèche du sens (tap sur la flèche = inverser). */}
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          onClick={() => setSheet(true)}
          className="flex items-center gap-1.5 h-9 pl-1 pr-2 rounded-full text-[15px] text-text-primary
                     active:bg-surface-2 transition-colors min-w-0"
        >
          <span className="truncate">{current}</span>
        </button>
        <button
          onClick={() => onSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
          aria-label={sortDir === 'asc' ? dirs.asc : dirs.desc}
          className="w-8 h-8 shrink-0 rounded-full bg-primary-light text-primary flex items-center justify-center active:scale-95 transition-transform"
        >
          <ArrowUp size={17} className={`transition-transform ${sortDir === 'desc' ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Bascule liste/grille - segmentée, l'état actif est plein. */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={() => onGrid(false)}
          aria-label={t('view.list')}
          aria-pressed={!grid}
          className={`w-14 h-9 rounded-full flex items-center justify-center transition-colors
                      ${!grid ? 'bg-text-primary text-white' : 'bg-primary-light text-text-secondary'}`}
        >
          <List size={18} />
        </button>
        <button
          onClick={() => onGrid(true)}
          aria-label={t('view.icons_lg')}
          aria-pressed={grid}
          className={`w-14 h-9 rounded-full flex items-center justify-center transition-colors
                      ${grid ? 'bg-text-primary text-white' : 'bg-primary-light text-text-secondary'}`}
        >
          <LayoutGrid size={18} />
        </button>
      </div>

      <MobileSheet open={sheet} onClose={() => setSheet(false)} title={t('sort.by')}>
        {fields.map(f => (
          <MobileSheetItem
            key={f.value}
            label={f.label}
            selected={f.value === sortField}
            icon={f.value === sortField ? <Check size={17} className="text-primary" /> : <span />}
            onClick={() => { onSortField(f.value); setSheet(false) }}
          />
        ))}
        <MobileSheetSeparator />
        {(['asc', 'desc'] as const).map(d => (
          <MobileSheetItem
            key={d}
            label={dirs[d]}
            selected={d === sortDir}
            icon={d === sortDir ? <Check size={17} className="text-primary" /> : <span />}
            onClick={() => { onSortDir(d); setSheet(false) }}
          />
        ))}
      </MobileSheet>
    </div>
  )
}

// ── SortFilterBar (dropdown Type, identique à Mon Drive) ─────────────────────────

export function SortFilterBarBase({ sortField, sortDir, typeFilter, onSortField, onSortDir, onTypeFilter, hideType }: {
  sortField: SortField; sortDir: 'asc' | 'desc'; typeFilter: string | null
  onSortField: (v: SortField) => void; onSortDir: (v: 'asc' | 'desc') => void
  onTypeFilter: (v: string | null) => void; hideType?: boolean
}) {
  const { t } = useTranslation('drive')
  const SORT_OPTIONS = [
    { value: 'date', label: t('app.sort_date') }, { value: 'name', label: t('common.name') },
    { value: 'size', label: t('common.size') }, { value: 'type', label: t('filter.type') },
    // « Date de création » is only ever selected from the details-table header,
    // but it must have a label so the sort chip doesn't show the raw key.
    { value: 'created', label: t('details.col_created', { defaultValue: 'Date de création' }) },
  ]
  const TYPE_OPTIONS = [
    { value: '', label: t('app.ft_all') }, { value: 'image', label: t('app.ft_images') },
    { value: 'video', label: t('filter.t_video') }, { value: 'audio', label: t('filter.t_audio') },
    { value: 'document', label: t('filter.t_document') }, { value: 'archive', label: t('filter.t_archive') },
  ]
  return (
    <div className="flex flex-wrap items-center gap-2 pb-3 -mx-6 px-6 border-b border-border">
      <div className="flex items-center gap-1">
        <span className="text-sm select-none font-medium" style={{ color: 'var(--color-text-nav)' }}>{t('app.sort_label')}</span>
        <Dropdown variant="ghost" value={sortField} onChange={v => onSortField(v as typeof sortField)} options={SORT_OPTIONS} buttonStyle={{ color: 'var(--color-text-nav)' }} />
        <button onClick={() => onSortDir(sortDir === 'asc' ? 'desc' : 'asc')} style={{ color: 'var(--color-text-nav)' }} className="ml-0.5 text-sm hover:text-primary transition-colors select-none"
          title={sortDir === 'asc' ? t('app.sort_asc') : t('app.sort_desc')}>{sortDir === 'asc' ? '↑' : '↓'}</button>
      </div>
      {!hideType && <>
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-1">
          <span className="text-sm select-none font-medium" style={{ color: 'var(--color-text-nav)' }}>{t('app.type_label')}</span>
          <Dropdown variant="ghost" value={typeFilter ?? ''} onChange={v => onTypeFilter(v === '' ? null : v)} options={TYPE_OPTIONS} buttonStyle={{ color: 'var(--color-text-nav)' }} />
        </div>
      </>}
    </div>
  )
}
