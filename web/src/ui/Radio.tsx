import { cn } from './cn'
import { useCallback, useEffect, useRef, useState } from 'react'
import { easeStandard } from './easing'
import { paintRadio, RADIO_GEOMETRY, readRadioPalette, type RadioVariant } from './radioCanvas'

interface RadioProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  description?: string
  variant?: RadioVariant
  /** Couleur d'accent (coché). Défaut : bleu primaire. Ex. couleur d'un agenda. */
  color?: string
  disabled?: boolean
  className?: string
  labelClassName?: string
  /** The native radio group: radios sharing a name move the choice with the arrow keys (`RadioGroup`). */
  name?: string
}

const LBL: Record<RadioVariant, { label: string; desc: string }> = {
  default: { label: 'text-sm text-text-primary', desc: 'text-sm text-text-secondary' },
  dark:    { label: 'text-xs text-[#cccccc]', desc: 'text-[11px] text-[#808080]' },
}

const DURATION = 100   // ms - the CSS transition this replaces

/**
 * The control is drawn on a canvas; the hidden `<input type="radio">` keeps every
 * native behaviour (label association, keyboard, form submission, assistive
 * technologies, radio-group semantics). The input remains the single source of
 * truth, exactly as when CSS read `:checked` - the canvas only mirrors it.
 *
 * Same architecture as `Toggle`, including its four repaint triggers: a canvas is a
 * bitmap, so everything CSS used to redo for free has to be re-wired.
 */
export function Radio({
  checked, onChange, label, description,
  variant = 'default', color, disabled = false,
  className, labelClassName, name,
}: RadioProps) {
  const inputRef  = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const progress  = useRef(checked ? 1 : 0)
  const raf       = useRef(0)
  const painted   = useRef(false)
  const [hovered, setHovered] = useState(false)
  // Read inside `draw`, which is not recreated on every hover - a ref keeps the
  // painter in sync without re-arming the observers below.
  const hoverRef = useRef(false)
  hoverRef.current = hovered

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    paintRadio(canvas, {
      geometry: RADIO_GEOMETRY,
      palette:  readRadioPalette(canvas, variant, color),
      progress: progress.current,
      hovered:  hoverRef.current && !disabled,
    })
  }, [variant, color, disabled])

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
      // The same curve as the CSS transition this replaces - sampled, not approximated.
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
  }, [checked, syncFromInput])

  // Hover only recolours the ring - repaint in place, no animation.
  useEffect(() => { draw() }, [hovered, draw])

  useEffect(() => {
    const input = inputRef.current
    const form  = input?.form

    // `change` covers pointer and keyboard toggles. `reset` covers a form restoring
    // its defaults, which does NOT fire `change` - free with CSS, explicit here.
    const onChangeEv = () => syncFromInput()
    const onReset    = () => requestAnimationFrame(() => syncFromInput(true))
    input?.addEventListener('change', onChangeEv)
    form?.addEventListener('reset', onReset)

    /* A canvas is a bitmap, so unlike CSS it must be repainted when its rendering
     * conditions change. `device-pixel-content-box` is the primitive meant for this:
     * it reports the box in DEVICE pixels, so it fires exactly when the backing store
     * needs resizing. A `resize` listener is NOT a substitute - changing the pixel
     * ratio while the CSS viewport keeps its size fires no resize event at all.
     *
     * The resolution query is the fallback for engines without that box (Safari). It
     * has to be RE-ARMED after each hit: it is pinned to the ratio current when built,
     * so once that ratio stops matching it can never fire again. */
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

    // Theme change: the colours are read from the tokens, so a rewrite of :root
    // must repaint.
    const themeObserver = new MutationObserver(() => draw())
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    })

    return () => {
      input?.removeEventListener('change', onChangeEv)
      form?.removeEventListener('reset', onReset)
      observer?.disconnect()
      dprQuery?.removeEventListener('change', onDprChange)
      themeObserver.disconnect()
      cancelAnimationFrame(raf.current)
    }
  }, [draw, syncFromInput])

  return (
    <label
      className={`inline-flex items-start gap-2 select-none ${className ?? ''}`}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="relative mt-px flex-shrink-0" style={{ width: RADIO_GEOMETRY.size, height: RADIO_GEOMETRY.size }}>
        <input
          ref={inputRef}
          type="radio"
          name={name}
          checked={checked}
          disabled={disabled}
          // onClick (et non onChange seul) pour permettre de re-cliquer un radio
          // déjà coché afin de le désélectionner (ex. « module par défaut »).
          onClick={() => { if (!disabled) onChange(!checked) }}
          onChange={() => { /* contrôlé via onClick */ }}
          className="peer sr-only"
        />
        {/* The focus ring stays in CSS: `:focus-visible` belongs to the input, and a
            canvas cannot observe a sibling's state. */}
        <canvas
          ref={canvasRef}
          aria-hidden
          className="block rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-1"
          style={{ width: RADIO_GEOMETRY.size, height: RADIO_GEOMETRY.size }}
        />
      </span>
      {(label || description) && (
        <div className="flex flex-col mt-px min-w-0">
          {label && <span className={cn('leading-snug', LBL[variant].label, labelClassName)}>{label}</span>}
          {description && <span className={cn('leading-snug mt-0.5', LBL[variant].desc)}>{description}</span>}
        </div>
      )}
    </label>
  )
}
