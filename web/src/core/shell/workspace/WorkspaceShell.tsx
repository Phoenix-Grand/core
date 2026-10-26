// Core primitive: la chrome partagée de TOUTE application avancée (éditeurs Office
// et PaintSharp). Disposition verticale - topbar · barre de menus · options bar (toolbar)
// · (rail d'outils + corps) · bottom bar · status bar - entièrement data-driven via
// slots. L'hôte branche ses outils, panneaux, menus, options et statut ; le shell
// possède le cadre cohérent et thémé (clair Office / sombre PaintSharp).
//
// Généralisé depuis `paintsharp/ui/EditorShell` :
//  - thème complet clair+sombre (plus de '#111' codé en dur → `theme.topbarBg/statusBg`)
//  - prop `chromeless` : masque l'AppHeader global et héberge <HeaderActions/> dans
//    la topbar → récupère la rangée d'en-tête globale (gain vertical).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Trash2, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useUiStore } from '../../store/uiStore'
import { useDocumentTitleStore } from '../../store/documentTitleStore'
import { useConfirm } from '../../hooks/useConfirm'
import ConfirmDialog, { type ConfirmOptions } from '@ui/ConfirmDialog'
import { useIsMobile } from '../../../ui/interaction'
import HeaderActions from '../controls/HeaderActions'
import SearchBar from '../SearchBar'
import { MenuBar, type MenuItem } from './MenuBar'
import { WorkspaceMenuBar, buildWorkspaceMenus, type WorkspaceMenuActions, type WsMenu } from './WorkspaceMenuBar'
import { WORKSPACE_DARK, type WorkspaceTheme } from './theme'

export type { MenuItem, WorkspaceTheme }

// Champ d'édition du titre de fichier - STANDARDISÉ (repris de Documents) : input
// auto-dimensionné (un span invisible mesure le texte → pas de saut de layout),
// toujours éditable inline, commit sur blur ou Entrée. Tous les éditeurs partagent
// CE composant ; ils ne passent que la valeur + les callbacks.
function EditableTitle({ value, onChange, onCommit, placeholder, color, compact }: {
  value: string
  onChange: (v: string) => void
  onCommit?: () => void
  placeholder?: string
  color?: string   // couleur du texte (thème sombre PaintSharp) ; sinon token clair text-text-primary
  compact?: boolean // mobile : titre plus court pour laisser la place aux actions
}) {
  return (
    <span className="relative inline-flex items-center overflow-hidden" style={{ maxWidth: compact ? 220 : 260 }}>
      <span className="invisible whitespace-pre text-sm font-medium pr-2" aria-hidden="true">{value || placeholder || ''}</span>
      <input
        type="text" value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
        placeholder={placeholder}
        className="absolute inset-0 w-full text-sm font-medium text-text-primary bg-transparent outline-none"
        style={color ? { color } : undefined}
      />
    </span>
  )
}

