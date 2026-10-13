/**
 * The parts of `ResizeHandleDemo.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { ResizeHandleDemo } from './ResizeHandleDemo'

export function Part1({ w }: { w: NonNullable<ResizeHandleDemo['w']> }) {
  return (
    <div className="h-full bg-surface-1 flex items-center justify-center text-xs text-text-tertiary" style={{ width: w }}>
            Panneau
          </div>
  )
}
