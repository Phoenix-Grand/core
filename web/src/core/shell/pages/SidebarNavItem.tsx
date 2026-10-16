import { Link, useResolvedPath, useMatch } from 'react-router-dom'
import type { ReactNode } from 'react'
import { themed, Tooltip } from '@ui'

// Sidebar navigation item shared by every module.
// Handles both the COLLAPSED state (icon only + tooltip) and the EXPANDED one
// (icon + label), so a module's nav stays identical in both. Always rendered as
// an <a> tag carrying a real href - `to` → <Link> (href = the route),
// `onClick` → anchor-button with href '#'. Never a <button>.
function SidebarNavItemBase({
  label, icon, active, collapsed = false, onClick, to, end, badge, href = '#',
}: {
  label: string
  icon: ReactNode
  active?: boolean
  collapsed?: boolean
  onClick?: () => void
  to?: string
  end?: boolean
  badge?: number
  /** href of the action variant (no `to`). Defaults to '#' so it is a real link. */
  href?: string
}) {
  // On calcule l'état actif NOUS-MÊMES (au lieu de la render-prop `className` de
  // NavLink). Raison : en mode replié, le nœud est enveloppé dans
  // <Tooltip.Trigger asChild> (Radix Slot), qui fusionne `className` en supposant
  // une CHAÎNE - il sérialise donc une `className` fonction (« ({isActive})=>… »)
  // au lieu de l'appeler, et plus aucune classe Tailwind ne s'applique (icônes
  // écrasées à 16px). On passe donc toujours une `className` chaîne à un <Link>.
  const resolved = useResolvedPath(to ?? '.')
  const match    = useMatch({ path: resolved.pathname, end: end ?? false })
  const isActive = to != null ? (active ?? match != null) : !!active

  // Hauteur de ligne FIXE et IDENTIQUE dans les deux modes (h-10 = 40px) pour que
  // la position de la 1ʳᵉ icône et l'espacement entre icônes soient les mêmes,
  // replié ou déplié.
  // `text-left` : les variantes <button> héritent du `text-align: center` par défaut
  // du navigateur, qui se propageait au libellé → texte centré. On le force à gauche.
  // `cursor-pointer` + `focus-visible` ring: an anchor without href gets neither
  // for free, and the item must feel clickable on hover and reachable at the
  // keyboard exactly like a link.
  // Layout is CONSTANT (full width + px-2 + a fixed 32px icon box), so collapsing
  // ANIMATES instead of snapping: the item width follows the aside (which tweens its
  // own width), and only the label tweens (max-width/opacity/margin, see `content`).
  // No `justify-center`/`w-10` switch - that would jerk the icon to the middle of the
  // still-wide row at the start of the tween.
  const base = `relative flex items-center h-10 w-full px-2 rounded-full text-sm text-left
    transition-colors cursor-pointer no-underline outline-none overflow-hidden
    focus-visible:ring-2 focus-visible:ring-primary`
  const cls = (a: boolean) =>
    `${base} ${a ? 'text-primary font-medium' : 'text-text-secondary'}`

  // Hover/active background is applied as an INLINE style, not through a
  // `hover:bg-*` utility. Module bundles ship their own Tailwind build into the
  // `kubuno-module` cascade layer, which races the host's `utilities` layer, and
  // the hover utility ended up never painting inside module sidebars. An inline
  // style is immune to that race. Same approach as LeftRail, which already
  // drives its hover from JS for this exact reason.
  const ACTIVE_BG = 'var(--color-primary-light, #d3e3fd)'
  // Hover = plain grey (user request), not a primary tint; the ACTIVE row is
  // untouched (bgFor keeps ACTIVE_BG whatever the hover state).
  const HOVER_BG  = 'var(--kb-sidebar-hover, #e8eaed)'
  const bgFor = (a: boolean, hovered: boolean) =>
    a ? ACTIVE_BG : hovered ? HOVER_BG : 'transparent'
  const hoverHandlers = (a: boolean) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.backgroundColor = bgFor(a, true)
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.backgroundColor = bgFor(a, false)
    },
  })

  const content = (
    <>
      {/* Fixed 32px box so the icon keeps its place (and lands ~centred in the rail)
          while the label tweens its width to zero - no icon jump on collapse.
          `relative` so the collapsed badge dot anchors to the ICON: the row is a
          `rounded-full` + `overflow-hidden` pill, so a dot at the pill's own corner
          gets clipped by the rounded edge into a triangle sliver. The icon sits at
          the row's vertical centre, well clear of the rounded corners. */}
      <span className="relative w-8 flex items-center justify-center flex-shrink-0">
        {icon}
        {collapsed && badge != null && badge > 0 && (
          <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-primary" />
        )}
      </span>
      <span
        className="truncate transition-all duration-200 ease-in-out"
        style={{
          maxWidth: collapsed ? 0 : 180,
          opacity: collapsed ? 0 : 1,
          marginLeft: collapsed ? 0 : 8,
          flex: collapsed ? '0 1 0%' : '1 1 auto',
        }}
      >
        {label}
      </span>
      {!collapsed && badge != null && badge > 0 && (
        <span className="text-xs bg-primary text-white rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center flex-shrink-0">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </>
  )

  // Both variants render an <a> anchor (never a <button>) and both carry a real
  // href: `to` → React Router <Link> (href = the route); `onClick` → an anchor
  // acting as a button, href '#' by default (in-page action: category filter,
  // section toggle…) so the whole sidebar is anchors + spans.
  const node = to != null ? (
    <Link to={to} aria-label={label} aria-current={isActive ? 'page' : undefined}
      onClick={onClick} className={cls(isActive)}
      style={{ backgroundColor: bgFor(isActive, false) }} {...hoverHandlers(isActive)}>
      {content}
    </Link>
  ) : (
    <a
      href={href}
      role="button"
      aria-label={label}
      // '#' anchors must not push a hash onto the URL nor jump to the top.
      onClick={e => { if (href === '#') e.preventDefault(); onClick?.() }}
      // Enter is handled natively by the anchor; only Space needs wiring.
      onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); onClick?.() } }}
      className={`${cls(isActive)} cursor-pointer`}
      style={{ backgroundColor: bgFor(isActive, false) }}
      {...hoverHandlers(isActive)}
    >
      {content}
    </a>
  )

  // ALWAYS wrap in the tooltip (disabled while expanded) - it clones its child, so
  // the anchor keeps a stable identity across the collapse toggle and its label
  // tween actually plays. Wrapping only when collapsed would remount the node and
  // skip the animation. The bubble (label) only shows in the collapsed rail.
  return <Tooltip label={label} side="right" disabled={!collapsed}>{node}</Tooltip>
}

// Themeable core shell object: a theme can override the sidebar nav item.
export const SidebarNavItem = themed('shell.nav-item', SidebarNavItemBase)
