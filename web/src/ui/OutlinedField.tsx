// Material-Design "outlined" text field, shared @ui primitive (every module
// has forms). The label starts
// inside the box (in the placeholder's place) and, on focus or once the field
// holds a value, ANIMATES up onto the top border - the border opening a notch
// around it (the real fieldset/legend technique, so it works on any background,
// not a white chip masking the line). Focus paints the border and label in the
// form's primary colour. An optional leading icon sits outside the box, like
// Google's e-mail field.
import { useEffect, useId, useState, type ReactNode } from 'react'

export interface OutlinedFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  /** Leading icon, rendered OUTSIDE the box on its left (optional). */
  icon?: ReactNode
  /** HTML input type (text/email/url/tel/number). */
  type?: string
  /** Shown only while floated (focused), like Material - the label IS the resting hint. */
  placeholder?: string
  primaryColor: string
  /** Adds a red asterisk to the floating label (compact mode, where the title lives in the field). */
  required?: boolean
  autoFocus?: boolean
  /** Multi-line variant (paragraph answers). */
  multiline?: boolean
  /** Bigger type for the one-question-per-screen layout. */
  large?: boolean
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url'
  /** Read-only display (used when the field acts as a select trigger). */
  readOnly?: boolean
  /** Trailing affordance inside the box, right-aligned (e.g. a chevron). */
  trailing?: ReactNode
  /** HTML autocomplete hint, so password managers and the browser's own
   *  autofill recognise the field (`username`, `current-password`, `email`…). */
  autoComplete?: string
}

/* ── Browser autofill detection ──────────────────────────────────────────────
 * Chrome PREVIEWS a suggestion into the field while the pointer merely hovers
 * it: the text is painted, but no `input` event fires and React's `value` stays
 * empty. A label driven by `value` alone would still be resting INSIDE the box,
 * and the previewed text would render straight through it.
 *
 * There is no event for that state, but the field does match `:-webkit-autofill` -
 * so we hang a zero-length animation on that selector and listen for
 * `animationstart`, the long-standing way to observe autofill from script.
 * `autocomplete="off"` is not an option: Chrome ignores it on name/e-mail/tel
 * fields, and switching autofill off would be a regression for the user. */
const AUTOFILL_STYLE_ID = 'kb-autofill-detect'
const AF_ON  = 'kb-autofill-on'
const AF_OFF = 'kb-autofill-off'

function ensureAutofillStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(AUTOFILL_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = AUTOFILL_STYLE_ID
  style.textContent = `
@keyframes ${AF_ON}{from{}to{}}
@keyframes ${AF_OFF}{from{}to{}}
.kb-of-input:-webkit-autofill{animation-name:${AF_ON};animation-duration:1ms;}
.kb-of-input:not(:-webkit-autofill){animation-name:${AF_OFF};animation-duration:1ms;}
`
  document.head.appendChild(style)
}

// Resting → floated is driven by focus OR a non-empty value: a filled field
// keeps its label up even unfocused (capture 3).
/** Is the document read right-to-left?
 *
 *  Read at render time rather than kept in state: the language switch re-renders
 *  the tree that owns this field, so the value is always the current one. */
function useIsRtl(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dir === 'rtl'
}

