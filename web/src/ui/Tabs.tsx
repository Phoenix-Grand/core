import { cn } from './cn'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { TFunction } from 'i18next'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TabDef<T extends string = string> {
  id:     T
  label:  string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?:  React.ComponentType<any>
  badge?: number | string
}

export interface TabsProps<T extends string = string> {
  tabs:       TabDef<T>[]
  value:      T
  onChange:   (value: T) => void
  /** Extra classes applied to the outer container */
  className?: string
  /** Label text is the default size either way; the sizes differ only in padding.
   *  'sm' → px-3 py-1.5  |  'md' (default) → px-4 py-2 */
  size?:      'sm' | 'md'
  /**
   * underline (default) - bottom-border indicator, horizontal scroll
   * pills               - rounded pill background, no border
   * stretched           - each tab fills equal width, bottom border
   *
   * Every variant is exactly as tall as its tallest tab.
   */
  variant?:   'underline' | 'pills' | 'stretched'
  /** Localises the scroll-arrow labels; falls back to English when absent. */
  t?:         TFunction
}

/** How far the indicator stops short of the tab's own edges, each side. The
 *  mark belongs to the label, not to the whole hit area. */
const INSET = 8

const FALLBACK_LABELS: Record<string, string> = {
  tabs_scroll_left:  'Scroll tabs left',
  tabs_scroll_right: 'Scroll tabs right',
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Tabs<T extends string = string>({
  tabs,
  value,
  onChange,
  className,
  size    = 'md',
  variant = 'underline',
  t,
}: TabsProps<T>) {
  const active = (id: T) => id === value
  const iconSize = size === 'sm' ? 14 : 16
  const tr = (k: string) => (t ? t(k) : (FALLBACK_LABELS[k] ?? k))

  const scrollerRef = useRef<HTMLDivElement>(null)
  const [canScroll, setCanScroll] = useState({ left: false, right: false })

  /**
   * The moving indicator.
   *
   * ONE element for the whole strip, not a mark on each tab. A per-tab
   * pseudo-element can only appear and disappear; a single element can travel,
   * and travelling is what says "this tab, and it came from that one". Its
   * position is measured rather than derived: tabs are sized by their content
   * (and by the font, which finishes loading later), so nothing in CSS knows
   * where the active one starts.
   */
  const listRef = useRef<HTMLDivElement>(null)
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null)
  // The first placement must not be a slide: the indicator would sweep in from
  // the left edge every time the strip is mounted.
  const placed = useRef(false)

  const measureBar = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const tab = list.querySelector<HTMLElement>('[role=tab][aria-selected=true]')
    if (!tab) { setBar(null); return }
    // `offsetLeft` against the list, which is the positioned ancestor here - no
    // rect arithmetic needed, and it is unaffected by the strip's scroll.
    setBar(prev => {
      const next = { left: tab.offsetLeft + INSET, width: Math.max(0, tab.offsetWidth - INSET * 2) }
      return prev && prev.left === next.left && prev.width === next.width ? prev : next
    })
  }, [])

  // Layout effect: measured and placed in the same frame as the tab change, so
  // the eye never catches the indicator at its old size in its new place.
  useLayoutEffect(() => { measureBar() }, [measureBar, value, tabs, size, variant])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    // A relabelled tab, a font that finishes loading, a window that narrows:
    // all move the tabs without firing anything else.
    const ro = new ResizeObserver(() => measureBar())
    ro.observe(list)
    for (const child of Array.from(list.children)) ro.observe(child)
    return () => ro.disconnect()
  }, [measureBar, tabs.length])

  // After the first placement, and only then, movements are animated.
  useEffect(() => { if (bar) placed.current = true }, [bar])

  const syncArrows = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    // 1px slack: fractional layout widths would otherwise leave a phantom arrow
    const max = el.scrollWidth - el.clientWidth
    setCanScroll(prev => {
      const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 }
      return prev.left === next.left && prev.right === next.right ? prev : next
    })
  }, [])

  /**
   * Bring the selected tab into view.
   *
   * A strip that overflows can perfectly well be scrolled to a place the current
   * tab is not: land on `?pane=…` from a link or the back button and the strip
   * shows the first tabs while the panel below shows the last one - the reader
   * is given no way to see where they are.
   *
   * Only the scroller moves, hence the arithmetic rather than `scrollIntoView`,
   * which scrolls every ancestor that can - including the page.
   */
  const revealActive = useCallback((smooth: boolean) => {
    const el = scrollerRef.current
    if (!el) return
    const tab = el.querySelector<HTMLElement>('[role=tab][aria-selected=true]')
    if (!tab) return
    // Rects, not `offsetLeft`: a tab is `relative` (it carries the indicator as
    // a ::before), so its offsetParent is whatever positioned ancestor happens
    // to be above the strip - measured against that, the scroll lands short and
    // the tab stays half out of view.
    const box  = el.getBoundingClientRect()
    const seen = tab.getBoundingClientRect()
    const left  = seen.left - box.left + el.scrollLeft
    const right = left + seen.width
    const behavior = smooth ? 'smooth' : 'auto'
    if (left < el.scrollLeft) el.scrollTo({ left, behavior })
    else if (right > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: right - el.clientWidth, behavior })
    }
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el || variant !== 'underline') return
    syncArrows()
    el.addEventListener('scroll', syncArrows, { passive: true })
    // watch the strip and each tab: a relabelled or re-rendered tab changes the
    // scrollable width without ever firing a scroll event.
    // The reveal rides along: the strip's own width settles AFTER mount (the
    // arrows appear, the shell's rails resolve), and a reveal computed against
    // the width of one frame earlier lands tens of pixels short - measured.
    const ro = new ResizeObserver(() => { syncArrows(); revealActive(false) })
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => {
      el.removeEventListener('scroll', syncArrows)
      ro.disconnect()
    }
  }, [syncArrows, revealActive, variant, tabs.length])

  useEffect(() => {
    if (variant === 'underline') revealActive(true)
  }, [value, variant, revealActive])

  const scrollByPage = (direction: -1 | 1) => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.75), behavior: 'smooth' })
  }

  const containerCls = cn(
    variant === 'pills'     && 'flex gap-1',
    variant === 'stretched' && 'flex border-b border-border',
    className,
  )

  // `underline` and `stretched` share the indicator; only their layout differs.
  const underlined = variant === 'underline' || variant === 'stretched'

  const btnCls = (id: T) => cn(
    'flex items-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors',
    // A HEIGHT, not a pair of paddings. The height of a tab is a decision about
    // the strip, and deriving it from the label's line box made it whatever the
    // font happened to produce - 38.28px, a number nobody chose. Stated once,
    // it survives a font change, a language with taller glyphs and an icon.
    // (`pills` keeps its padding: a pill is a chip around a label, and giving it
    // the height of a tab strip would make it a button. So does the small size,
    // which nothing asked to change.)
    // The small size is left as it was: its 3px are still given back as bottom
    // padding, and nothing asked for it to grow.
    size === 'sm' && (underlined ? 'px-3 pt-1.5 pb-[9px]' : 'px-3 py-1.5'),
    size === 'md' && (underlined ? 'px-4 h-12' : 'px-4 py-2'),

    // underline / stretched share same active/inactive colors
    // No `-mb-px` here. It existed to make the old 3px BORDER overlap the container's
    // 1px divider, but the scrollable strip is `overflow-y-hidden` and sizes itself to
    // the tab's MARGIN box: a negative bottom margin makes the strip 1px shorter than
    // the tab, and that missing pixel is clipped straight off the indicator - a 3px
    // band rendering as 2. Measured.
    // The indicator itself is no longer drawn here: it is ONE element for the
    // whole strip, so that changing tab moves it rather than swapping two marks.
    // Hover tints the whole tab, active or not - the pointer must get an answer
    // wherever it lands, not only on the tabs you have not selected. The active
    // one answers in its OWN colour: a grey wash under blue text reads as the
    // tab going quiet, which is the opposite of what a hover means.
    //
    // ⚠️ The tint is painted by `.kb-tab` / `.kb-tab--on` in the core's own
    // stylesheet, NOT by `hover:bg-*` utilities. A utility here lands in a
    // cascade layer that the browsers' own button reset outranks once the
    // modules' stylesheets have had their say - measured: the rule was
    // generated, the class was on the element, and nothing painted. Unlayered
    // CSS is the only form that cannot lose that argument.
    underlined && 'kb-tab justify-center',
    underlined && active(id)  && 'kb-tab--on text-primary',
    underlined && !active(id) && 'text-text-secondary hover:text-text-primary',

    // stretched: equal-width
    variant === 'stretched' && 'flex-1 justify-center',

    // pills
    variant === 'pills' && 'rounded-md',
    variant === 'pills' && active(id)  && 'bg-primary-light text-primary',
    variant === 'pills' && !active(id) && 'text-text-secondary hover:bg-surface-2',
  )

  /** The travelling mark. `transform` and `width` only - both are composited,
   *  so the slide costs nothing in layout. */
  const indicator = underlined && bar && (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute bottom-0 left-0 h-[3px] rounded-t-[3px] bg-primary',
        // Not animated on its first placement, and never for a reader who asked
        // for less movement.
        placed.current && 'transition-[transform,width] duration-200 ease-out motion-reduce:transition-none',
      )}
      style={{ width: bar.width, transform: `translateX(${bar.left}px)` }}
    />
  )

  const arrowCls = 'flex shrink-0 items-center px-0.5 text-text-secondary transition-colors hover:text-text-primary'

  const items = tabs.map(tab => {
    const Icon = tab.icon
    return (
      <button
        key={tab.id}
        type="button"
        role="tab"
        aria-selected={active(tab.id)}
        onClick={() => onChange(tab.id)}
        className={btnCls(tab.id)}
      >
        {Icon && <Icon size={iconSize} />}
        {tab.label}
        {tab.badge !== undefined && (
          <span
            className={cn(
              'rounded-full text-[11px] font-medium min-w-[18px] h-[18px] flex items-center justify-center px-1',
              active(tab.id)
                ? 'bg-primary text-white'
                : 'bg-surface-3 text-text-secondary',
            )}
          >
            {tab.badge}
          </span>
        )}
      </button>
    )
  })

  if (variant !== 'underline') {
    return (
      <div ref={variant === 'stretched' ? listRef : undefined}
        className={cn(containerCls, variant === 'stretched' && 'relative')} role="tablist">
        {items}
        {indicator}
      </div>
    )
  }

  // The bottom border and the caller's classes live on the outer box so that the
  // rule still spans the full width once the arrows and the scroller split it.
  return (
    <div className={cn('flex items-stretch border-b border-border', className)}>
      {canScroll.left && (
        <button type="button" aria-label={tr('tabs_scroll_left')} className={arrowCls} onClick={() => scrollByPage(-1)}>
          <ChevronLeft size={iconSize} />
        </button>
      )}
      {/* no-scrollbar: an overflowing strip would otherwise reserve ~8px of layout
          height for the horizontal scrollbar, making it taller than its tallest tab */}
      <div
        ref={scrollerRef}
        className="no-scrollbar min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        {/* Every tab gets the width of the WIDEST one. `w-max` sizes the grid to its
            content, and `auto-cols-fr` then splits that width into equal columns -
            under a max-content constraint each equal track resolves to the largest
            item's natural width. Doing it in CSS rather than by measuring in JS keeps
            it correct when the font finishes loading or the language changes. */}
        <div ref={listRef} role="tablist" className="relative grid w-max grid-flow-col auto-cols-fr gap-1">
          {items}
          {indicator}
        </div>
      </div>
      {canScroll.right && (
        <button type="button" aria-label={tr('tabs_scroll_right')} className={arrowCls} onClick={() => scrollByPage(1)}>
          <ChevronRight size={iconSize} />
        </button>
      )}
    </div>
  )
}
