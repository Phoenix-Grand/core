import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TOOLTIP_STYLE } from '@ui'
import { placeTooltip } from '../../../ui/tooltipPlacement'

/**
 * Turns EVERY native `title` attribute in the app into the project's tooltip.
 *
 * Rewriting ~1250 `title=` occurrences across the 18 modules into <Tooltip>
 * wrappers was not realistic, and any module written later would silently fall
 * back to the browser bubble again. So the shell intercepts them centrally: on
 * hover the attribute is moved to `data-kbtitle` (removing it is what suppresses
 * the native bubble) and a styled bubble is drawn instead; it is restored when
 * the pointer leaves, so the DOM keeps its accessible name.
 *
 * Components that need control - a forced side, a rich label, no delay - use the
 * `Tooltip` primitive from `@ui` directly; those carry no `title`, so they are
 * untouched by this.
 */
const DELAY   = 400
const STASH   = 'data-kbtitle'

interface Bubble { text: string; left: number; top: number; ready: boolean }

export default function TitleTooltips() {
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const timer   = useRef<number | null>(null)
  const holder  = useRef<HTMLElement | null>(null)
  const pointer = useRef({ x: 0, y: 0 })
  const bubbleRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const restore = () => {
      const el = holder.current
      if (el?.isConnected) {
        const t = el.getAttribute(STASH)
        if (t != null) { el.setAttribute('title', t); el.removeAttribute(STASH) }
      }
      holder.current = null
    }
    const hide = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null }
      restore()
      setBubble(null)
    }

    // Anchored to the POINTER (below it, left-aligned) - see placeTooltip.
    const show = (text: string) => {
      const p = placeTooltip(pointer.current.x, pointer.current.y, { width: 0, height: 0 })
      setBubble({ text, left: p.left, top: p.top, ready: false })
    }

    const onMove = (e: Event) => {
      const m = e as MouseEvent
      pointer.current = { x: m.clientX, y: m.clientY }
    }

    const onOver = (e: Event) => {
      const target = (e.target as HTMLElement | null)?.closest?.('[title]') as HTMLElement | null
      if (!target) return
      const text = target.getAttribute('title')?.trim()
      if (!text) return
      if (holder.current === target) return
      hide()
      // Stash it straight away: keeping it would let the native bubble appear.
      target.setAttribute(STASH, text)
      target.removeAttribute('title')
      holder.current = target
      timer.current = window.setTimeout(() => show(text), DELAY)
    }

    const onOut = (e: Event) => {
      const rel = (e as MouseEvent).relatedTarget as Node | null
      if (holder.current && rel && holder.current.contains(rel)) return
      hide()
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout',  onOut,  true)
    document.addEventListener('mousedown', hide,   true)
    document.addEventListener('keydown',   hide,   true)
    document.addEventListener('scroll',    hide,   true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout',  onOut,  true)
      document.removeEventListener('mousedown', hide,   true)
      document.removeEventListener('keydown',   hide,   true)
      document.removeEventListener('scroll',    hide,   true)
      window.removeEventListener('blur', hide)
      hide()
    }
  }, [])

  // Laid out invisibly, measured, then revealed in place: useLayoutEffect runs
  // before the browser paints, so the user never sees the bubble move.
  useLayoutEffect(() => {
    if (!bubble || bubble.ready || !bubbleRef.current) return
    const r = bubbleRef.current.getBoundingClientRect()
    const p = placeTooltip(pointer.current.x, pointer.current.y, { width: r.width, height: r.height })
    setBubble({ ...bubble, left: p.left, top: p.top, ready: true })
  }, [bubble])

  if (!bubble) return null

  return createPortal(
    <div ref={bubbleRef} role="tooltip" data-kb-tooltip
      style={{ ...TOOLTIP_STYLE, left: bubble.left, top: bubble.top,
               visibility: bubble.ready ? 'visible' : 'hidden' }}>
      {bubble.text}
    </div>,
    document.body,
  )
}
