import { cn } from './cn'
import React, { useCallback, useEffect, useRef } from 'react'
import { easeStandard } from './easing'
import { TOGGLE_GEOMETRY, paintToggle, readTogglePalette } from './toggleCanvas'

interface ToggleProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string
  description?: string
  size?: 'sm' | 'md'
}

const DURATION = 150   // ms - the CSS transition this replaces

/* The switch is drawn on a canvas; the hidden checkbox keeps every native behaviour
 * (label association, keyboard, form submission, assistive technologies). The input
 * remains the single source of truth for the state, exactly as when CSS read
 * `:checked` - the canvas only mirrors it. */
export function Toggle({ label, description, size = 'md', className, id, ...props }: ToggleProps) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, '-')
  const g = TOGGLE_GEOMETRY[size]

  const inputRef  = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const progress  = useRef((props.checked ?? props.defaultChecked ?? false) ? 1 : 0)
  const raf       = useRef(0)
  const painted   = useRef(false)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paintToggle(canvas, { geometry: g, palette: readTogglePalette(canvas), progress: progress.current })
  }, [g])

  const animateTo = useCallback((target: number, instant: boolean) => {
    cancelAnimationFrame(raf.current)
    const from = progress.current
    if (instant || from === target || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      progress.current = target
      draw()
      return
    }
    const start = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION)
      /* The same curve as the CSS transition this replaces. It must be sampled, not
       * approximated: a symmetric ease-in-out barely moves over the first third of such
       * a short animation, which reads as the switch lagging behind the click. */
      progress.current = from + (target - from) * easeStandard(t)
      draw()
      if (t < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }, [draw])

  const syncFromInput = useCallback((instant = false) => {
    animateTo(inputRef.current?.checked ? 1 : 0, instant)
  }, [animateTo])

  // First paint must show the final state outright; later changes animate.
  useEffect(() => {
    syncFromInput(!painted.current)
    painted.current = true
  }, [props.checked, size, syncFromInput])

  useEffect(() => {
    const input = inputRef.current
    const form  = input?.form

    // `change` covers pointer and keyboard toggles (controlled or not). `reset` covers
    // a form restoring its defaults, which does NOT fire `change` - free with CSS,
    // explicit here.
    const onChange = () => syncFromInput()
    const onReset  = () => requestAnimationFrame(() => syncFromInput(true))
    input?.addEventListener('change', onChange)
    form?.addEventListener('reset', onReset)

    /* A canvas is a bitmap, so unlike CSS it has to be repainted when its rendering
     * conditions change. The resolution query catches browser zoom and a move to a
     * screen with another pixel ratio; the observer catches a theme rewriting the
     * colour tokens on :root (the three-layer theme persistence).
     *
     * `device-pixel-content-box` is the primitive meant for this: it reports the box in
     * DEVICE pixels, so it fires precisely when a canvas needs a new backing store. A
     * `resize` listener is not a substitute - changing the pixel ratio while the CSS
     * viewport keeps its size fires no resize event at all (verified).
     *
     * The resolution query is a fallback for engines without that box (Safari). It has
     * to be RE-ARMED after each hit: it is pinned to the ratio current when it was
     * built, so once that ratio stops matching it can never fire again.
     *
     * Safety net beyond both: `paintToggle` re-reads the ratio on every paint, so any
     * repaint at all (a toggle, a theme change) resizes a stale backing store. */
    let observer: ResizeObserver | null = null
    if (canvasRef.current) {
      try {
        observer = new ResizeObserver(() => syncFromInput(true))
        observer.observe(canvasRef.current, { box: 'device-pixel-content-box' })
      } catch {
        observer = null   // box unsupported - the media query below takes over
      }
    }

    let dprQuery: MediaQueryList | null = null
    const onDprChange = () => { armDprQuery(); syncFromInput(true) }
    const armDprQuery = () => {
      dprQuery?.removeEventListener('change', onDprChange)
      dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    armDprQuery()

    const themeObserver = new MutationObserver(() => draw())
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    })

    return () => {
      input?.removeEventListener('change', onChange)
      form?.removeEventListener('reset', onReset)
      observer?.disconnect()
      dprQuery?.removeEventListener('change', onDprChange)
      themeObserver.disconnect()
      cancelAnimationFrame(raf.current)
    }
  }, [draw, syncFromInput])

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex items-start gap-2.5 cursor-pointer select-none',
        props.disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      {/* `mt-0.5` aligns the switch with the first line of the label - with no label
          there is nothing to align to, and it would just offset the switch by 2px. */}
      <div className={cn('relative flex-shrink-0', (label || description) && 'mt-0.5')}>
        <input ref={inputRef} type="checkbox" id={inputId} className="peer sr-only" {...props} />
        {/* The focus ring stays in CSS: `:focus-visible` belongs to the input, and a
            canvas cannot observe a sibling's state. Its radius follows the track so the
            ring hugs the drawn shape. */}
        <canvas
          ref={canvasRef}
          aria-hidden
          className="block peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-1"
          style={{ width: g.width, height: g.height, borderRadius: g.trackRadius }}
        />
      </div>
      {(label || description) && (
        <div className="flex flex-col gap-0.5">
          {label && <span className="text-sm text-text-primary leading-5">{label}</span>}
          {description && <span className="text-xs text-text-secondary">{description}</span>}
        </div>
      )}
    </label>
  )
}
