import { cn } from './cn'
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import { usePortalHost } from './portalHost'
import { useIsMobile } from './interaction'
import { uiT } from './uiText'

export type ToastVariant = 'info' | 'success' | 'warning' | 'danger'

export interface ToastOptions {
  message:  ReactNode
  title?:   ReactNode
  variant?: ToastVariant
  /** Lifetime in ms. `0` keeps it until dismissed - use it for failures the
   *  user must acknowledge. Defaults to 4000 (6000 for `danger`). */
  duration?: number
  /** One inline action: "Undo", "See details", "Retry". */
  action?:  { label: string; onClick: () => void }
  /** Reuse an id to REPLACE a toast instead of stacking a duplicate (e.g. a
   *  save indicator fired on every keystroke). */
  id?:      string
}

interface ToastEntry extends ToastOptions {
  id:       string
  variant:  ToastVariant
  duration: number
}

export interface ToastApi {
  toast:   (opts: ToastOptions) => string
  info:    (message: ReactNode, opts?: Omit<ToastOptions, 'message' | 'variant'>) => string
  success: (message: ReactNode, opts?: Omit<ToastOptions, 'message' | 'variant'>) => string
  warning: (message: ReactNode, opts?: Omit<ToastOptions, 'message' | 'variant'>) => string
  error:   (message: ReactNode, opts?: Omit<ToastOptions, 'message' | 'variant'>) => string
  dismiss: (id: string) => void
  dismissAll: () => void
}

const ToastContext = createContext<ToastApi | null>(null)

const SKIN: Record<ToastVariant, { icon: string; Glyph: typeof Info }> = {
  info:    { icon: 'text-primary', Glyph: Info },
  success: { icon: 'text-success', Glyph: CheckCircle2 },
  warning: { icon: 'text-warning', Glyph: AlertTriangle },
  danger:  { icon: 'text-danger',  Glyph: AlertCircle },
}

let seq = 0
const nextId = () => `kb-toast-${++seq}`

export interface ToastProviderProps {
  children:   ReactNode
  /** Maximum number of stacked toasts; the oldest is dropped past it. */
  max?:       number
  /** Desktop anchor. Mobile always docks to the bottom edge, full width. */
  placement?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-center'
  t?:         TFunction
}

const PLACEMENT: Record<NonNullable<ToastProviderProps['placement']>, string> = {
  'bottom-right': 'bottom-4 right-4 items-end',
  'bottom-left':  'bottom-4 left-4 items-start',
  'top-right':    'top-4 right-4 items-end',
  'top-center':   'top-4 left-1/2 -translate-x-1/2 items-center',
}

/**
 * ToastProvider - the transient-notification host.
 *
 * It replaces the eight copies of "set a flag, `setTimeout` it away, flip a
 * button label" scattered across the admin and settings panels, each with its
 * own delay (1500/1600/1800/2000/2200/2500 ms) and none of them announced to
 * assistive tech.
 *
 * Two live regions, not one: `polite` for info/success (they must not cut into
 * what the screen reader is currently saying) and `assertive` for
 * warning/danger. Placing them in separate containers is what lets a failure
 * jump the queue while a "Saved" stays polite.
 *
 * Timers pause while the pointer is over the stack or the focus is inside it -
 * otherwise a toast carrying an "Undo" can expire under the cursor on its way
 * to the button.
 *
 * Mount it once, high in the tree. It portals through `usePortalHost()`, so
 * inside a bounded stage (the admin theme preview) the toasts stay in the box.
 */
