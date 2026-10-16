import { useRef, useEffect, useCallback, useContext, useMemo, useState, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import type { TFunction } from 'i18next'
import { SquareArrowOutUpRight, X } from 'lucide-react'
import { Button } from './Button'
import { uiT } from './uiText'
import { ThemeScopeContext } from './themeRegistry'
import { useWindowZStore } from './windowZStore'
import { useIsMobile } from './interaction'
import { usePortalHost } from './portalHost'
import { MENU_ATTR } from './useMenuDismiss'

// Injected by the desktop client: opens (or refocuses) a real OS window on a SPA
// route, served by the local proxy. Absent on the plain web.
declare global {
  interface Window {
    kubunoDesktop?: {
      openWindow: (
        route: string,
        label?: string,
        opts?: { width?: number; height?: number },
      ) => Promise<void>
    }
  }
}

/** One button of the window's own footer. */
export interface WindowAction {
  label:     string
  onClick:   () => void
  disabled?: boolean
  loading?:  boolean
  /** Destructive: the label turns red. Still a text button, never a filled one. */
  danger?:   boolean
  /** Focused on open - what makes Entrée confirm without a click. */
  autoFocus?: boolean
}

/**
 * What the window puts in its footer.
 *
 * Described, not drawn: the ORDER is decided here and nowhere else - action on
 * the LEFT, cancel on the RIGHT, both the same width. That order is a project
 * rule (the one Word uses), and the only way a rule like it survives a hundred
 * dialogs is if no dialog gets to spell it out.
 *
 * Omitting `actions` renders **no footer at all**: a tool panel - a colour
 * picker, a canvas palette - confirms nothing and must not grow a bar with a
 * lonely "Close" in it.
 */
export interface WindowActions {
  /** The thing this window is for. Absent → only the cancel button shows. */
  confirm?: WindowAction
  /** `false` removes it; otherwise defaults to "Annuler", which calls `onClose`. */
  cancel?:  Partial<WindowAction> | false
  /** Free content pinned to the LEFT edge - a checkbox, a help link, a hint. */
  extra?:   React.ReactNode
}

interface FloatingWindowProps {
  // Contenu
  title:         string | React.ReactNode
  icon?:         React.ReactNode
  children:      React.ReactNode
  titleActions?: React.ReactNode   // boutons à droite du titre (avant le ×)

  /**
   * What the window has to say about ITSELF - a refused save, a caveat that
   * applies to the whole form.
   *
   * Rendered BETWEEN the title bar and the content, therefore **outside the
   * scrolling area**. An alert placed in the flow of a form sinks below the fold
   * as soon as the form is taller than the window, and the operator presses
   * "Save" again without ever seeing why it will not save. Lived through on the
   * building sheet: the refusal was there, at the bottom, out of sight.
   *
   * `null`/`undefined` reserves no space at all.
   */
  banner?:       React.ReactNode

  // Pop-out desktop : quand le client desktop est présent (window.kubunoDesktop),
  // affiche un bouton ↗ « Détacher » qui ouvre `route` dans une vraie fenêtre OS
  // puis ferme ce panneau. Sur le web classique, rien ne change.
  popout?:       { route: string; label?: string; width?: number; height?: number; auto?: boolean }

  // Fermeture
  onClose:       () => void

  // Taille
  defaultWidth?:  number           // défaut : 560
  defaultHeight?: number           // défaut : libre (content-driven)
  minWidth?:      number           // défaut : 280
  minHeight?:     number           // défaut : 120

  // Comportement
  resizable?:    boolean           // défaut : false
  /** `false` hides the title bar's close button (Escape and `onClose` still close the window). Default `true`. */
  showClose?:    boolean
  backdrop?:     boolean           // défaut : false - overlay semi-transparent
  className?:    string            // classes CSS additionnelles sur la fenêtre
  /**
   * Marge intérieure du contenu, en px. **Défaut : 0** - le contenu affleure les bords
   * de la zone opaque, à chaque fenêtre de gérer sa propre respiration. Passer
   * `padding={WINDOW_PADDING}` pour retrouver l'ancienne marge de 20 px.
   */
  padding?:      number

  /**
   * The window's own footer. See [`WindowActions`] - absent means no footer.
   */
  actions?:      WindowActions
  /** Host translator, for the default cancel label (`@ui` never imports i18n). */
  t?:            TFunction
}

/**
 * The open windows, oldest first. Only the last one answers Escape - see the
 * effect that uses it. An opaque token per window is enough; nothing reads
 * anything off it.
 */
const escapeStack: object[] = []

/** Ancienne marge intérieure par défaut, gardée pour les fenêtres qui la veulent. */
export const WINDOW_PADDING = 20

export function FloatingWindow({
  title,
  icon,
  children,
  titleActions,
  banner,
  popout,
  onClose,
  defaultWidth  = 560,
  defaultHeight,
  minWidth      = 280,
  minHeight     = 120,
  resizable     = false,
  showClose     = true,
  backdrop      = false,
  className     = '',
  padding,
  actions,
  t,
}: FloatingWindowProps) {
  const windowRef = useRef<HTMLDivElement>(null)
  const [zIndex, setZIndex] = useState(() => useWindowZStore.getState().next())
  // Hauteur « verrouillée » des fenêtres À ONGLETS dont la taille est pilotée par le
  // contenu : la fenêtre se cale sur l'onglet le plus HAUT et ne rétrécit jamais en
  // changeant d'onglet (0 = pas encore de verrou / fenêtre non tabulée).
  const [lockedH, setLockedH] = useState(0)

  // When a scoped portal host is provided (e.g. the theme preview), mount into it
  // and switch from viewport-relative `fixed` to host-relative `absolute` so the
  // window stays confined to that bounded host. Drag/resize is disabled in this
  // mode (the pixel-mode math is viewport-based and would be wrong inside a host).
  const { host, scoped } = usePortalHost()
  const posCls = scoped ? 'absolute' : 'fixed'

  // ── Carrying the module's scope through the portal ─────────────────────────
  //
  // A window is portaled onto `<body>`, which puts it OUTSIDE the
  // `[data-module="calendar"]` container the host wraps a module in - and that
  // container is where the module's accent, appearance and density live. Without
  // this, every window came out in the core's blue no matter which module opened
  // it, and a module in dark mode opened a light dialog.
  //
  // The scope id comes from the context the host already provides for theming;
  // the presentation attributes are read off the live container, which is the
  // only place that knows the user's current choice for that module.
  // The context covers windows opened from the module's own area. A sidebar -
  // where "Importer un agenda" lives - sits OUTSIDE that provider, so the first
  // URL segment is the fallback: it is the very rule the host uses to decide
  // which module a screen belongs to.
  const contextScope = useContext(ThemeScopeContext)
  const scopeAttrs = useMemo<Record<string, string>>(() => {
    if (typeof document === 'undefined') return {}
    const scope = contextScope
      ?? window.location.pathname.split('/').filter(Boolean)[0]
      ?? ''
    if (!scope) return {}
    // Only when the module really has a scoped container: inventing the attribute
    // on a core page would claim a theme nobody defined.
    const container = document.querySelector(`[data-module="${CSS.escape(scope)}"]`)
    if (!container) return {}
    const attrs: Record<string, string> = { 'data-module': scope }
    for (const name of ['data-kb-appearance', 'data-kb-density', 'data-kb-scheme']) {
      const value = container.getAttribute(name)
      if (value) attrs[name] = value
    }
    return attrs
  }, [contextScope])

  const isDragging = useRef(false)
  const dragOrigin = useRef({ mx: 0, my: 0, wx: 0, wy: 0 })
  // Tracks whether the element is already in pixel-position mode
  const inPxMode   = useRef(false)

  // Resize state
  const isResizing  = useRef(false)
  const resizeEdge  = useRef('')
  const resizeOrigin = useRef({ mx: 0, my: 0, wx: 0, wy: 0, ww: 0, wh: 0 })

  const bringToFront = useCallback(() => {
    setZIndex(useWindowZStore.getState().next())
  }, [])

  /**
   * Raise this window, and let no one else read the same press.
   *
   * A window opened BY another window is a React child of it, and a portal
   * carries events up the REACT tree, not the DOM one - so a press inside the
   * inner window reached the outer window's own handler a moment later, which
   * raised the outer one on top of the window the reader had just clicked.
   * (Lived through: the meeting options disappeared behind the event editor
   * that opened them.)
   *
   * Stopping here is right in itself: a window is a surface of its own, and a
   * press inside it is addressed to it, never to whichever component happened
   * to render it. Dismissal handlers that must still see the press listen
   * natively in the capture phase, which this does not touch.
   */
  const onWindowMouseDown = useCallback((e: React.MouseEvent) => {
    bringToFront()
    e.stopPropagation()
  }, [bringToFront])

  // Passe en mode pixel (left/top px ENTIERS, transform: none).
  // Le centrage CSS `translate(-50%, -33%)` pose la fenêtre sur des DEMI-pixels
  // dès que sa largeur est impaire : le clip arrondi (overflow hidden) et le
  // tracé du bandeau se snappent alors différemment → filets verticaux d'1px le
  // long du bandeau. On détache donc du centrage dès le montage, en arrondissant
  // à des coordonnées entières.
  const switchToPixelMode = useCallback(() => {
    const el = windowRef.current
    if (!el || inPxMode.current) return
    const rect = el.getBoundingClientRect()
    el.style.transform = 'none'
    el.style.left      = `${Math.round(rect.left)}px`
    el.style.top       = `${Math.round(rect.top)}px`
    inPxMode.current   = true
  }, [])

  // Dès le montage (fenêtre flottante seulement) : jamais de position fractionnaire.
  useLayoutEffect(() => {
    if (!fullBleed) switchToPixelMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Drag ───────────────────────────────────────────────────────────────────

  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scoped) return
    if ((e.target as HTMLElement).closest('button,a,input,select,textarea')) return
    const el = windowRef.current
    if (!el) return

    bringToFront()
    switchToPixelMode()

    const rect = el.getBoundingClientRect()
    isDragging.current  = true
    dragOrigin.current  = { mx: e.clientX, my: e.clientY, wx: rect.left, wy: rect.top }
    e.preventDefault()
  }, [bringToFront, switchToPixelMode, scoped])

  // ── Resize ─────────────────────────────────────────────────────────────────

  const onResizeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (scoped) return
    const el = windowRef.current
    if (!el) return

    bringToFront()
    switchToPixelMode()

    const rect = el.getBoundingClientRect()
    isResizing.current  = true
    resizeEdge.current  = e.currentTarget.dataset.edge ?? ''
    resizeOrigin.current = {
      mx: e.clientX, my: e.clientY,
      wx: rect.left, wy: rect.top,
      ww: rect.width, wh: rect.height,
    }
    e.preventDefault()
    e.stopPropagation()
  }, [bringToFront, switchToPixelMode, scoped])

  // ── Global mouse listeners ─────────────────────────────────────────────────

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const el = windowRef.current
      if (!el) return

      if (isDragging.current) {
        const { mx, my, wx, wy } = dragOrigin.current
        const nx = wx + e.clientX - mx
        const ny = wy + e.clientY - my
        // Clamp : garder au moins 100px de barre de titre accessible
        const maxX = window.innerWidth  - 100
        const maxY = window.innerHeight - 40
        el.style.left = `${Math.max(-el.offsetWidth + 100, Math.min(maxX, nx))}px`
        el.style.top  = `${Math.max(0, Math.min(maxY, ny))}px`
        return
      }

      if (isResizing.current) {
        const { mx, my, wx, wy, ww, wh } = resizeOrigin.current
        const dx = e.clientX - mx
        const dy = e.clientY - my
        const edge = resizeEdge.current

        let newW = ww, newH = wh, newX = wx, newY = wy

        if (edge.includes('e')) newW = Math.max(minWidth,  ww + dx)
        if (edge.includes('s')) newH = Math.max(minHeight, wh + dy)
        if (edge.includes('w')) { newW = Math.max(minWidth,  ww - dx); newX = wx + (ww - newW) }
        if (edge.includes('n')) { newH = Math.max(minHeight, wh - dy); newY = wy + (wh - newH) }

        el.style.width  = `${newW}px`
        el.style.height = `${newH}px`
        el.style.left   = `${newX}px`
        el.style.top    = `${newY}px`
      }
    }

    const onUp = () => {
      isDragging.current  = false
      isResizing.current  = false
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [minWidth, minHeight])

  // ── Echap ──────────────────────────────────────────────────────────────────

  /**
   * Escape closes the TOP window, and only it.
   *
   * Every open window used to listen for itself, so one press closed the lot -
   * a settings window and the window that opened it went together, and the
   * reader lost work they never meant to leave. The windows keep a stack: the
   * last one opened is the one that answers, and it consumes the key so the
   * page underneath does not act on it as well.
   */
  useEffect(() => {
    const me = {}
    escapeStack.push(me)
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (escapeStack[escapeStack.length - 1] !== me) return
      // An open menu or list owns Escape: it closes itself, not the window
      // around it. Asked of the page rather than left to listener order -
      // both listen in the capture phase, and whichever registered first would
      // otherwise win, which is whichever mounted first. (Lived through: a
      // dropdown's Escape closed the whole editor behind it.)
      if (document.querySelector(`[${MENU_ATTR}]`)) return
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      // In the detached OS window, Escape closes the window, not just the component.
      const standalone = popout && !scoped
        && window.location.pathname + window.location.search === popout.route
      if (standalone) { try { window.close() } catch { /* best-effort */ } }
      onClose()
    }
    window.addEventListener('keydown', h, true)
    return () => {
      const i = escapeStack.indexOf(me)
      if (i >= 0) escapeStack.splice(i, 1)
      window.removeEventListener('keydown', h, true)
    }
  }, [onClose, popout, scoped])

  // ── Hauteur stable des fenêtres à onglets ──────────────────────────────────
  // Quand la fenêtre contient des onglets (`[role="tablist"]`, posé par le composant
  // `Tabs` - ou `[data-fw-tabs]` pour un bandeau d'onglets maison) ET que sa hauteur
  // est libre (pilotée par le contenu), on mémorise la hauteur MAXIMALE observée et
  // on l'impose en `minHeight` : changer d'onglet ne fait plus « sauter » la fenêtre,
  // elle reste calée sur l'onglet le plus haut. Les fenêtres SANS onglets continuent
  // de suivre naturellement leur contenu (aucune régression).
  useEffect(() => {
    const el = windowRef.current
    // Hauteur fixe (`defaultHeight`) ou hôte scopé → dimensionnement déjà stable.
    if (!el || scoped || defaultHeight !== undefined) return
    let max = 0
    const measure = () => {
      if (!el.querySelector('[role="tablist"],[data-fw-tabs]')) return
      const limit = window.innerHeight - 16          // ne jamais dépasser le viewport
      const h = Math.min(el.offsetHeight, limit)
      if (h > max + 0.5) { max = h; setLockedH(h) }   // croît vers l'onglet le plus haut
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [scoped, defaultHeight])

  // ── Pop-out desktop AUTOMATIQUE ────────────────────────────────────────────
  // On the desktop client, a popout-able floating window EXTRACTS itself into a
  // real OS window instead of rendering in-page (user requirement). The ↗ button
  // remains the manual path for callers that opt out (`popout.auto === false`).
  // Anti-loop guard: never auto-popout when already standing on the target route
  // (that IS the detached window rendering the component normally).
  const shouldAutoPopout = Boolean(
    popout
      && popout.auto !== false
      && typeof window !== 'undefined'
      && window.kubunoDesktop
      && window.location.pathname + window.location.search !== popout.route,
  )
  const autoFired = useRef(false)
  useEffect(() => {
    if (shouldAutoPopout && !autoFired.current && popout) {
      autoFired.current = true
      const label = popout.label ?? (typeof title === 'string' ? title : undefined)
      const opts = popout.width || popout.height
        ? { width: popout.width, height: popout.height }
        : undefined
      void window.kubunoDesktop?.openWindow(popout.route, label, opts)
      onClose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldAutoPopout])

  // ── Render ─────────────────────────────────────────────────────────────────

  // Auto-popout: the OS window is opening - render nothing in-page.
  if (shouldAutoPopout) return null

  // Standalone/full-bleed: we ARE the detached OS window (on `popout.route`).
  // Drop the floating chrome (rounded corners, shadow, centering, size clamps)
  // and fill the whole viewport, so the OS window shows the app edge-to-edge
  // rather than a card floating in a blank page. The internal ✕ closes the OS
  // window (best-effort) in addition to unmounting.
  const isStandalone = Boolean(
    popout
      && typeof window !== 'undefined'
      && !scoped
      && window.location.pathname + window.location.search === popout.route,
  )
  // Phones get the same full-bleed treatment: a 560px-wide draggable card on a
  // 390px screen is clamped to a sliver, and dragging/resizing are meaningless
  // without a mouse. Scoped windows (bounded portal host, e.g. theme preview)
  // keep their card so they stay inside their box.
  const isMobile = useIsMobile()
  const fullBleed = isStandalone || (isMobile && !scoped)
  // Plain function (not a hook) - declared after the conditional return above.
  const closeWindow = () => {
    if (isStandalone && typeof window !== 'undefined') {
      try { window.close() } catch { /* best-effort */ }
    }
    onClose()
  }

  // ── The footer, drawn ONCE for the whole product ───────────────────────────
  //
  // Order, widths and styling live here so that a hundred dialogs cannot each
  // have an opinion: the action sits on the LEFT and the cancel on the RIGHT
  // (the order Word uses, and the project's rule), both at the same minimum
  // width so the pair never jitters from one window to the next.
  //
  // Text buttons, not filled ones - the hierarchy is carried by colour, exactly
  // as the reference dialog does it, and buttons are never bold anywhere in this
  // product.
  const tr = uiT(t)
  const cancelSpec = actions?.cancel === false ? null : {
    label:   actions?.cancel?.label ?? tr('ui.cancel'),
    onClick: actions?.cancel?.onClick ?? closeWindow,
    disabled: actions?.cancel?.disabled,
  }
  const footer = actions ? (
    <div className="kb-window-footer flex items-center gap-2 px-4 py-3 flex-shrink-0">
      {actions.extra && <div className="min-w-0 flex-1">{actions.extra}</div>}
      <div className="ms-auto flex items-center gap-2">
        {actions.confirm && (
          <Button
            variant={actions.confirm.danger ? 'textDanger' : 'text'}
            className="min-w-[96px]"
            disabled={actions.confirm.disabled}
            loading={actions.confirm.loading}
            autoFocus={actions.confirm.autoFocus}
            onClick={actions.confirm.onClick}
          >
            {actions.confirm.label}
          </Button>
        )}
        {cancelSpec && (
          <Button
            variant="ghost"
            className="min-w-[96px]"
            disabled={cancelSpec.disabled}
            onClick={cancelSpec.onClick}
          >
            {cancelSpec.label}
          </Button>
        )}
      </div>
    </div>
  ) : null

  const resizeHandles = resizable ? (
    <>
      {/* Bords */}
      {/* 5px grab strips along the edges - the frame they used to sit on is gone,
          but the affordance stays where the hand expects it. */}
      <div data-edge="n"  onMouseDown={onResizeMouseDown} className="absolute top-0    left-2  right-2  h-[5px] cursor-n-resize  z-10" />
      <div data-edge="s"  onMouseDown={onResizeMouseDown} className="absolute bottom-0 left-2  right-2  h-[5px] cursor-s-resize  z-10" />
      <div data-edge="w"  onMouseDown={onResizeMouseDown} className="absolute top-2   left-0  bottom-2  w-[5px] cursor-w-resize  z-10" />
      <div data-edge="e"  onMouseDown={onResizeMouseDown} className="absolute top-2   right-0 bottom-2  w-[5px] cursor-e-resize  z-10" />
      {/* Coins */}
      <div data-edge="nw" onMouseDown={onResizeMouseDown} className="absolute top-0    left-0  w-3 h-3  cursor-nw-resize z-20" />
      <div data-edge="ne" onMouseDown={onResizeMouseDown} className="absolute top-0    right-0 w-3 h-3  cursor-ne-resize z-20" />
      <div data-edge="sw" onMouseDown={onResizeMouseDown} className="absolute bottom-0 left-0  w-3 h-3  cursor-sw-resize z-20" />
      {/* Bottom-right corner carries the VISIBLE grip, as on the reference: the window
          is resizable, so say so rather than hide the affordance. */}
      <div data-edge="se" onMouseDown={onResizeMouseDown}
           className="kb-window-grip absolute bottom-[2px] right-[2px] w-[18px] h-[18px] rounded cursor-nwse-resize z-20" />
    </>
  ) : null

  const content = (
    <>
      {backdrop && !isStandalone && (
        <div
          className={`${posCls} inset-0 ${scoped ? 'bg-black/15' : 'bg-black/30'} backdrop-blur-[1px] no-print`}
          style={{ zIndex: zIndex - 1 }}
          // The veil belongs to THIS window, and a press on it is addressed to
          // this window - not to whichever component rendered it.
          //
          // Without this, a press on the veil of a window opened by another one
          // travelled up the React tree (a portal carries events there, not
          // along the DOM) and raised the OUTER window instead. Two things then
          // went wrong at once: the inner window sank out of reach, and the
          // click never closed it - the outer window's own veil had slid on top
          // between the press and the release, so the press and the release
          // landed on different elements and no click was ever formed. Both
          // symptoms, one cause. (Reported: "it goes behind and I cannot bring
          // it back".)
          onMouseDown={e => { bringToFront(); e.stopPropagation() }}
          onClick={onClose}
        />
      )}

      <div
        ref={windowRef}
        {...scopeAttrs}
        role="dialog"
        aria-modal={backdrop && !isStandalone}
        // Full-bleed IS the OS window / the phone screen: it must stay opaque, there is
        // nothing meaningful behind it to show through. Only a floating card gets glass.
        // No overflow-hidden on the floating card: a rounded clip is applied by
        // Chromium as an antialiased mask over the whole path on some GPUs,
        // leaving 1px light seams along the band. Band and content round their
        // own corners instead (index.css).
        className={`${posCls} flex flex-col no-print ${className} ${
          fullBleed ? 'overflow-hidden inset-0 bg-white' : 'kb-window'
        }`}
        style={fullBleed ? {
          // Full-bleed: fill the OS window edge-to-edge, no chrome, no clamps.
          width:  '100vw',
          height: '100dvh',
          left:   0,
          top:    0,
          zIndex,
        } : {
          width:     defaultWidth,
          height:    defaultHeight,
          // Clamp to the host: a `minWidth` wider than the host (mobile) would
          // otherwise overflow (min-width wins over max-width in CSS). The host
          // is the viewport (`vw/vh`) or, when scoped, the bounded portal host.
          minWidth:  scoped ? `min(${minWidth}px, calc(100% - 16px))` : `min(${minWidth}px, calc(100vw - 16px))`,
          // Fenêtre à onglets : hauteur verrouillée sur l'onglet le plus haut (lockedH).
          minHeight: lockedH ? `${lockedH}px`
            : scoped ? `min(${minHeight}px, calc(100% - 16px))` : `min(${minHeight}px, calc(100vh - 16px))`,
          maxWidth:  scoped ? 'calc(100% - 16px)' : 'calc(100vw - 16px)',
          maxHeight: scoped ? 'calc(100% - 16px)' : 'calc(100vh - 16px)',
          zIndex,
          // Position CSS initiale : centré. Remplacée par left/top px au premier drag.
          left:      '50%',
          top:       '33%',
          transform: 'translate(-50%, -33%)',
        }}
        onMouseDown={fullBleed ? undefined : onWindowMouseDown}
      >
        {!fullBleed && resizeHandles}

        {/* Le bandeau. Même traitement en plein cadre (fenêtre OS détachée,
            téléphone) : une seule fenêtre à reconnaître, pas deux. */}
        <div
          // Min-height rather than a fixed height: a title that wraps onto two
          // lines - "Réinitialiser le mot de passe de Marie Dupont" - must push
          // the band down instead of being clipped by it.
          className={`kb-window-titlebar flex items-center gap-2.5 px-4 py-2.5 min-h-11 flex-shrink-0 select-none ${
            fullBleed ? '' : 'cursor-grab active:cursor-grabbing'}`}
          onMouseDown={fullBleed ? undefined : onTitleMouseDown}
        >
          {icon && <div className="flex-shrink-0">{icon}</div>}
          <div
            className="flex-1 min-w-0 font-medium"
            style={{ fontSize: 'var(--kb-text-heading)' }}
          >
            {title}
          </div>
          {titleActions && (
            <div
              className="kb-window-actions flex items-center gap-1 flex-shrink-0"
              onMouseDown={e => e.stopPropagation()}
            >
              {titleActions}
            </div>
          )}
          {popout && typeof window !== 'undefined' && window.kubunoDesktop
            // Already standing on the target route (popped-out window) → no button.
            && window.location.pathname + window.location.search !== popout.route && (
            <button
              onClick={() => {
                const label = popout.label ?? (typeof title === 'string' ? title : undefined)
                const opts = popout.width || popout.height
                  ? { width: popout.width, height: popout.height }
                  : undefined
                void window.kubunoDesktop?.openWindow(popout.route, label, opts)
                onClose()
              }}
              onMouseDown={e => e.stopPropagation()}
              title="Détacher dans une fenêtre"
              className="flex-shrink-0 grid place-items-center w-[30px] h-[30px] rounded-[5px]
                         text-current opacity-80 transition-colors hover:opacity-100 hover:bg-white/20"
            >
              <SquareArrowOutUpRight size={14} />
            </button>
          )}
          {showClose && <button
            onClick={closeWindow}
            onMouseDown={e => e.stopPropagation()}
            title="Fermer (Échap)"
            className="flex-shrink-0 grid place-items-center w-[30px] h-[30px] rounded-[5px]
                       text-current opacity-80 transition-colors hover:opacity-100 hover:bg-white/20"
          >
            <X size={15} strokeWidth={2.2} />
          </button>}
        </div>

        {/* The window's alert: under the title, ABOVE the scrolling area, so it
            stays in sight. `shrink-0` keeps a long form from squeezing it. */}
        {banner && <div className="flex-shrink-0 px-4 pt-3">{banner}</div>}

        {/* Contenu - aucune marge par défaut : le contenu affleure la zone opaque.
            Une fenêtre qui veut de la respiration passe `padding`. */}
        <div
          className={`flex-1 flex flex-col min-h-0 overflow-auto ${
            fullBleed ? 'bg-white' : 'kb-window-content'}`}
          style={{ padding: padding ?? 0 }}
        >
          {children}
        </div>

        {footer}
      </div>
    </>
  )

  return createPortal(content, host ?? document.body)
}