export function OutlinedField({
  label, value, onChange, icon, type = 'text', placeholder,
  primaryColor, required, autoFocus, multiline, large, inputMode, readOnly, trailing,
  autoComplete,
}: OutlinedFieldProps) {
  const [focused, setFocused] = useState(false)
  const [autofilled, setAutofilled] = useState(false)
  const id = useId()
  useEffect(ensureAutofillStyles, [])
  // A previewed or applied autofill counts as content: float the label so the
  // browser's text never collides with it.
  const floated = focused || value.length > 0 || autofilled

  const onAnim = (e: { animationName: string }) => {
    if (e.animationName === AF_ON) setAutofilled(true)
    else if (e.animationName === AF_OFF) setAutofilled(false)
  }

  // Metrics: one place, so the input padding, the resting label and the notch
  // legend stay in agreement. `pad` is the box's left padding - the resting
  // label sits exactly on the text it replaces.
  const fontSize = large ? 20 : 14
  const rtl = useIsRtl()
  const padX = 12
  const padY = large ? 14 : 11
  // Deterministic outer height so every field (and the selector boxes built on
  // it) is the SAME height - no 6px notch overflow that made a plain box look
  // shorter. Single-line only; the textarea keeps its intrinsic height.
  const FIELD_H = large ? 56 : 48
  // Single-line: SYMMETRIC vertical padding around a known line box so the text
  // is truly centred (a fixed height + padding:0 let the browser sit the text
  // low). height = linePx + 2*padV = FIELD_H.
  // The LABEL reuses the very same line box: at 1.35em it is tall enough to hold
  // the descenders (p, g, q), which a lineHeight of 1 cropped against the
  // `overflow: hidden` that the ellipsis needs.
  const linePx = Math.round(fontSize * 1.35)
  const padV = (FIELD_H - linePx) / 2
  // Optical correction, measured on the platform font (Outfit): with
  // the line box mathematically centred, the DIGIT glyphs sit 1px high (large
  // font ascent, no descender on digits: glyph gaps measured 17px above vs
  // 19px below). Tilting the padding by 1px centres the visible glyph band.
  const OPTICAL = 1

  // Colours per state, read off the captures: primary on focus, dark grey once
  // filled, medium grey at rest.
  // Through the theme tokens, not fixed hex: the same field has to stay legible
  // when a dark theme repaints the page around it. The historic values remain as
  // fallbacks for a module rendering outside the shell.
  const borderColor = focused
    ? primaryColor
    : floated ? 'var(--color-border-strong, #3c4043)' : 'var(--color-text-tertiary, #9aa0a6)'
  const labelColor  = focused ? primaryColor : 'var(--color-text-secondary, #5f6368)'

  // The floated label must read at exactly 12px whatever the resting size, so
  // the scale is derived from the base font (12/fontSize) rather than a fixed
  // 0.75. The legend reserves that same 12px width so the notch hugs the text.
  const FLOAT_SCALE = 12 / fontSize

  // The border pushes the fieldset's content (the legend) inward, and it varies
  // (1px → 3px on focus). Compensating the left padding keeps the legend's
  // content edge at a constant 7px (border + (7 - border)), so the reserved
  // label text always sits at padX and the notch's white gap is a symmetric 5px
  // on both sides of the label, whatever the border width.
  const borderW = focused ? 3 : 1
  const fieldsetStyle: React.CSSProperties = {
    position: 'absolute',
    inset: '-6px 0 0 0',
    margin: 0,
    padding: `0 ${7 - borderW}px`,
    borderRadius: 6,
    border: `${borderW}px solid ${borderColor}`,
    pointerEvents: 'none',
    transition: 'border-color 150ms, border-width 0ms',
    minWidth: 0,
  }
  const legendStyle: React.CSSProperties = {
    padding: 0,
    height: 12,
    fontSize: fontSize * FLOAT_SCALE,
    lineHeight: '12px',
    // The notch opens/closes with a width tween, Material's signature motion.
    maxWidth: floated ? '100%' : 0.01,
    transition: 'max-width 150ms cubic-bezier(0.4, 0, 0.2, 1)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    visibility: 'hidden', // reserves width only; the visible label floats above
  }
  // Growing the line box adds half-leading above and below, which would push the
  // glyphs down. Every offset below is lifted by that amount so the label lands
  // exactly where it used to - only the crop is gone.
  const HALF_LEAD = (linePx - fontSize) / 2
  const labelStyle: React.CSSProperties = {
    position: 'absolute',
    // Logical, not physical: under `dir="rtl"` the notch (a real <legend>)
    // follows the writing direction to the right, and a label pinned to `left`
    // ended up over the border on the wrong side.
    insetInlineStart: padX,
    top: 0,
    color: labelColor,
    fontSize,
    lineHeight: `${linePx}px`,
    pointerEvents: 'none',
    transformOrigin: rtl ? 'top right' : 'top left',
    // At rest a single-line label takes the input's OWN text offset, so it sits
    // on the very text it stands in for (it used to ride 1px above it).
    transform: floated
      ? `translateY(${(multiline ? -(large ? 8 : 7) : -6) - HALF_LEAD * FLOAT_SCALE}px) scale(${FLOAT_SCALE})`
      : `translateY(${multiline ? padY + (large ? 8 : 6) - HALF_LEAD : padV + OPTICAL}px)`,
    transition: 'transform 150ms cubic-bezier(0.4, 0, 0.2, 1), color 150ms',
    whiteSpace: 'nowrap',
    maxWidth: `calc(100% - ${padX * 2}px)`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }
  const commonInput: React.CSSProperties = {
    width: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    fontSize,
    color: 'var(--color-text-primary, #202124)',
    fontFamily: 'inherit',
    cursor: readOnly ? 'pointer' : 'text',
  }
  const inputStyle: React.CSSProperties = {
    ...commonInput,
    boxSizing: 'border-box',
    lineHeight: `${linePx}px`,
    paddingBlock: `${padV + OPTICAL}px ${padV - OPTICAL}px`,
    paddingInlineStart: padX,
    paddingInlineEnd: trailing ? 34 : padX,
  }
  // Multiline keeps its intrinsic, padded height.
  const textareaStyle: React.CSSProperties = {
    ...commonInput,
    padding: `${padY + 4}px ${padX}px`,
    resize: 'vertical',
    minHeight: large ? 96 : 76,
  }

  const control = multiline ? (
    <textarea
      id={id}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      value={value}
      rows={large ? 3 : 3}
      onChange={e => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={focused ? placeholder : undefined}
      style={textareaStyle}
    />
  ) : (
    <input
      id={id}
      className="kb-of-input"
      onAnimationStart={onAnim}
      type={type}
      inputMode={inputMode}
      readOnly={readOnly}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      value={value}
      onChange={e => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={focused ? placeholder : undefined}
      style={inputStyle}
    />
  )

  return (
    <div style={{ display: 'flex', alignItems: multiline ? 'flex-start' : 'center', gap: 12 }}>
      {icon && (
        <span style={{ color: 'var(--color-text-secondary, #5f6368)', flexShrink: 0, marginTop: multiline ? padY + 4 : 0, display: 'flex' }}>
          {icon}
        </span>
      )}
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>
            <span style={{ display: 'inline-block', padding: '0 5px' }}>{label}{required ? ' *' : ''}</span>
          </legend>
        </fieldset>
        <label htmlFor={id} style={labelStyle}>{label}{required && <span style={{ color: 'var(--color-danger, #d93025)' }}> *</span>}</label>
        {control}
        {trailing && (
          <span style={{ position: 'absolute', insetInlineEnd: 10, top: '50%', transform: 'translateY(-50%)', display: 'flex', pointerEvents: 'none', color: 'var(--color-text-secondary, #5f6368)' }}>{trailing}</span>
        )}
      </div>
    </div>
  )
}
