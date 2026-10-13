/**
 * The parts of `LoginAnimationPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { LoginAnimationPanel } from './LoginAnimationPanel'

export function Part1({ s, params, onSlide }: { s: NonNullable<LoginAnimationPanel['rows_anim_sliders']>[number]['s']; params: NonNullable<LoginAnimationPanel['params']>; onSlide: LoginAnimationPanel['onSlide'] }) {
  return (
    <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={params[s.key]}
                  onChange={(e) => onSlide(s.key, Number(e.target.value))}
                  className="w-full h-1.5 accent-primary cursor-pointer"
                />
  )
}
