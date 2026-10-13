/**
 * The parts of `FieldsGroup.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ColorField, GradientField, Textarea } from "@ui"
import type { FieldsGroup } from './FieldsGroup'

export function Part1({ t, txt, setTxt }: { t: NonNullable<FieldsGroup['tr']>; txt: NonNullable<FieldsGroup['txt']>; setTxt: NonNullable<FieldsGroup['setTxt']> }) {
  return (
    <Textarea
              label={t('admin.t_prev_textarea', { defaultValue: 'Zone de texte' })}
              value={txt}
              onChange={(e) => setTxt(e.target.value)}
              rows={2}
            />
  )
}

export function Part2({ colField, setColField, pickerTheme }: { colField: NonNullable<FieldsGroup['colField']>; setColField: NonNullable<FieldsGroup['setColField']>; pickerTheme: NonNullable<FieldsGroup['props']['pickerTheme']> }) {
  return (
    <ColorField color={colField} onChange={setColField} C={pickerTheme} />
  )
}

export function Part3({ grad, setGrad, pickerTheme }: { grad: NonNullable<FieldsGroup['props']['grad']>; setGrad: NonNullable<FieldsGroup['props']['setGrad']>; pickerTheme: NonNullable<FieldsGroup['props']['pickerTheme']> }) {
  return (
    <GradientField value={grad} onChange={setGrad} C={pickerTheme} />
  )
}
