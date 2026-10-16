import { cn } from './cn'
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

export interface EditableProps {
  /** Initial text, seeded once so the caret never jumps (the box is uncontrolled). */
  defaultValue?: string
  placeholder?: string
  disabled?: boolean
  /** Spell-check the content. Off by default (this is usually preview/sample text). */
  spellCheck?: boolean
  /** Emits the plain text on every edit. */
  onTextChange?: (text: string) => void
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
}

/**
 * Editable - primitive `div[contenteditable]` text box. Shares the exact border
 * and focus ring of the `<Input>` primitive. Uncontrolled: seed via `defaultValue`
 * (so the caret is stable across renders) and read edits through `onTextChange`.
 * For formatted/rich text with a toolbar use `<RichText>` instead.
 *
 * The placeholder is rendered via the CSS `:empty::before` trick, so it respects
 * whatever padding the caller sets (unlike an absolutely-positioned overlay).
 */
export const Editable = forwardRef<HTMLDivElement, EditableProps>(function Editable({
  defaultValue = '',
  placeholder,
  disabled,
  spellCheck = false,
  onTextChange,
  className,
  style,
  ...rest
}, ref) {
  const innerRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => innerRef.current as HTMLDivElement, [])

  // Seed the initial text once (never on updates → caret stays put).
  useEffect(() => {
    if (innerRef.current && !innerRef.current.textContent) innerRef.current.textContent = defaultValue
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={innerRef}
      contentEditable={!disabled}
      suppressContentEditableWarning
      spellCheck={spellCheck}
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder}
      onInput={() => onTextChange?.(innerRef.current?.textContent ?? '')}
      style={style}
      className={cn(cn(
        // Same surface + border + focus ring as <Input>.
        'w-full rounded-md border border-border bg-white text-sm text-text-primary px-3 py-2',
        'kb-field-focus',
        'empty:before:content-[attr(data-placeholder)] empty:before:text-text-tertiary empty:before:pointer-events-none',
        disabled && 'bg-surface-2 cursor-not-allowed opacity-60',
        className,
      ))}
      {...rest}
    />
  )
})
