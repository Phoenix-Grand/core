/**
 * The parts of `FloorsField.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import FieldLabel from "./FieldLabel"
import { RequiredMark } from "@ui/RequiredMark"
import type { FloorsField } from './FloorsField'

export function Part1({ t }: { t: NonNullable<FloorsField['tr']> }) {
  return (
    <FieldLabel>{t('admin.res_floors')}<RequiredMark /></FieldLabel>
  )
}
