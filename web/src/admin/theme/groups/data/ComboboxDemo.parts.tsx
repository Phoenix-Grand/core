/**
 * The parts of `ComboboxDemo.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Combobox } from "@ui"
import { DEMO_UNITS } from "./fixtures"
import type { ComboboxDemo } from './ComboboxDemo'

export function Part1({ t, unit, setUnit }: { t: NonNullable<ComboboxDemo['tr']>; unit: ComboboxDemo['unit']; setUnit: NonNullable<ComboboxDemo['setUnit']> }) {
  return (
    <Combobox
                t={t}
                value={unit}
                onChange={setUnit}
                options={DEMO_UNITS}
                clearable
                onClear={() => setUnit(null)}
                placeholder={t('admin.t_prev_cb_ph', { defaultValue: 'Choisir une unité…' })}
              />
  )
}
