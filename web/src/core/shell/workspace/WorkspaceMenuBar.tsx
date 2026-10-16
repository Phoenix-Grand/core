// Barre de menus STANDARD des applications avancées (Fichier / Édition / Affichage /
// Aide), pilotée par données et rendue via le MenuDropdown riche de @ui (action /
// séparateur / sous-menu / checked). Les menus par défaut sont fournis par
// `buildWorkspaceMenus` ; chaque éditeur câble les actions (et peut surcharger des
// libellés ou ajouter des menus). Reprend libellés/raccourcis de Documents.
import { useState, useEffect, useRef } from 'react'
import { MenuDropdown, type MenuItem as RichMenuItem, type MenuDropdownPos } from '@ui'

export type WsMenu = { label: string; items: RichMenuItem[] }

// Actions câblées par l'éditeur. Tout est optionnel : un item sans action est grisé.
export interface WorkspaceMenuActions {
  // Fichier
  onNew?: () => void;        newLabel?: string                 // surcharge « Nouveau » (ex. « Nouveau document »)
  onOpen?: () => void
  onDuplicate?: () => void
  downloadItems?: RichMenuItem[]                               // contenu du sous-menu « Télécharger »
  onRename?: () => void
  onDetails?: () => void;    detailsLabel?: string             // surcharge « Détails » (ex. « Détails du document »)
  // Édition
  onUndo?: () => void;       canUndo?: boolean
  onRedo?: () => void;       canRedo?: boolean
  onCut?: () => void
  onCopy?: () => void
  onPaste?: () => void
  onFindReplace?: () => void
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl+'
const SHIFT = isMac ? '⇧' : 'Shift+'

// Construit les menus par défaut. `onTrash` (corbeille) et `onFullscreen` sont
// fournis par le WorkspaceShell ; `extraMenus` s'insère avant « Aide ».
export function buildWorkspaceMenus(opts: {
  t: (k: string, o?: { defaultValue: string }) => string
  actions?: WorkspaceMenuActions
  onTrash?: () => void
  onFullscreen: () => void
  onAbout: () => void
  extraMenus?: WsMenu[]
}): WsMenu[] {
  const { t, onTrash, onFullscreen, onAbout, extraMenus } = opts
  const a = opts.actions ?? {}
  const noop = () => {}

  const file: RichMenuItem[] = [
    { type: 'action', label: a.newLabel ?? t('ws_new', { defaultValue: 'Nouveau' }), shortcut: `${MOD}N`, disabled: !a.onNew, onClick: a.onNew ?? noop },
    { type: 'action', label: t('ws_open', { defaultValue: 'Ouvrir' }), shortcut: `${MOD}O`, disabled: !a.onOpen, onClick: a.onOpen ?? noop },
    { type: 'action', label: t('ws_make_copy', { defaultValue: 'Créer une copie' }), disabled: !a.onDuplicate, onClick: a.onDuplicate ?? noop },
    { type: 'separator' },
    a.downloadItems
      ? { type: 'submenu', label: t('ws_download', { defaultValue: 'Télécharger' }), items: a.downloadItems }
      : { type: 'action', label: t('ws_download', { defaultValue: 'Télécharger' }), disabled: true, onClick: noop },
    { type: 'action', label: t('ws_rename', { defaultValue: 'Renommer' }), disabled: !a.onRename, onClick: a.onRename ?? noop },
    { type: 'action', label: t('ws_move_to_trash', { defaultValue: 'Mettre à la corbeille' }), disabled: !onTrash, onClick: onTrash ?? noop },
    { type: 'separator' },
    { type: 'action', label: a.detailsLabel ?? t('ws_details', { defaultValue: 'Détails' }), disabled: !a.onDetails, onClick: a.onDetails ?? noop },
  ]

  const edit: RichMenuItem[] = [
    { type: 'action', label: t('ws_undo', { defaultValue: 'Annuler' }), shortcut: `${MOD}Z`, disabled: !a.onUndo || a.canUndo === false, onClick: a.onUndo ?? noop },
    { type: 'action', label: t('ws_redo', { defaultValue: 'Rétablir' }), shortcut: `${MOD}${SHIFT}Z`, disabled: !a.onRedo || a.canRedo === false, onClick: a.onRedo ?? noop },
    { type: 'separator' },
    { type: 'action', label: t('ws_cut', { defaultValue: 'Couper' }), shortcut: `${MOD}X`, disabled: !a.onCut, onClick: a.onCut ?? noop },
    { type: 'action', label: t('ws_copy', { defaultValue: 'Copier' }), shortcut: `${MOD}C`, disabled: !a.onCopy, onClick: a.onCopy ?? noop },
    { type: 'action', label: t('ws_paste', { defaultValue: 'Coller' }), shortcut: `${MOD}V`, disabled: !a.onPaste, onClick: a.onPaste ?? noop },
    { type: 'separator' },
    { type: 'action', label: t('ws_find_replace', { defaultValue: 'Rechercher et remplacer' }), shortcut: `${MOD}H`, disabled: !a.onFindReplace, onClick: a.onFindReplace ?? noop },
  ]

  const view: RichMenuItem[] = [
    { type: 'action', label: t('ws_fullscreen', { defaultValue: 'Plein écran' }), shortcut: 'F11', onClick: onFullscreen },
  ]

  const help: RichMenuItem[] = [
    { type: 'action', label: t('ws_help_online', { defaultValue: 'Aide en ligne' }), onClick: () => window.open('https://github.com/kubuno/kubuno/wiki', '_blank') },
    { type: 'action', label: t('ws_forum', { defaultValue: 'Forum' }), onClick: () => window.open('https://github.com/kubuno/kubuno/discussions', '_blank') },
    { type: 'separator' },
    { type: 'action', label: t('ws_about', { defaultValue: 'À propos' }), onClick: onAbout },
  ]

  return [
    { label: t('ws_menu_file', { defaultValue: 'Fichier' }), items: file },
    { label: t('ws_menu_edit', { defaultValue: 'Édition' }), items: edit },
    { label: t('ws_menu_view', { defaultValue: 'Affichage' }), items: view },
    ...(extraMenus ?? []),
    { label: t('ws_menu_help', { defaultValue: 'Aide' }), items: help },
  ]
}

// La barre (rangée de boutons Fichier/Édition/… ouvrant chacun un MenuDropdown).
// Style clair Office (repris de Documents) ; variante sombre `dark` pour les éditeurs
// au thème sombre (ex. Script) - le bandeau suit le thème, les panneaux déroulants
// restent des overlays clairs portés (comme la recherche / HeaderActions).
export function WorkspaceMenuBar({ menus, dark = false }: { menus: WsMenu[]; dark?: boolean }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<MenuDropdownPos | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!openMenu) return
    const handler = (e: MouseEvent) => { if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openMenu])

  const close = () => setOpenMenu(null)
  const openAt = (label: string, btn: HTMLElement) => {
    const r = btn.getBoundingClientRect()
    setMenuPos({ top: r.bottom + 2, left: r.left, minWidth: 256 })
    setOpenMenu(label)
  }

  const hoverBg = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'
  const hoverBgSoft = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'

  return (
    <div
      ref={barRef}
      className="flex items-center flex-shrink-0 select-none"
      style={{ height: 28, paddingLeft: 4, background: dark ? '#1c1c1e' : '#ffffff', borderBottom: `1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'var(--color-border)'}` }}
    >
      {menus.map(menu => (
        <div key={menu.label}>
          <button
            onMouseDown={e => e.preventDefault()}
            onClick={e => { if (openMenu === menu.label) { setOpenMenu(null); return } openAt(menu.label, e.currentTarget) }}
            onMouseEnter={e => {
              if (openMenu && openMenu !== menu.label) openAt(menu.label, e.currentTarget)
              ;(e.currentTarget as HTMLElement).style.background = openMenu === menu.label ? hoverBg : hoverBgSoft
            }}
            onMouseLeave={e => { if (openMenu !== menu.label) (e.currentTarget as HTMLElement).style.background = '' }}
            style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, color: dark ? '#cccccc' : 'var(--kbn-ws-text, #202124)', background: openMenu === menu.label ? hoverBg : undefined, transition: 'background 0.1s' }}
          >
            {menu.label}
          </button>
          {openMenu === menu.label && menuPos && <MenuDropdown items={menu.items} pos={menuPos} onClose={close} />}
        </div>
      ))}
    </div>
  )
}

// Réexport pratique du type d'item riche pour les hôtes (downloadItems, extraMenus…).
export type { RichMenuItem }
