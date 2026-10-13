/**
 * Code-behind of `FloorsField.kbcontrol` (converted from `FloorsField.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"

import { ViewBase } from './FloorsField.kbcontrol'
import * as __parts from './FloorsField.parts'

export type FloorsFieldProps = {
  floors:     string[]
  onChange:   (next: string[]) => void
  /** Column width of a floor name, served by the API alongside the list. */
  maxLength:  number
  /** How many floors a building may hold at all, served by the API. */
  maxFloors:  number
  disabled?:  boolean
}

export class FloorsField extends ViewBase {
  tr!: FloorsFieldStores['t']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (./FieldLabel#default)). */
  get Part1() {
    return __parts.Part1
  }

  get enabled_unless_disabled() {
    return !(this.props.disabled)
  }

  /** The rows of the Repeater over `floors`. */
  get rows_floors() {
    return this.memo('rows_floors', [this.props], () => this.props.floors.map((floor, index) => {
      return { floor, index, res_floor_rank_rank: index + 1, enabled_unless_disabled_index: !(this.props.disabled || index === 0), enabled_unless_disabled_index_floors: !(this.props.disabled || index === this.props.floors.length - 1), key: index }
    }))
  }

  get enabled_unless_disabled_floors_max_floors() {
    return !(this.props.disabled || this.props.floors.length >= this.props.maxFloors)
  }

  set(index: number, value: string) {
    return this.props.onChange(this.props.floors.map((f, i) => (i === index ? value : f)))
  }

  move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= this.props.floors.length) return
    const next = [...this.props.floors]
    const [row] = next.splice(index, 1)
    next.splice(target, 0, row)
    this.props.onChange(next)
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    const { index } = args.row as RowOf_rows_floors
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.set(index, e.target.value)
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { index } = args.row as RowOf_rows_floors
    this.move(index, -1)
  }

  panel_click2(_sender: unknown, args: MouseEventArgs) {
    const { index } = args.row as RowOf_rows_floors
    this.move(index, 1)
  }

  panel_click3(_sender: unknown, args: MouseEventArgs) {
    const { index } = args.row as RowOf_rows_floors
    this.props.onChange(this.props.floors.filter((_, i) => i !== index))
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    this.props.onChange([...this.props.floors, ''])
  }

}

type RowOf_rows_floors = FloorsField['rows_floors'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type FloorsFieldStores = ReturnType<FloorsField['useStores']>

export default FloorsField.component()
