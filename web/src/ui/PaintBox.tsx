import React, { useEffect, useLayoutEffect, useRef } from 'react'

import { cn } from './cn'

/** What a `PaintBox` gives its painter: a 2D context already scaled to CSS pixels, the size, the pixel ratio. */
export interface PaintArgs {
  readonly ctx: CanvasRenderingContext2D
  /** CSS pixels. */
  readonly width: number
  readonly height: number
  /** Device pixels per CSS pixel (the backing store is `width × dpr`). */
  readonly dpr: number
  /** The `data` the box was given (`PaintData`), for the painter to draw. */
  readonly data?: unknown
}

export interface PaintBoxProps {
  /** Draws the surface. Called on mount, on every resize or pixel-ratio change, and when `data` changes. */
  onPaint?: (e: PaintArgs) => void
  /** What the drawing depends on: a new value repaints. */
  data?: unknown
  className?: string
  style?: React.CSSProperties
  /** The drawing's text alternative; empty = decorative. */
  'aria-label'?: string
}

/** Sizes a canvas's backing store for its CSS box and DPR, and returns the painter's arguments (`null` when not drawable). */
export function preparePaint(canvas: HTMLCanvasElement, dpr: number, data?: unknown): PaintArgs | null {
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  const ctx = canvas.getContext('2d')
  if (!ctx || width <= 0 || height <= 0) return null
  const w = Math.round(width * dpr)
  const h = Math.round(height * dpr)
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return { ctx, width, height, dpr, data }
}

/**
 * A drawing surface (the `.kbview` `PaintBox`): a `<canvas>` whose `OnPaint` handler draws with the 2D context,
 * in CSS pixels at any pixel ratio - charts, previews, small custom visuals. Repainted when it is resized, when the
 * pixel ratio changes (zoom, another screen) and when `PaintData` changes.
 */
export const PaintBox = React.forwardRef<HTMLCanvasElement, PaintBoxProps>(function PaintBox(
  { onPaint, data, className, style, ...aria },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const painter = useRef(onPaint)
  painter.current = onPaint
  const dataRef = useRef(data)
  dataRef.current = data
  const paint = () => {
    const el = canvas.current
    if (!el) return
    const args = preparePaint(el, window.devicePixelRatio || 1, dataRef.current)
    if (args) painter.current?.(args)
  }
  useLayoutEffect(paint, [data])
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => paint())
    ro?.observe(el)
    let query: MediaQueryList | null = null
    const arm = () => {
      query?.removeEventListener('change', onDpr)
      if (typeof matchMedia !== 'function') return
      query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      query.addEventListener('change', onDpr)
    }
    const onDpr = () => { arm(); paint() }
    arm()
    return () => { ro?.disconnect(); query?.removeEventListener('change', onDpr) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const setRefs = (el: HTMLCanvasElement | null) => {
    canvas.current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }
  const label = aria['aria-label']
  return (
    <canvas
      ref={setRefs}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('block w-full', className)}
      style={{ height: 150, ...style }}
    />
  )
})

PaintBox.displayName = 'PaintBox'
