/**
 * Code-behind of `PickersGroup.kbcontrol` (converted from `PickersGroup.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { ColorPicker, ColorSwatchPicker, GradientPicker, type Gradient, type PickerTheme } from "@ui"

import { ViewBase } from './PickersGroup.kbcontrol'

export type PickersGroupProps = {
  pickerTheme: PickerTheme
  grad:        Gradient
  setGrad:     (g: Gradient) => void
}

export class PickersGroup extends ViewBase {
  @bind accessor swatch = '#1e8e3e'
  @bind accessor pick = '#d93025'

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    this.useStores()
  }

  /** `<ColorSwatchPicker>`, rendered by a ReactHost. */
  get ColorSwatchPicker() {
    return ColorSwatchPicker
  }

  get color_swatch_picker_props() {
    return this.memo('color_swatch_picker_props', [this.swatch, this.memo, this.props], () => ({ color: this.swatch, onChange: this.memo("setSwatch:bound", [], () => this.setSwatch.bind(this)), theme: this.props.pickerTheme }))
  }

  /** `<ColorPicker>`, rendered by a ReactHost. */
  get ColorPicker() {
    return ColorPicker
  }

  get color_picker_props() {
    return this.memo('color_picker_props', [this.pick, this.memo, this.props], () => ({ color: this.pick, onChange: this.memo("setPick:bound", [], () => this.setPick.bind(this)), onClose: () => {}, C: this.props.pickerTheme } as React.ComponentProps<typeof ColorPicker>))
  }

  /** `<GradientPicker>`, rendered by a ReactHost. */
  get GradientPicker() {
    return GradientPicker
  }

  get gradient_picker_props() {
    return this.memo('gradient_picker_props', [this.props], () => ({ value: this.props.grad, onChange: this.props.setGrad, C: this.props.pickerTheme }))
  }

  /** `setSwatch` of the TSX: a value, or an update of the previous one. */
  setSwatch(value: PickersGroup['swatch'] | ((prev: PickersGroup['swatch']) => PickersGroup['swatch'])) {
    this.swatch = typeof value === 'function' ? (value as (prev: PickersGroup['swatch']) => PickersGroup['swatch'])(this.swatch) : value
  }

  /** `setPick` of the TSX: a value, or an update of the previous one. */
  setPick(value: PickersGroup['pick'] | ((prev: PickersGroup['pick']) => PickersGroup['pick'])) {
    this.pick = typeof value === 'function' ? (value as (prev: PickersGroup['pick']) => PickersGroup['pick'])(this.pick) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type PickersGroupStores = ReturnType<PickersGroup['useStores']>

export default PickersGroup.component()
