import { type ReactNode } from 'react'
import { Check, LayoutGrid, Grid3x3, List, AlignJustify, Eye, EyeOff } from 'lucide-react'

// Sélecteur de vue : quatre modes dans un interrupteur segmenté (le mode actif
// porte une coche, comme le bascule de Google Drive), plus les deux options
// d'affichage dans un menu discret. Partagé par FilesApp et ModuleFileBrowser.

export type ViewMode = 'lg' | 'sm' | 'list' | 'details'

export interface ViewSpec {
  kind:      'icons' | 'rows'
  min?:      number   // largeur min des cellules (grille)
  thumbH?:   number   // hauteur de la vignette (icônes)
  iconScale?: number  // échelle de l'icône de fichier
  dense?:    boolean  // texte compact
  multicol?: boolean  // liste en colonnes (mode « Liste »)
  density?:  'compact' | 'normal'
}

export const VIEW_SPECS: Record<ViewMode, ViewSpec> = {
  lg:      { kind: 'icons', min: 190, thumbH: 150, iconScale: 1.45 },
  sm:      { kind: 'icons', min: 112, thumbH: 76,  iconScale: 0.8, dense: true },
  list:    { kind: 'rows',  multicol: true, density: 'compact' },
  details: { kind: 'rows',  density: 'normal' },
}

interface ModeDef { value: ViewMode; labelKey: string; fallback: string; icon: ReactNode }
const MODES: ModeDef[] = [
  { value: 'lg',      labelKey: 'view.icons_lg', fallback: 'Grandes icônes', icon: <LayoutGrid size={16} /> },
  { value: 'sm',      labelKey: 'view.icons_sm', fallback: 'Petites icônes', icon: <Grid3x3 size={16} /> },
  { value: 'list',    labelKey: 'view.list',     fallback: 'Liste',          icon: <List size={16} /> },
  { value: 'details', labelKey: 'view.details',  fallback: 'Détails',        icon: <AlignJustify size={16} /> },
]

interface ViewMenuProps {
  value:        ViewMode
  onChange:     (v: ViewMode) => void
  showHidden:   boolean
  onShowHidden: (v: boolean) => void
  /** Traducteur (namespace 'files') - `t(key, { defaultValue })`. */
  t:            (key: string, opts?: Record<string, unknown>) => string
}

export function ViewMenu({ value, onChange, showHidden, onShowHidden, t }: ViewMenuProps) {
  return (
    <div className="flex items-center gap-1.5">
      {/* Segmented switch: the four modes are visible at once, so changing view
          is one click instead of open-menu-then-pick. The active segment carries
          a tick - the icon alone reads as "available", not as "current". */}
      <div role="group" className="inline-flex items-center rounded-md border border-border overflow-hidden">
        {MODES.map((m, i) => {
          const active = value === m.value
          const label  = t(m.labelKey, { defaultValue: m.fallback })
          return (
            <button
              key={m.value}
              onClick={() => onChange(m.value)}
              title={label}
              aria-label={label}
              aria-pressed={active}
              className={`flex items-center gap-1 h-8 px-2.5 text-sm transition-colors ${
                i > 0 ? 'border-l border-border' : ''
              } ${active
                ? 'bg-primary-light text-primary'
                : 'text-text-secondary hover:bg-surface-1'}`}
            >
              {active && <Check size={14} />}
              {m.icon}
            </button>
          )
        })}
      </div>

      {/* One option, so it is the control itself rather than a menu holding a
          single line - and it leaves the row free for what comes next. */}
      <button
        onClick={() => onShowHidden(!showHidden)}
        title={t('view.hidden', { defaultValue: 'Éléments masqués' })}
        aria-label={t('view.hidden', { defaultValue: 'Éléments masqués' })}
        aria-pressed={showHidden}
        className={`flex items-center justify-center h-8 w-8 rounded-md border border-border transition-colors ${
          showHidden ? 'bg-primary-light text-primary' : 'text-text-secondary hover:bg-surface-1'
        }`}
      >
        {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
    </div>
  )
}
