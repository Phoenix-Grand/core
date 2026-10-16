import React from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'text' | 'textDanger'
type ButtonSize    = 'sm' | 'md' | 'lg'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:  ButtonVariant
  size?:     ButtonSize
  /** Leading icon - rendered before children */
  icon?:     React.ReactNode
  loading?:  boolean
  children?: React.ReactNode
}

// rounded-md is FIXED - border radius is never overridable
const BASE = [
  'inline-flex items-center justify-center select-none',
  'transition-colors rounded-md',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1',
  'disabled:opacity-50 disabled:cursor-not-allowed',
].join(' ')

// Buttons are never bold: colour and fill carry the hierarchy, weight does not.
const VARIANT: Record<ButtonVariant, string> = {
  primary:   'bg-primary text-white hover:bg-primary-hover active:bg-primary-hover',
  // `border-strong` rather than the plain border token: a button is an actionable
  // target and needs a firmer outline than the hairlines that merely separate
  // cards, rows and fields. Reuses the existing step of the scale instead of
  // introducing a fourth grey.
  secondary: 'bg-white border border-border-strong text-text-primary hover:bg-surface-1 active:bg-surface-2',
  ghost:     'bg-transparent text-text-secondary hover:bg-surface-2 active:bg-surface-3',
  // The accent, without a fill: what a dialog's confirming action looks like in
  // a footer where the cancel is `ghost`. Distinct from `primary` (filled), which
  // stays for the actions that carry a page.
  text:      'bg-transparent text-primary hover:bg-primary-light active:bg-primary-light',
  // Its own variant rather than `text` plus a colour class: two utilities on one
  // element are settled by the STYLESHEET's order, not the attribute's, so the
  // override silently lost and a destructive action came out accent-blue.
  textDanger: 'bg-transparent text-danger hover:bg-danger-light active:bg-danger-light',
  danger:    'bg-danger text-white hover:opacity-90 active:opacity-80',
}

// md = h-9 matches "Nouvel utilisateur" default height
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
}

/* forwardRef: a caller needs the DOM node to anchor a popover or a tooltip on the
 * button. Without it the ref lands on nothing and the anchor has to be a wrapper
 * <span>, which changes the layout for a purely technical reason. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant  = 'primary',
  size     = 'md',
  icon,
  loading  = false,
  className,
  disabled,
  children,
  type     = 'button',
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={[BASE, VARIANT[variant], SIZE[size], className].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  )
})

Button.displayName = 'Button'
