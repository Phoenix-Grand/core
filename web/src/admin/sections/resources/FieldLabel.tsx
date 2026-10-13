import type { ReactNode } from 'react'

/**
 * The label of a field that is not an `<Input>`.
 *
 * `Input`, `Textarea` and `NumberInput` paint their own label from a `label`
 * prop; a `Dropdown`, a checkbox group or a read-only value has no such prop, so
 * its caption is written by hand. Written freely, those captions come out in a
 * different weight from their neighbours, and one form ends up with two kinds of
 * label stacked on top of each other — which reads as an accident, because it is.
 *
 * This mirrors the `@ui` field label exactly (`text-sm font-medium
 * text-text-primary`). If that ever changes, this is the one place to follow it.
 */
export default function FieldLabel({
  children, htmlFor,
}: {
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-text-primary">
      {children}
    </label>
  )
}
