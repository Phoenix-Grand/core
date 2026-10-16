/**
 * The parts of `AppSidebar.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { NavLink } from "react-router-dom"
import { MenuDropdown } from "@ui"
import { useTranslation } from "react-i18next"
import { Home, Star, Trash2, Clock, GripVertical, Cloud, Image, Calendar, MessageSquare, FileText, CheckSquare, BookOpen, Music, Video, Code, FolderOpen, Share2, BarChart3, Bot, Box, Clapperboard, ClipboardList, Code2, Contact, FileEdit, Film, FolderKanban, KeyRound, LayoutTemplate, Mail, Map, Network, Palette, PenTool, StickyNote, TableProperties, Tv, Zap, type LucideIcon } from "lucide-react"
import { useUiStore } from "../../store/uiStore"
import { Slot } from "../../slots/SlotRegistry"
import type { SidebarItem } from "../../types"
import BrandLink from "../controls/BrandLink"
import type { AppSidebar } from './AppSidebar'
const ICON_MAP: Record<string, LucideIcon> = {
  Home, Star, Trash2, Clock, Cloud, Image, Calendar,
  MessageSquare, FileText, CheckSquare, BookOpen,
  Music, Video, Code, FolderOpen, Share2,
  // Modules
  BarChart3, Bot, Box, Clapperboard, ClipboardList, Code2, Contact, FileEdit,
  Film, FolderKanban, KeyRound, LayoutTemplate, Mail, Map, Network, Palette,
  PenTool, StickyNote, TableProperties, Tv, Zap,
}

function SidebarIcon({ name }: { name: string }) {
  const Icon = ICON_MAP[name] ?? Cloud
  return <Icon size={20} />
}
export { SidebarIcon }

function SidebarLink({ item, collapsed }: { item: SidebarItem; collapsed: boolean }) {
  const { closeSidebar } = useUiStore()
  const { t } = useTranslation('nav')
  const label = t(item.id, { defaultValue: item.label })
  return (
    // Collapse ANIMATES rather than snapping: constant padding + a fixed-width icon
    // box (so the icon lands centred in the 64px rail without a justify switch that
    // would make it jump), and the label collapses its width/opacity/margin. The
    // link width follows its content, so it glides in step with the aside width.
    <NavLink
      to={item.path}
      end={item.path === '/'}
      onClick={closeSidebar}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `group flex items-center px-2 py-2 rounded-full text-sm font-medium relative
         overflow-hidden transition-all duration-200 ease-in-out cursor-pointer select-none
         ${isActive ? 'bg-primary-light' : 'hover:bg-[var(--kb-sidebar-hover,#e8eaed)]'}`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className="w-8 flex items-center justify-center flex-shrink-0 transition-colors"
            style={{ color: isActive ? '#1a73e8' : '#5f6368' }}
          >
            <SidebarIcon name={item.icon} />
          </span>
          <span
            className="truncate transition-all duration-200 ease-in-out"
            style={{
              color: isActive ? 'var(--color-text-nav-active)' : 'var(--color-text-nav)',
              maxWidth: collapsed ? 0 : 180,
              opacity: collapsed ? 0 : 1,
              marginLeft: collapsed ? 0 : 8,
              flex: collapsed ? '0 1 0%' : '1 1 auto',
            }}
          >
            {label}
          </span>
          {item.badge != null && item.badge > 0 && (
            collapsed ? (
              <span
                className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full"
                style={{ background: '#d93025' }}
              />
            ) : (
              <span
                className="text-xs text-white rounded-full min-w-[18px] h-[18px] flex-shrink-0
                           flex items-center justify-center px-1 font-medium"
                style={{ background: '#d93025' }}
              >
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )
          )}
        </>
      )}
    </NavLink>
  )
}
export { SidebarLink }

function PlusIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" focusable="false" fill="currentColor" aria-hidden>
      <path d="M20 13h-7v7h-2v-7H4v-2h7V4h2v7h7v2z" />
    </svg>
  )
}
export { PlusIcon }

export function Part1({ activeConfig, dragging, sidebarOpen, collapsed, widthStyle, headerHidden, showNewButton, newMenu, newButtonLabel, newProviders, newMenu_pos, ActiveConfig_SidebarBody, mainItems, secondaryItems }: { activeConfig: NonNullable<AppSidebar['activeConfig']>; dragging: NonNullable<AppSidebar['dragging']>; sidebarOpen: NonNullable<AppSidebar['sidebarOpen']>; collapsed: NonNullable<AppSidebar['collapsed']>; widthStyle: AppSidebar['widthStyle']; headerHidden: NonNullable<AppSidebar['headerHidden']>; showNewButton: NonNullable<AppSidebar['showNewButton']>; newMenu: NonNullable<AppSidebar['newMenu']>; newButtonLabel: NonNullable<AppSidebar['newButtonLabel']>; newProviders: NonNullable<AppSidebar['newProviders']>; newMenu_pos: NonNullable<NonNullable<AppSidebar['newMenu']>['pos']>; ActiveConfig_SidebarBody: NonNullable<NonNullable<AppSidebar['activeConfig']>['SidebarBody']>; mainItems: NonNullable<AppSidebar['mainItems']>; secondaryItems: NonNullable<AppSidebar['secondaryItems']> }) {
  return (
    <aside
          data-module={activeConfig?.moduleId}
          data-app-sidebar
          data-app-chrome
          className={`
        fixed left-0 bottom-0 flex flex-col overflow-x-hidden overflow-y-hidden
        z-50 ${dragging ? '' : 'transition-all duration-200 ease-in-out'}
        lg:relative lg:translate-x-0 lg:z-auto lg:rounded-xl
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        ${collapsed ? 'w-16' : 'w-64'}
        top-16 lg:top-auto
      `}
          style={{ background: 'var(--body-bg)', ...widthStyle }}
        >
          {/* ── Logo Kubuno - affiché ici quand l'AppHeader global est masqué (sous-module
                 à barre de titre), pour qu'il reste en place en haut à gauche. ── */}
          {headerHidden && (
            // A direct child of the column, so it stretches to the rail's width and
            // centres its logo when collapsed.
            <BrandLink collapsed={collapsed} iconSize={40} className="mt-4 mb-8 flex-shrink-0 h-10" />
          )}
    
          {/* ── Bouton Nouveau / Créer ─────────────────────────────────────── */}
          {/* UN SEUL élément qui MORPHE entre la pilule (déplié) et le disque de 48px
              (replié), au lieu de deux blocs conditionnels qui claquaient. Astuce
              d'animation : hauteur/rayon constants (stade → cercle à 48px de large),
              largeur = celle du CONTENU → le bouton rétrécit tout seul en douceur quand
              le libellé replie sa largeur/opacité/marge et que le padding tombe à 0.
              `px-2` constant → à 48px de large, le disque est centré dans le rail de 64. */}
          {showNewButton && (
            <div className="flex items-center px-2" style={{ height: 72 }}>
              <>
                {/* A real <button>, like Google's own markup (user request) - the
                    one exception to the panel's anchors-only habit. */}
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={newMenu.isOpen}
                    onClick={e => {
                      if (newMenu.isOpen) { newMenu.close(); return }
                      // Anchor the menu under the key (or to its right when collapsed).
                      const r = e.currentTarget.getBoundingClientRect()
                      newMenu.openAt(collapsed ? r.right + 8 : r.left, collapsed ? r.top : r.bottom + 4)
                    }}
                    aria-label={newButtonLabel}
                    className="kb-neo-btn inline-flex items-center
                               cursor-pointer overflow-hidden
                               transition-all duration-200 ease-in-out"
                    style={{
                      // Google FAB geometry: 3.5rem tall expanded (Drive's value),
                      // 48px disc collapsed. Surface/shadows come from `.kb-neo-btn`.
                      height: collapsed ? 48 : 56,
                      minWidth: 48,
                      // NO left padding: the icon lives in a fixed 48px box (= the
                      // collapsed disc width), so the « + » centre stays at the same x
                      // in both states - immobile during the collapse tween and
                      // aligned with the menu icons below.
                      paddingRight: collapsed ? 0 : 20,
                      fontSize: '0.875rem',
                      userSelect: 'none',
                    }}
                  >
                    <span className="flex items-center justify-center flex-shrink-0" style={{ width: 48, height: '100%' }}>
                      <PlusIcon />
                    </span>
                    <span
                      className="whitespace-nowrap transition-all duration-200 ease-in-out"
                      style={{
                        maxWidth: collapsed ? 0 : 150,
                        opacity: collapsed ? 0 : 1,
                        // On the SPAN, not the button: the project-wide
                        // `button { font-weight: 400 !important }` rule would zero a
                        // weight set on the button element itself.
                        fontWeight: 500,
                      }}
                    >
                      {newButtonLabel}
                    </span>
                  </button>
    
                {/* THE project's menu component (@ui MenuDropdown) - same surface,
                    same item chrome and same dismiss behaviour as every other menu in
                    the app. Items are built on open, so labels and state are fresh. */}
                {newMenu.pos && (
                  <MenuDropdown
                    items={newProviders.flatMap(p => p.items())}
                    pos={{ ...newMenu_pos, minWidth: 208 }}
                    onClose={newMenu.close}
                  />
                )}
              </>
            </div>
          )}
    
          {/* ── Corps de la sidebar ────────────────────────────────────────── */}
          {/* Le SidebarBody du module est rendu dans LES DEUX états (replié/déplié) en
              lui passant `collapsed`, pour que la nav reste identique - au lieu de
              retomber sur la liste générique quand replié. */}
          {activeConfig?.SidebarBody && (!collapsed || activeConfig.collapsedBody) ? (
            <ActiveConfig_SidebarBody collapsed={collapsed} />
          ) : (
            <>
              <nav className="flex-1 space-y-0.5 px-2">
                {mainItems.map((item) => (
                  <SidebarLink key={item.id} item={item} collapsed={collapsed} />
                ))}
              </nav>
    
              {secondaryItems.length > 0 && (
                <>
                  <div className="mx-3 my-2 h-px bg-border" />
                  <nav className="space-y-0.5 px-2">
                    {secondaryItems.map((item) => (
                      <SidebarLink key={item.id} item={item} collapsed={collapsed} />
                    ))}
                  </nav>
                </>
              )}
    
              {!collapsed && (
                <div className="mt-1">
                  <Slot name="sidebar-footer" />
                  <Slot name="sidebar-storage" />
                </div>
              )}
            </>
          )}
    
          {/* Lien Administration déplacé dans le menu du compte (UserPanel). */}
    
          {/* Le repli desktop est désormais piloté par le hamburger de l'en-tête
              (AppHeader), placé avant le logo façon Gmail. */}
        </aside>
  )
}

