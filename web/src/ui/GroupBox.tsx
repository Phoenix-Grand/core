import React, { useId } from 'react'

import { cn } from './cn'

export interface GroupBoxProps {
  /** The group's heading. */
  title?: React.ReactNode
  /** A help line under the heading. */
  description?: React.ReactNode
  /** Space around the content, in pixels (all four sides). */
  padding?: number
  children?: React.ReactNode
  className?: string
  style?: React.CSSProperties
}

/**
 * A titled group of controls (the `.kbview` `GroupBox`): a heading, an optional help line, then the content -
 * the shared version of the `Section` the modules' settings pages each defined (`text-lg` heading, `text-xs`
 * description, `pb-10` after the group). The heading names the group for screen readers.
 */
export const GroupBox = React.forwardRef<HTMLElement, GroupBoxProps>(function GroupBox(
  { title, description, padding, children, className, style },
  ref,
) {
  const id = useId()
  return (
    <section
      ref={ref}
      role="group"
      aria-labelledby={title ? id : undefined}
      className={cn('pb-10', className)}
      style={padding ? { padding: `${padding}px`, ...style } : style}
    >
      {title && <h2 id={id} className="text-lg text-text-primary mb-1">{title}</h2>}
      {description && <p className="text-xs text-text-tertiary mb-4 leading-relaxed max-w-2xl">{description}</p>}
      <div className={description ? undefined : 'mt-4'}>{children}</div>
    </section>
  )
})

GroupBox.displayName = 'GroupBox'
