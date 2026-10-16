import React, { useId } from 'react'

import { cn } from './cn'
import { useIsMobile } from './interaction'

export interface SettingsRowProps {
  /** The setting's name, in the label column. */
  label?: React.ReactNode
  /** A help line under the name. */
  description?: React.ReactNode
  /** The control(s) that change the setting. */
  children?: React.ReactNode
  /**
   * `auto` (default): the name in a 240 px column beside the control, stacked above a full-width control on a
   * phone (≤ 640 px); `inline` / `stacked` force one of the two.
   */
  layout?: 'auto' | 'inline' | 'stacked'
  /** Draws the separator line under the row (default `true`; the last row of a list draws none). */
  divider?: boolean
  className?: string
  style?: React.CSSProperties
}

/**
 * One line of a settings page (the `.kbview` `SettingsRow`): the setting's name and its help line, and the
 * control that changes it - the single shared version of the row every module's settings page copied
 * (`flex items-start gap-8 py-4`, a 240 px label column, a line between rows). The name labels the row for
 * screen readers (`role="group"`).
 */
export const SettingsRow = React.forwardRef<HTMLDivElement, SettingsRowProps>(function SettingsRow(
  { label, description, children, layout = 'auto', divider = true, className, style },
  ref,
) {
  const mobile = useIsMobile()
  const stacked = layout === 'stacked' || (layout === 'auto' && mobile)
  const id = useId()
  const line = divider ? 'border-b border-surface-3 last:border-0' : undefined
  const desc = description ? <p className="text-xs text-text-tertiary mt-0.5 leading-relaxed">{description}</p> : null
  if (stacked) {
    return (
      <div ref={ref} role="group" aria-labelledby={label ? id : undefined} className={cn('py-4', line, className)} style={style}>
        {label && <p id={id} className="text-[15px] text-text-primary">{label}</p>}
        {desc}
        <div className="mt-3">{children}</div>
      </div>
    )
  }
  return (
    <div ref={ref} role="group" aria-labelledby={label ? id : undefined} className={cn('flex items-start gap-8 py-4', line, className)} style={style}>
      <div className="w-60 flex-shrink-0">
        {label && <p id={id} className="text-sm text-text-primary font-normal">{label}</p>}
        {desc}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
})

SettingsRow.displayName = 'SettingsRow'
