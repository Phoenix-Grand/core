import { cn } from './cn'
import React from 'react'
import { ChevronDown } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AccordionItemDef {
  id:      string
  title:   React.ReactNode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?:   React.ComponentType<any>
  badge?:  number | string
  content: React.ReactNode
  /** Disable toggling for this item (renders muted, stays collapsed). */
  disabled?: boolean
}

export interface AccordionProps {
  items:        AccordionItemDef[]
  /** Ids expanded initially (uncontrolled). Default `[]` → everything collapsed. */
  defaultOpen?: string[]
  /** Controlled expanded ids. When set, `onOpenChange` drives the state. */
  open?:        string[]
  onOpenChange?: (open: string[]) => void
  /** Only one item open at a time (classic accordion). Default `false`. */
  single?:      boolean
  className?:   string
  /** 'sm' → tighter header padding | 'md' (default). */
  size?:        'sm' | 'md'
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Accordion - a stack of collapsible groups. Each item has a clickable header
 * (title + chevron) and a panel that expands/collapses with a height animation.
 * Uncontrolled by default (start collapsed via `defaultOpen`); pass `open` +
 * `onOpenChange` to control it. Panels stay mounted so their inner state and any
 * overlays keep working across toggles.
 */
export function Accordion({
  items,
  defaultOpen = [],
  open,
  onOpenChange,
  single = false,
  className,
  size = 'md',
}: AccordionProps) {
  const isControlled = open !== undefined
  const [internal, setInternal] = React.useState<string[]>(defaultOpen)
  const openIds = isControlled ? (open as string[]) : internal

  const compute = (curr: string[], id: string) => {
    const has = curr.includes(id)
    if (single) return has ? [] : [id]
    return has ? curr.filter((x) => x !== id) : [...curr, id]
  }

  const toggle = (id: string) => {
    if (isControlled) {
      onOpenChange?.(compute(open as string[], id))
    } else {
      // Functional update so several toggles in the same tick compose correctly
      // (no stale closure); notify with the closure value (side-effect kept out
      // of the updater to stay StrictMode-safe).
      setInternal((prev) => compute(prev, id))
      onOpenChange?.(compute(openIds, id))
    }
  }

  const headerPad = size === 'sm' ? 'px-3 py-2' : 'px-4 py-3'

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {items.map((item) => {
        const isOpen = openIds.includes(item.id)
        const Icon = item.icon
        return (
          <div
            key={item.id}
            className="rounded-xl border border-border bg-surface-0 overflow-hidden"
          >
            <button
              type="button"
              disabled={item.disabled}
              aria-expanded={isOpen}
              onClick={() => !item.disabled && toggle(item.id)}
              className={cn(
                'flex w-full items-center gap-3 text-left transition-colors',
                headerPad,
                item.disabled
                  ? 'cursor-not-allowed opacity-50'
                  : 'hover:bg-surface-2',
              )}
            >
              {Icon && <Icon size={16} className="shrink-0 text-text-secondary" />}
              <span className="flex-1 min-w-0 text-xs font-semibold uppercase tracking-wide text-text-secondary truncate">
                {item.title}
              </span>
              {item.badge !== undefined && (
                <span className="rounded-full bg-surface-3 text-text-secondary text-[11px] font-medium min-w-[18px] h-[18px] flex items-center justify-center px-1">
                  {item.badge}
                </span>
              )}
              <ChevronDown
                size={16}
                className={cn(
                  'shrink-0 text-text-tertiary transition-transform duration-200',
                  isOpen && 'rotate-180',
                )}
              />
            </button>
            {/* Height animation via grid-template-rows 0fr↔1fr; content stays
                mounted (clipped when collapsed). */}
            <div
              className="grid transition-[grid-template-rows] duration-200 ease-out"
              style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
            >
              <div className="overflow-hidden">
                <div className={cn(size === 'sm' ? 'px-3 pb-3' : 'px-4 pb-4', 'pt-1 border-t border-border')}>
                  {item.content}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
