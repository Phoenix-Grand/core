import React, { useState } from 'react'

import { cn } from './cn'
import { Input } from './Input'

/**
 * One position of a mask (WinForms `MaskedTextBox` characters): `0` a digit, `9` an optional digit, `L` a letter,
 * `?` an optional letter, `A` a letter or digit, `a` an optional one, `&` / `C` any character (required / optional);
 * anything else - or a character after `\` - is a literal written by the field itself.
 */
export type MaskSlot =
  | { readonly kind: 'literal'; readonly char: string }
  | { readonly kind: 'input'; readonly accepts: (c: string) => boolean; readonly required: boolean }

const DIGIT = (c: string) => /^\d$/.test(c)
const LETTER = (c: string) => /^\p{L}$/u.test(c)
const ALNUM = (c: string) => DIGIT(c) || LETTER(c)
const ANY = (c: string) => c.length === 1 && c !== ' '

/** The slots of a mask. */
export function parseMask(mask: string): MaskSlot[] {
  const out: MaskSlot[] = []
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i]
    if (c === '\\' && i + 1 < mask.length) { out.push({ kind: 'literal', char: mask[++i] }); continue }
    switch (c) {
      case '0': out.push({ kind: 'input', accepts: DIGIT, required: true }); break
      case '9': out.push({ kind: 'input', accepts: DIGIT, required: false }); break
      case 'L': out.push({ kind: 'input', accepts: LETTER, required: true }); break
      case '?': out.push({ kind: 'input', accepts: LETTER, required: false }); break
      case 'A': out.push({ kind: 'input', accepts: ALNUM, required: true }); break
      case 'a': out.push({ kind: 'input', accepts: ALNUM, required: false }); break
      case '&': out.push({ kind: 'input', accepts: ANY, required: true }); break
      case 'C': out.push({ kind: 'input', accepts: ANY, required: false }); break
      default: out.push({ kind: 'literal', char: c })
    }
  }
  return out
}

/**
 * Formats typed text through a mask, position by position: a literal takes the next typed character when it is the
 * same one (the text already formatted), an input position takes the next character it accepts (the others are
 * dropped); literals are written as soon as the next input position is filled. Returns the formatted text and
 * whether every required position is filled.
 */
export function applyMask(mask: string, typed: string): { text: string; complete: boolean } {
  const slots = parseMask(mask)
  const chars = [...typed]
  let text = ''
  let pending = ''
  let k = 0
  let complete = true
  for (const s of slots) {
    if (s.kind === 'literal') {
      if (chars[k] === s.char) k++
      pending += s.char
      continue
    }
    while (k < chars.length && !s.accepts(chars[k])) k++
    if (k >= chars.length) { if (s.required) complete = false; continue }
    text += pending + chars[k++]
    pending = ''
  }
  return { text, complete }
}

/** The hint shown while the field is empty: `_` for every input position, the literals as they are. */
export function maskPlaceholder(mask: string): string {
  return parseMask(mask).map((s) => (s.kind === 'literal' ? s.char : '_')).join('')
}

export interface MaskedFieldProps {
  mask?: string
  /** The formatted text (controlled when given, followed through `onChange`). */
  value?: string
  onChange?: (text: string) => void
  /** Shows the field in the error colour. */
  invalid?: boolean
  placeholder?: string
  disabled?: boolean
  readOnly?: boolean
  className?: string
  style?: React.CSSProperties
  'aria-label'?: string
}

/**
 * A text field that takes its input through a mask (the `.kbview` `MaskedField`): `00/00/0000` for a date,
 * `+33 0 00 00 00 00` for a phone number. Characters a position does not accept are dropped, literals are written
 * for the user. The `@ui` `Input` look; `aria-invalid` with `Invalid`, or while a required position is empty after
 * the field was left.
 */
export const MaskedField = React.forwardRef<HTMLInputElement, MaskedFieldProps>(function MaskedField(
  { mask = '', value, onChange, invalid, placeholder, disabled, readOnly, className, style, ...aria },
  ref,
) {
  const [own, setOwn] = useState('')
  const [left, setLeft] = useState(false)
  const text = value ?? own
  const { complete } = applyMask(mask, text)
  const bad = invalid || (left && text !== '' && !complete)
  return (
    <div className={cn('min-w-0', className)} style={style}>
      <Input
        ref={ref}
        value={text}
        disabled={disabled}
        readOnly={readOnly}
        inputMode={/^[09\\\s\W]*$/.test(mask) && /[09]/.test(mask) ? 'numeric' : undefined}
        placeholder={placeholder || maskPlaceholder(mask)}
        aria-label={aria['aria-label']}
        aria-invalid={bad || undefined}
        onBlur={() => setLeft(true)}
        onChange={(e) => {
          const next = mask ? applyMask(mask, e.target.value).text : e.target.value
          if (value === undefined) setOwn(next)
          onChange?.(next)
        }}
        // Masked values (dates, numbers, codes) read left to right in every language; aligned at the line's end in RTL.
        dir="ltr"
        className={cn('tabular-nums rtl:text-right', bad && 'border-danger kb-field-focus-danger')}
      />
    </div>
  )
})

MaskedField.displayName = 'MaskedField'
