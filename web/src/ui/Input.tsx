import { cn } from './cn'
import React from 'react'
import type { MentionsConfig } from './mention/types'
import { MentionInput, type MentionModel } from './mention/MentionInput'
import { labelWithMark } from './RequiredMark'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode
  error?: string
  hint?: string
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
  /**
   * Opt-in @mention support. ABSENT (or `enabled` falsy) → a plain native
   * `<input>`, 100 % unchanged. When enabled the field becomes a chips-field:
   * picked mentions render as removable chips beside the input and the value is
   * exposed via `onMentionsChange` as a `{ text, mentions }` model (the native
   * `value`/`onChange` no longer describe the full field).
   */
  /**
   * No chrome: no frame, no background, the focus stroke under the text.
   *
   * For a TITLE line - of a document, of an event - which is not a form field
   * and must not look like one. The variant lives here rather than as a bare
   * `<input>` copied into every screen: that is the only way it stays the same
   * everywhere, and the only way the rule "always the primitive" avoids an
   * exception that would end up being extended.
   */
  bare?: boolean

  mentions?: MentionsConfig
  /** Called with the `{ text, mentions }` model when `mentions` is enabled. */
  onMentionsChange?: (model: MentionModel) => void
  /** Initial `{ text, mentions }` model when `mentions` is enabled. */
  defaultMentionValue?: MentionModel
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input({
  label,
  error,
  hint,
  leftIcon,
  rightIcon,
  className,
  id,
  required,
  bare = false,
  mentions,
  onMentionsChange,
  defaultMentionValue,
  ...props
}: InputProps, ref) {
  const inputId = id ?? (typeof label === 'string' ? label.toLowerCase().replace(/\s+/g, '-') : undefined)
  // Mention variant: a chips-field replaces the native input. Everything else
  // (label / error / hint chrome) stays identical.
  if (mentions?.enabled) {
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
            {labelWithMark(label, required)}
          </label>
        )}
        <MentionInput
          mentions={mentions}
          placeholder={props.placeholder}
          disabled={props.disabled}
          className={cn(cn(error && 'border-danger kb-field-focus-danger', className))}
          defaultValue={defaultMentionValue}
          onMentionsChange={onMentionsChange}
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        {hint && !error && <p className="text-xs text-text-secondary">{hint}</p>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
          {labelWithMark(label, required)}
        </label>
      )}
      <div className="relative flex items-center">
        {leftIcon && (
          <span className="absolute left-3 text-text-secondary pointer-events-none">{leftIcon}</span>
        )}
        <input
          ref={ref}
          id={inputId}
          // `aria-required`, NOT the native attribute: the native one summons the
          // browser's own validation bubble, which this project replaces with its
          // own messages. The asterisk speaks to the eye, this to a screen reader.
          aria-required={required || undefined}
          className={cn(cn(
            'w-full text-text-primary placeholder:text-text-tertiary',
            bare
              // One stroke, under the text, and nothing else - least of all the
              // browser's own ring on top of it. Three pixels, the thickness the
              // focus stroke has on every other field: a title is not the place
              // to make the mark harder to see. The transparent border is there
              // at rest too, so taking focus never nudges the text.
              ? 'bg-transparent border-0 border-b-[3px] border-transparent rounded-none px-0 py-1 outline-none focus:border-primary'
              : 'rounded-md border bg-white text-sm px-3 py-2 h-9 kb-field-focus',
            'disabled:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60',
            bare ? '' : error ? 'border-danger kb-field-focus-danger' : 'border-border',
            leftIcon && 'pl-9',
            rightIcon && 'pr-9',
            className,
          ))}
          {...props}
        />
        {rightIcon && (
          <span className="absolute right-3 text-text-secondary pointer-events-none">{rightIcon}</span>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {hint && !error && <p className="text-xs text-text-secondary">{hint}</p>}
    </div>
  )
})
