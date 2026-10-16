/**
 * The asterisk that says "this one is not optional".
 *
 * Project rule: a required field carries a mark on its label. One component so
 * the mark is the same glyph, the same colour and the same spacing on every
 * field - a rule written once is a rule that survives; a rule recopied into
 * forty forms drifts by the tenth.
 *
 * `aria-hidden`: the asterisk is decoration for the eye. Assistive technology is
 * told through `aria-required` on the field itself, which is what it actually
 * announces - a screen reader spelling out "star" helps nobody.
 */
export function RequiredMark() {
  return <span aria-hidden className="ml-0.5 text-danger">*</span>
}

/** A label with its mark, for the primitives that render one. */
export function labelWithMark(label: React.ReactNode, required?: boolean) {
  return required ? <>{label}<RequiredMark /></> : label
}