export function Part2({ tc, onResizeDown, onResizeMove, endResize, dragging }: { tc: NonNullable<AppSidebar['tc']>; onResizeDown: NonNullable<AppSidebar['onResizeDown']>; onResizeMove: NonNullable<AppSidebar['onResizeMove']>; endResize: NonNullable<AppSidebar['endResize']>; dragging: NonNullable<AppSidebar['dragging']> }) {
  return (
    <div
            role="separator"
            aria-orientation="vertical"
            aria-label={tc('shell.resize_sidebar', { defaultValue: 'Redimensionner le panneau' })}
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            /* Safety net: a capture lost for any other reason (window blur, the node being
               re-parented) would otherwise leave the sidebar stuck in the dragging state -
               blue line, and no collapse animation any more. */
            onLostPointerCapture={endResize}
            className="hidden lg:block absolute top-0 left-full h-full w-3 z-[60] cursor-col-resize group"
          >
            {/* Trait vertical - discret au repos, teinté au survol/glissement. */}
            <div className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-[5px] rounded-full transition-colors
                        ${dragging ? 'bg-primary' : 'bg-transparent group-hover:bg-border'}`} />
            {/* Pastille à grip (façon office) - invisible au repos, apparaît à l'approche. */}
            <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center
                        h-9 w-3.5 rounded-full bg-surface-0 border shadow-sm transition
                        ${dragging
                          ? 'opacity-100 bg-primary-light text-primary border-primary/40'
                          : 'opacity-0 group-hover:opacity-100 text-text-tertiary border-border'}`}>
              <GripVertical size={13} />
            </div>
          </div>
  )
}
