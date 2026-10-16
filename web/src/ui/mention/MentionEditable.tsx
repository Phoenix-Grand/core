import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MentionsConfig } from './types'
import { useContentEditableMention } from './useContentEditableMention'
import { ensureMentionStyles } from './mentionChip'

export interface MentionEditableProps {
  /** Controlled HTML value (initialised once - see the note on semantics). */
  value: string
  onChange: (html: string) => void
  mentions: MentionsConfig
  placeholder?: string
  className?: string
  style?: CSSProperties
  disabled?: boolean
  id?: string
}

/**
 * A multi-line contenteditable that behaves like a textarea but can hold mention
 * chips (a native `<textarea>` cannot contain elements). Used by `Textarea` when
 * `mentions` is enabled. The emitted value is HTML (the chips are `<span>`s in
 * it) - a deliberate semantic shift from the plain-text value of a native
 * textarea, documented on the primitive.
 *
 * The value is applied to the DOM only once on mount (like `RichText`) so that
 * re-emitting HTML on each keystroke never resets the caret.
 */
export function MentionEditable({
  value, onChange, mentions, placeholder, className, style, disabled, id,
}: MentionEditableProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [empty, setEmpty] = useState(!value)

  useEffect(() => {
    ensureMentionStyles()
    if (ref.current) ref.current.innerHTML = value || ''
    setEmpty(!ref.current?.textContent?.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = () => {
    const html = ref.current?.innerHTML ?? ''
    const isEmpty = !ref.current?.textContent?.trim()
    setEmpty(isEmpty)
    onChange(isEmpty ? '' : html)
  }

  const m = useContentEditableMention(ref, mentions, emit)

  return (
    <div className="relative">
      <div
        ref={ref}
        id={id}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={() => { emit(); m.onInput() }}
        onKeyUp={m.onKeyUp}
        onKeyDown={m.onKeyDown}
        className={className}
        style={{ whiteSpace: 'pre-wrap', ...style }}
      />
      {empty && placeholder && (
        <div className="absolute top-2 left-3 text-sm text-text-tertiary pointer-events-none select-none">
          {placeholder}
        </div>
      )}
      {m.overlay}
    </div>
  )
}
