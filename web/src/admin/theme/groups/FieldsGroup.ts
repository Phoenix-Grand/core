/**
 * Code-behind of `FieldsGroup.kbcontrol` (converted from `FieldsGroup.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { FloatCheckbox, FontPicker, type Gradient, type PickerTheme } from "@ui"

import { ViewBase } from './FieldsGroup.kbcontrol'
import * as __parts from './FieldsGroup.parts'

export type FieldsGroupProps = {
  pickerTheme: PickerTheme
  grad:        Gradient
  setGrad:     (g: Gradient) => void
}

export class FieldsGroup extends ViewBase {
  @bind accessor num = 3
  @bind accessor txt = 'Notes…'
  @bind accessor font = 'Inter'
  @bind accessor floatSel = true
  @bind accessor colField = '#1a73e8'
  tr!: FieldsGroupStores['t']

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
    return this.memo('part1_props', [this.tr, this.txt, this.memo], () => ({ t: this.tr, txt: this.txt, setTxt: this.memo("setTxt:bound", [], () => this.setTxt.bind(this)) }))
  }

  /** A part of the screen still written in React (<TextArea> rows: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** `<FontPicker>`, rendered by a ReactHost. */
  get FontPicker() {
    return FontPicker
  }

  get font_picker_props() {
    return this.memo('font_picker_props', [this.font, this.memo], () => ({ value: this.font, onChange: this.memo("setFont:bound", [], () => this.setFont.bind(this)), fonts: ['Inter', 'Georgia', 'Times New Roman', 'Courier New'] }))
  }

  /** `<FloatCheckbox>`, rendered by a ReactHost. */
  get FloatCheckbox() {
    return FloatCheckbox
  }

  get float_checkbox_props() {
    return this.memo('float_checkbox_props', [this.floatSel], () => ({ selected: this.floatSel, onToggle: () => this.floatSel = !this.floatSel } as React.ComponentProps<typeof FloatCheckbox>))
  }

  get part2_props() {
    return this.memo('part2_props', [this.colField, this.memo, this.props], () => ({ colField: this.colField, setColField: this.memo("setColField:bound", [], () => this.setColField.bind(this)), pickerTheme: this.props.pickerTheme }))
  }

  /** A part of the screen still written in React (<ColorField> C: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.props], () => ({ grad: this.props.grad, setGrad: this.props.setGrad, pickerTheme: this.props.pickerTheme }))
  }

  /** A part of the screen still written in React (<GradientField> value: a value the property converts (gradient-css)). */
  get Part3() {
    return __parts.Part3
  }

  /** `setTxt` of the TSX: a value, or an update of the previous one. */
  setTxt(value: FieldsGroup['txt'] | ((prev: FieldsGroup['txt']) => FieldsGroup['txt'])) {
    this.txt = typeof value === 'function' ? (value as (prev: FieldsGroup['txt']) => FieldsGroup['txt'])(this.txt) : value
  }

  /** `setFont` of the TSX: a value, or an update of the previous one. */
  setFont(value: FieldsGroup['font'] | ((prev: FieldsGroup['font']) => FieldsGroup['font'])) {
    this.font = typeof value === 'function' ? (value as (prev: FieldsGroup['font']) => FieldsGroup['font'])(this.font) : value
  }

  /** `setColField` of the TSX: a value, or an update of the previous one. */
  setColField(value: FieldsGroup['colField'] | ((prev: FieldsGroup['colField']) => FieldsGroup['colField'])) {
    this.colField = typeof value === 'function' ? (value as (prev: FieldsGroup['colField']) => FieldsGroup['colField'])(this.colField) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type FieldsGroupStores = ReturnType<FieldsGroup['useStores']>

export default FieldsGroup.component()
