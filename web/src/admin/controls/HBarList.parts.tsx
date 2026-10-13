/**
 * The parts of `HBarList.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { HBarList } from './HBarList'

export function Part1({ pct, over, it, color }: { pct: NonNullable<HBarList['rows_items']>[number]['pct']; over: NonNullable<HBarList['rows_items']>[number]['over']; it: NonNullable<HBarList['rows_items']>[number]['it']; color: NonNullable<HBarList['color']> }) {
  return (
    <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, background: over ? 'var(--color-danger)' : (it.color ?? color), transition: 'width .6s ease' }}
                  />
  )
}