export function WorkspaceShell({
  onBack, title, titleIcon, titleSlot, onTitleChange, onTitleCommit, titlePlaceholder, titleActions,
  onDelete, deleteConfirm, deleteTitle, subtitle, docInfo, topbarActions, search, showSearch,
  menuActions, extraMenus, menus, menuBar, optionsBar, toolRail, toolRailWidth = 44, bottomBar, statusBar,
  theme = WORKSPACE_DARK, chromeless = false, hideHeaderActions = false,
  topbarHeight = 40, optionsBarHeight = 30, statusHeight = 22, children,
}: {
  onBack?: () => void
  title?: ReactNode             // titre : ReactNode statique, OU valeur string si onTitleChange
  titleIcon?: ReactNode         // icône de type devant le titre (Office : fichier, grille…)
  titleSlot?: ReactNode         // override total de la zone titre (rare)
  onTitleChange?: (v: string) => void  // → champ titre éditable standard (EditableTitle)
  onTitleCommit?: () => void           // commit (blur/Entrée) - typiquement la sauvegarde
  titlePlaceholder?: string
  titleActions?: ReactNode      // actions juste après le titre, AVANT la recherche (ex. étoile)
  onDelete?: () => void         // → bouton corbeille STANDARD : confirme (ConfirmDialog) puis
                                //   appelle onDelete (qui supprime ET ferme l'espace de travail)
  deleteConfirm?: ConfirmOptions // texte de la confirmation (sinon défaut générique)
  deleteTitle?: string          // tooltip du bouton corbeille
  menuActions?: WorkspaceMenuActions  // → menus PAR DÉFAUT standard (Fichier/Édition/Affichage/Aide)
  extraMenus?: WsMenu[]         // menus additionnels insérés avant « Aide » (ex. Insertion/Format)
  subtitle?: ReactNode          // nom de l'éditeur ("Layer", "Apex"…), en accent
  docInfo?: ReactNode           // dimensions / nb de pages…
  topbarActions?: ReactNode     // boutons topbar à droite (undo/redo/export/save…)
  search?: ReactNode            // barre de recherche custom ; sinon SearchBar auto si chromeless
  showSearch?: boolean          // forcer/désactiver la SearchBar (défaut : = chromeless)
  menus?: { label: string; items: MenuItem[] }[]
  menuBar?: ReactNode           // barre de menus custom (ex. DocMenuBar) - alternative à `menus`
  optionsBar?: ReactNode        // rangée d'options contextuelles (la toolbar)
  toolRail?: ReactNode          // rail d'outils vertical à gauche
  toolRailWidth?: number        // largeur du rail (44 = 1 col ; ~72 = 2 col)
  bottomBar?: ReactNode         // rangée sous le corps (onglets de pages, timeline…)
  statusBar?: ReactNode         // rangée de statut en bas
  theme?: WorkspaceTheme
  chromeless?: boolean          // masque l'AppHeader global + héberge HeaderActions
  hideHeaderActions?: boolean   // masque le cluster HeaderActions (notifs/réglages/statut/avatar)
                                //   même en chromeless - pour une vue immersive (ex. lecture mobile)
  topbarHeight?: number         // hauteur topbar (40 PaintSharp ; ~52 Office titre+statut)
  optionsBarHeight?: number     // hauteur options bar/toolbar (30 PaintSharp ; 40 Office)
  statusHeight?: number         // hauteur status bar (22)
  children: ReactNode           // le corps (typiquement un <DockArea>)
}) {
  const { t: translate } = useTranslation()
  // Mode chromeless : masque l'en-tête global pendant que le shell est monté.
  const setHeaderHidden = useUiStore(s => s.setHeaderHidden)
  useEffect(() => {
    if (!chromeless) return
    setHeaderHidden(true)
    return () => setHeaderHidden(false)
  }, [chromeless, setHeaderHidden])

  // Alimente le titre de l'onglet avec le NOM DU FICHIER ouvert : uniquement
  // quand le titre est éditable (onTitleChange) et de type string → c'est le nom
  // du document. Effacé en quittant l'éditeur.
  const setDocFileName = useDocumentTitleStore(s => s.setFileName)
  useEffect(() => {
    const name = onTitleChange && typeof title === 'string' ? title : null
    setDocFileName(name)
    return () => setDocFileName(null)
  }, [title, onTitleChange, setDocFileName])

  const topbarBg = theme.topbarBg ?? '#111'
  const statusBg = theme.statusBg ?? '#111'
  // Mobile : topbar allégée (titre court, pas de recherche interne ni corbeille).
  const isMobileTb = useIsMobile()

  // SearchBar : custom > auto (par défaut affichée dès que `chromeless`, puisque le
  // shell remplace alors l'en-tête global qui la portait → on ne peut plus l'oublier).
  // En thème sombre (PaintSharp) on rend la variante sombre + compacte (topbar de 40px).
  const dark = theme.dark ?? true
  // Topbar COLORÉE (ex. ruban Office bleu) : `topbarText` force la couleur de
  // tous les éléments de la topbar (texte/icônes) et des hovers translucides,
  // indépendamment de `dark`. La SearchBar reste claire (pastille blanche).
  const tbFg = theme.topbarText
  const tbDark = dark || !!tbFg              // hovers blancs translucides + HeaderActions clairs
  const tbColor = tbFg ?? (dark ? theme.text : undefined)
  const tbDim   = tbFg ?? (dark ? theme.textDim : undefined)
  const searchEl = search ?? ((showSearch ?? chromeless) ? <SearchBar dark={dark} compact={dark} /> : null)

  // Recherche façon Google Agenda : loupe au repos → mode recherche qui recouvre la
  // topbar (retour + champ centré), tout le reste masqué. Identique à l'AppHeader
  // global. Desktop uniquement (le mobile n'a pas de recherche interne).
  const [searchOpen, setSearchOpen] = useState(false)
  const searchOverlayRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!searchOpen) return
    searchOverlayRef.current?.querySelector('input')?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSearchOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [searchOpen])

  // Bouton corbeille STANDARD : confirme via ConfirmDialog (jamais de dialog navigateur)
  // puis appelle onDelete (qui supprime ET ferme l'espace). Partagé par tous les éditeurs.
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const triggerDelete = async () => {
    if (!onDelete) return
    const ok = await confirm(deleteConfirm ?? { title: translate('workspace.delete_title'), message: translate('workspace.delete_warning'), confirmLabel: translate('common.delete'), variant: 'danger' })
    if (ok) onDelete()
  }
  const deleteButton = onDelete ? (
    <button
      onClick={triggerDelete}
      title={deleteTitle}
      className={tbDark ? 'p-1.5 rounded hover:bg-white/10 transition-colors flex-shrink-0' : 'p-1.5 rounded hover:bg-surface-2 text-text-secondary transition-colors flex-shrink-0'}
      style={tbColor ? { color: tbColor } : (dark ? { color: theme.textDim } : undefined)}
    >
      <Trash2 size={15} />
    </button>
  ) : null

  // Menus PAR DÉFAUT standard (Fichier/Édition/Affichage/Aide) dès que l'éditeur câble
  // `menuActions`. « Mettre à la corbeille » réutilise le flux de suppression ; Plein
  // écran / Aide / À propos sont gérés par le shell.
  const defaultMenus = menuActions ? buildWorkspaceMenus({
    t,
    actions: menuActions,
    onTrash: onDelete ? triggerDelete : undefined,
    onFullscreen: () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.() },
    onAbout: () => navigate('/about'),
    extraMenus,
  }) : null

  // Topbar - UNE SEULE structure (source unique). Mêmes éléments, mêmes dimensions et
  // mêmes interactions pour TOUS les éditeurs (Office clair / PaintSharp sombre) ; seules
  // les COULEURS changent selon `dark`. Calquée sur la barre de titre Documents :
  // retour · icône · (titre éditable + statut empilé) · sous-titre/dimensions · étoile
  // · corbeille · recherche · actions · HeaderActions. Modifier ICI change tout à
  // l'identique partout - y compris le thème sombre.
  const backBtn = onBack && (
    <button onClick={onBack}
      className={`p-1.5 rounded flex-shrink-0 transition-colors ${tbDark ? 'hover:bg-white/10' : 'hover:bg-surface-2 text-text-secondary'}`}
      style={tbColor ? { color:tbColor } : (dark ? { color:theme.textDim } : undefined)}>
      <ArrowLeft size={16} />
    </button>
  )

  // Mobile : topbar sur DEUX rangées façon Word mobile - rangée 1 = titre entier
  // centré (+ statut), rangée 2 = retour à gauche, actions à droite (défilables).
  // Recherche interne, corbeille, sous-titre et docInfo restent hors mobile.
  const topbar = isMobileTb ? (
    <div className="flex flex-col flex-shrink-0 no-print"
         style={{ background:topbarBg, borderBottom: tbFg ? 'none' : `1px solid ${theme.border}` }}>
      {(titleSlot || title || onTitleChange) && (
        <div className="flex items-center justify-center gap-2 px-3 pt-1.5 min-w-0">
          <span style={tbColor ? { color:tbColor } : undefined}>{titleIcon}</span>
          <span className="flex items-center gap-2 min-w-0 overflow-hidden">
            {titleSlot ?? (onTitleChange
              ? <EditableTitle value={typeof title === 'string' ? title : ''} onChange={onTitleChange} onCommit={onTitleCommit} placeholder={titlePlaceholder} color={tbColor} compact />
              : (title && <span className="text-xs font-medium text-text-primary truncate" style={tbColor ? { color:tbColor } : (dark ? { color:theme.text } : undefined)}>{title}</span>))}
          </span>
        </div>
      )}
      <div className="flex items-center px-2 gap-1.5 h-10">
        {backBtn}
        <div className="flex-1" />
        {titleActions}
        <div className="flex items-center gap-1 overflow-x-auto min-w-0 flex-shrink" style={{ scrollbarWidth: 'none' }}>{topbarActions}</div>
        {chromeless && !hideHeaderActions && <HeaderActions compact dark={tbDark} />}
      </div>
    </div>
  ) : (
    <div className="relative flex items-center px-2 gap-2 flex-shrink-0 no-print"
         style={{ height:topbarHeight, background:topbarBg, borderBottom: tbFg ? 'none' : `1px solid ${theme.border}` }}>
      {backBtn}
      <span style={tbColor ? { color:tbColor } : undefined}>{titleIcon}</span>
      {(titleSlot || title || onTitleChange) && (
        <div className="flex flex-col justify-center flex-shrink min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            {titleSlot ?? (onTitleChange
              ? <EditableTitle value={typeof title === 'string' ? title : ''} onChange={onTitleChange} onCommit={onTitleCommit} placeholder={titlePlaceholder} color={tbColor} />
              : (title && <span className="text-sm font-medium text-text-primary truncate max-w-xs" style={tbColor ? { color:tbColor } : (dark ? { color:theme.text } : undefined)}>{title}</span>))}
            {subtitle && <span className="text-xs flex-shrink-0" style={{ color:tbFg ?? theme.accent }}>{subtitle}</span>}
            {docInfo && <span className="text-xs flex-shrink-0 text-text-tertiary" style={tbDim ? { color:tbDim } : undefined}>{docInfo}</span>}
          </div>
        </div>
      )}
      {titleActions}
      {deleteButton}
      <div className="flex-1 min-w-0" />
      {/* Recherche : loupe au repos (façon Google Agenda). Le champ n'occupe plus la
          topbar en permanence ; le clic ouvre le mode recherche (overlay ci-dessous). */}
      {searchEl && (
        <button
          onClick={() => setSearchOpen(true)}
          title={t('common.search')}
          aria-label={t('common.search')}
          className={`p-1.5 rounded flex-shrink-0 transition-colors ${tbDark ? 'hover:bg-white/10' : 'hover:bg-surface-2 text-text-secondary'}`}
          style={tbColor ? { color:tbColor } : (dark ? { color:theme.textDim } : undefined)}
        >
          <Search size={16} />
        </button>
      )}
      {topbarActions}
      {chromeless && !hideHeaderActions && <HeaderActions compact dark={tbDark} />}

      {/* Mode recherche - recouvre TOUTE la topbar : retour + champ centré, le reste
          masqué (fond opaque = topbarBg). Escape ou la flèche ferment. */}
      {searchEl && searchOpen && (
        <div
          ref={searchOverlayRef}
          className="absolute inset-0 z-30 flex items-center gap-1 px-2"
          style={{ background: topbarBg }}
        >
          {/* Retour, puis le champ collé À GAUCHE juste après ; gaufrier + avatar à droite. */}
          <button
            onClick={() => setSearchOpen(false)}
            aria-label={t('common.back')}
            className={`p-1.5 rounded flex-shrink-0 transition-colors ${tbDark ? 'hover:bg-white/10' : 'hover:bg-surface-2 text-text-secondary'}`}
            style={tbColor ? { color:tbColor } : (dark ? { color:theme.textDim } : undefined)}
          >
            <ArrowLeft size={16} />
          </button>
          <div className="flex-1 min-w-0 max-w-2xl px-1">{searchEl}</div>
          {chromeless && !hideHeaderActions && (
            <div className="flex items-center flex-shrink-0 ml-auto">
              <HeaderActions compact dark={tbDark} minimal />
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="flex flex-col" style={{ height:'100%', background:theme.bg, color:theme.text, userSelect:'none' }}>
      {topbar}

      {/* Barre de menus : slot custom > menus standard (menuActions) > MenuBar PaintSharp (menus).
          `data-ws-search="open"` quand le mode recherche est actif → une règle CSS globale
          masque la bande d'onglets du ruban (`[data-ribbon-tabs]`) pour gagner de la hauteur. */}
      <div className="contents print:hidden no-print" data-ws-search={searchOpen ? 'open' : undefined}>
        {menuBar ?? (defaultMenus ? <WorkspaceMenuBar menus={defaultMenus} dark={dark} /> : (menus && <MenuBar C={theme} menus={menus} />))}
      </div>

      {/* Options bar (toolbar) */}
      {optionsBar && (
        <div className="flex items-center gap-2.5 px-3 flex-shrink-0 no-print"
             style={{ height:optionsBarHeight, background:theme.header, borderBottom:`1px solid ${theme.border}`, fontSize:11 }}>
          {optionsBar}
        </div>
      )}

      {/* Corps : rail d'outils + contenu */}
      <div className="flex flex-1 min-h-0">
        {toolRail && (
          <div className="flex flex-col items-center py-2 gap-0.5 flex-shrink-0 no-print"
               style={{ width:toolRailWidth, background:theme.toolbar, borderRight:`1px solid ${theme.border}`, order:0 }}>
            {toolRail}
          </div>
        )}
        {children}
      </div>

      {/* Bottom bar (onglets de pages, timeline…) */}
      {bottomBar && <div className="no-print">{bottomBar}</div>}

      {/* Status bar */}
      {statusBar && (
        <div className="flex items-center gap-4 px-4 flex-shrink-0 no-print"
             style={{ height:statusHeight, background:statusBg, borderTop:`1px solid ${theme.border}`, fontSize:10, color:theme.textDim }}>
          {statusBar}
        </div>
      )}

      {/* Dialogue de confirmation (bouton corbeille standard) */}
      {confirmState && <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />}
    </div>
  )
}
