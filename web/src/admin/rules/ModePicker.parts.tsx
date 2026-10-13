/**
 * The parts of `ModePicker.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { ModePicker } from './ModePicker'

export function Part1({ Glyph }: { Glyph: NonNullable<ModePicker['rows_offered']>[number]['Glyph'] }) {
  return (
    <Glyph size={15} className="shrink-0 text-text-secondary" aria-hidden />
  )
}