export function ToastProvider({ children, max = 4, placement = 'bottom-right', t }: ToastProviderProps) {
  const tr = uiT(t)
  const [items, setItems] = useState<ToastEntry[]>([])
  const isMobile = useIsMobile()
  const { host } = usePortalHost()
  const paused = useRef(false)
  // Remaining lifetime per toast, ticked down by a single interval - a
  // per-toast `setTimeout` cannot be paused without being rebuilt.
  const left = useRef<Map<string, number>>(new Map())

  const dismiss = useCallback((id: string) => {
    left.current.delete(id)
    setItems(list => list.filter(x => x.id !== id))
  }, [])

  const dismissAll = useCallback(() => {
    left.current.clear()
    setItems([])
  }, [])

  const push = useCallback((opts: ToastOptions): string => {
    const variant  = opts.variant ?? 'info'
    const duration = opts.duration ?? (variant === 'danger' ? 6000 : 4000)
    const id       = opts.id ?? nextId()
    const entry: ToastEntry = { ...opts, id, variant, duration }
    if (duration > 0) left.current.set(id, duration)
    setItems(list => {
      const without = list.filter(x => x.id !== id)
      const next = [...without, entry]
      // Overflow drops the OLDEST: the newest message is the relevant one.
      return next.length > max ? next.slice(next.length - max) : next
    })
    return id
  }, [max])

  useEffect(() => {
    if (items.length === 0) return
    const TICK = 100
    const h = setInterval(() => {
      if (paused.current) return
      const expired: string[] = []
      for (const [id, ms] of left.current) {
        const rest = ms - TICK
        if (rest <= 0) expired.push(id)
        else left.current.set(id, rest)
      }
      if (expired.length) {
        for (const id of expired) left.current.delete(id)
        setItems(list => list.filter(x => !expired.includes(x.id)))
      }
    }, TICK)
    return () => clearInterval(h)
  }, [items.length])

  const api = useMemo<ToastApi>(() => ({
    toast:   push,
    info:    (message, o) => push({ ...o, message, variant: 'info' }),
    success: (message, o) => push({ ...o, message, variant: 'success' }),
    warning: (message, o) => push({ ...o, message, variant: 'warning' }),
    error:   (message, o) => push({ ...o, message, variant: 'danger' }),
    dismiss,
    dismissAll,
  }), [push, dismiss, dismissAll])

  const polite    = items.filter(x => x.variant === 'info' || x.variant === 'success')
  const assertive = items.filter(x => x.variant === 'warning' || x.variant === 'danger')

  const stack = (
    <div
      className={cn(
        // Position comes from the inline style below (fixed at <body>, absolute
        // inside a bounded portal host); the classes only place the anchor.
        'pointer-events-none z-[9998] flex flex-col gap-2',
        isMobile
          ? 'inset-x-3 bottom-3 items-stretch'
          : PLACEMENT[placement],
      )}
      style={{
        position: host === document.body ? 'fixed' : 'absolute',
        paddingBottom: isMobile ? 'env(safe-area-inset-bottom)' : undefined,
        maxWidth: isMobile ? undefined : 'min(24rem, calc(100vw - 2rem))',
      }}
      onMouseEnter={() => { paused.current = true }}
      onMouseLeave={() => { paused.current = false }}
      onFocusCapture={() => { paused.current = true }}
      onBlurCapture={() => { paused.current = false }}
    >
      <div aria-live="polite" aria-relevant="additions" className="flex flex-col gap-2">
        {polite.map(item => <ToastCard key={item.id} item={item} onClose={() => dismiss(item.id)} closeLabel={tr('ui.close')} />)}
      </div>
      <div aria-live="assertive" aria-relevant="additions" className="flex flex-col gap-2">
        {assertive.map(item => <ToastCard key={item.id} item={item} onClose={() => dismiss(item.id)} closeLabel={tr('ui.close')} />)}
      </div>
    </div>
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {host && createPortal(stack, host)}
    </ToastContext.Provider>
  )
}

function ToastCard({ item, onClose, closeLabel }: {
  item: ToastEntry
  onClose: () => void
  closeLabel: string
}) {
  const { Glyph, icon } = SKIN[item.variant]
  return (
    <div
      role={item.variant === 'danger' || item.variant === 'warning' ? 'alert' : 'status'}
      className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface-0 px-3 py-2.5"
      style={{ boxShadow: 'var(--kb-shadow-float)', animation: 'kb-toast-in .18s ease-out' }}
    >
      <style>{`@keyframes kb-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
      <span className={cn('mt-px shrink-0', icon)} aria-hidden><Glyph size={16} /></span>
      <div className="min-w-0 flex-1" style={{ fontSize: 'var(--kb-text-body)' }}>
        {item.title != null && <p className="font-medium text-text-primary">{item.title}</p>}
        <div className={cn('text-text-secondary', item.title != null && 'mt-0.5')}>{item.message}</div>
        {item.action && (
          <button
            type="button"
            onClick={() => { item.action?.onClick(); onClose() }}
            className="mt-1.5 -ml-1.5 rounded-md px-1.5 py-0.5 text-primary transition-colors
                       hover:bg-primary-light focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-text-tertiary transition-colors
                   hover:bg-surface-2 hover:text-text-primary
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <X size={14} />
      </button>
    </div>
  )
}

/**
 * Access the toast API. Outside a `<ToastProvider>` it returns a no-op API and
 * warns in dev rather than throwing: a missing provider must never take down a
 * module that only wanted to say "Saved".
 */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  const fallback = useMemo<ToastApi>(() => {
    const noop = () => {
      if (import.meta.env?.DEV) console.warn('[useToast] no <ToastProvider> above this component - toast dropped.')
      return ''
    }
    return { toast: noop, info: noop, success: noop, warning: noop, error: noop, dismiss: () => {}, dismissAll: () => {} }
  }, [])
  return ctx ?? fallback
}
