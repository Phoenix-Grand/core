/**
 * The parts of `PrimitivesGroup.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { DatePicker, Input } from "@ui"
import { Search } from "lucide-react"
import type { PrimitivesGroup } from './PrimitivesGroup'

export function Part1() {
  return (
    <Input placeholder="Champ texte" leftIcon={<Search size={15} />} />
  )
}

export function Part2({ dt, setDt, t }: { dt: PrimitivesGroup['dt']; setDt: NonNullable<PrimitivesGroup['setDt']>; t: NonNullable<PrimitivesGroup['tr']> }) {
  return (
    <DatePicker mode="datetime" value={dt} onChange={setDt} placeholder={t('admin.t_prev_pick_dt', { defaultValue: 'Choisir…' })} />
  )
}
