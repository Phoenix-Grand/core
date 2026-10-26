import { useState, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { Clock } from 'lucide-react'
import { Tabs, type TabDef } from './Tabs'
import { ResizeHandle, useResizableWidth } from './ResizeHandle'

// Largeur de la colonne « Récents » : redimensionnable, bornée, mémorisée.
const RECENT_W_KEY = 'kubuno.startpage.recentW'
const RECENT_W_MIN = 180
const RECENT_W_MAX = 520
const RECENT_W_DEFAULT = 256

// Page de démarrage générique d'un outil (« StartPage ») : point d'entrée où l'on
// REPREND un élément récent (colonne de gauche), on PARCOURT pour en ouvrir un, ou
// on en CRÉE un nouveau (vierge / modèle, via le contenu d'un onglet).
//
// Composant visuel pur : toutes les données et actions arrivent par props, aucune
// logique métier ni i18n. Destiné à être réutilisé par les modules/sous-modules
// (Documents, Tableur, Présentations, etc.).

export interface StartPageRecentAction {
  id:      string
  label:   string
  icon?:   ReactNode
  danger?: boolean
  onClick: () => void
}

export interface StartPageRecentItem {
  id:        string
  name:      string
  subtitle?: string            // ex. date formatée
  icon?:     ReactNode
  onClick:   () => void
  /** Actions du menu contextuel (clic droit). Le consommateur les fournit. */
  actions?:  StartPageRecentAction[]
  /** Élément en cours de suppression : box colorée + non interactive. */
  pendingTone?: 'trash' | 'permanent'
}

export interface StartPageTab {
  id:      string
  label:   string
  content: ReactNode
}

export interface StartPageProps {
  /** Titre de la colonne des récents (défaut : « Récents »). */
  recentTitle?: string
  /** Icône d'en-tête de la colonne (défaut : horloge). */
  recentIcon?:  ReactNode
  recentItems:  StartPageRecentItem[]
  /** Contenu affiché quand il n'y a aucun récent. */
  recentEmpty?: ReactNode
  tabs:         StartPageTab[]
  /** Onglet actif par défaut (non contrôlé). */
  defaultTab?:  string
  /** Onglet actif (mode contrôlé). */
  activeTab?:   string
  onTabChange?: (id: string) => void
}

export function StartPage({
  recentTitle = "Recent", recentIcon, recentItems, recentEmpty,
  tabs, defaultTab, activeTab, onTabChange,
}: StartPageProps) {
  const [internal, setInternal] = useState(defaultTab ?? tabs[0]?.id ?? '')
  const active    = activeTab ?? internal

  // ── Colonne « Récents » redimensionnable (largeur mémorisée) ─────────────────
  const [recentW, setRecentW] = useResizableWidth(RECENT_W_KEY, RECENT_W_DEFAULT, RECENT_W_MIN, RECENT_W_MAX)
  const setActive = (id: string) => { onTabChange?.(id); if (activeTab === undefined) setInternal(id) }
  const tabDefs: TabDef[] = tabs.map(t => ({ id: t.id, label: t.label }))
  const current = tabs.find(t => t.id === active) ?? tabs[0]

  // Menu contextuel (clic droit) d'un élément récent.
  const [menu, setMenu] = useState<{ x: number; y: number; actions: StartPageRecentAction[] } | null>(null)
  const openMenu = (e: ReactMouseEvent, it: StartPageRecentItem) => {
    if (!it.actions || it.actions.length === 0) return
    e.preventDefault()
    // Cadrage simple pour éviter le débordement bas/droite.
    const x = Math.min(e.clientX, window.innerWidth  - 200)
    const y = Math.min(e.clientY, window.innerHeight - (it.actions.length * 36 + 16))
    setMenu({ x, y, actions: it.actions })
  }

  return (
    <div className="relative flex h-full overflow-hidden bg-white">
      {/* Colonne des récents (gauche), largeur redimensionnable.
          Masquée sur mobile : sa largeur fixe écraserait le contenu principal
          (boutons « Nouveau… » poussés hors écran). */}
      <aside
        className="hidden lg:flex flex-shrink-0 bg-surface-1 flex-col overflow-hidden"
        style={{ width: recentW }}
      >
        <div className="px-4 h-[57px] flex items-center gap-2 border-b border-border flex-shrink-0">
          <span className="text-text-tertiary flex-shrink-0">{recentIcon ?? <Clock size={15} />}</span>
          <span className="text-sm font-medium text-text-primary">{recentTitle}</span>
        </div>

        {recentItems.length === 0 ? (
          <div className="flex-1 flex items-center justify-center px-4 text-center">
            {recentEmpty ?? <p className="text-text-tertiary text-xs">-</p>}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto py-1">
            {recentItems.map(it => (
              <button
                key={it.id}
                onClick={it.onClick}
                onContextMenu={e => openMenu(e, it)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  it.pendingTone ? 'pointer-events-none' : 'hover:bg-surface-2'
                }`}
                style={it.pendingTone
                  ? { backgroundColor: it.pendingTone === 'permanent' ? '#fee2e2' : '#f3e8ff' }
                  : undefined}
              >
                {it.icon && <span className="flex-shrink-0">{it.icon}</span>}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-text-primary truncate" title={it.name}>{it.name}</span>
                  {it.subtitle && <span className="block text-[11px] text-text-tertiary">{it.subtitle}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* Séparateur redimensionnable (poignée partagée @ui) - desktop only */}
      <div className="hidden lg:block">
        <ResizeHandle
          position={recentW}
          onResize={setRecentW}
          min={RECENT_W_MIN}
          max={RECENT_W_MAX}
          onReset={() => setRecentW(RECENT_W_DEFAULT)}
          title={recentTitle}
        />
      </div>

      {/* Onglets (parcourir / modèles / …) + contenu */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="px-6 h-[57px] flex items-center flex-shrink-0 border-b border-border">
          <Tabs tabs={tabDefs} value={active} onChange={setActive} />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {current?.content}
        </div>
      </div>

      {/* Menu contextuel d'un récent */}
      {menu && (
        <>
          <div className="fixed inset-0 z-[9998]"
               onClick={() => setMenu(null)}
               onContextMenu={e => { e.preventDefault(); setMenu(null) }} />
          <div className="fixed z-[9999] min-w-[190px] bg-white border border-border rounded-lg shadow-lg py-1"
               style={{ top: menu.y, left: menu.x }}>
            {menu.actions.map(a => (
              <button
                key={a.id}
                onClick={() => { setMenu(null); a.onClick() }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors
                  ${a.danger ? 'text-danger hover:bg-danger/10' : 'text-text-primary hover:bg-surface-1'}`}
              >
                {a.icon && <span className="flex-shrink-0">{a.icon}</span>}
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
