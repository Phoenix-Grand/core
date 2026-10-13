/**
 * The parts of `AnchoredDemo.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { AnchoredPopover } from "@ui"
import { noop } from "./PreviewDemos"
import type { AnchoredDemo } from './AnchoredDemo'

export function Part1({ ref }: { ref: NonNullable<AnchoredDemo['ref']> }) {
  return (
    <button ref={ref} className="px-3 py-1.5 text-sm rounded-lg border border-border bg-white text-text-primary">
            Élément ancré
          </button>
  )
}

export function Part2({ ref }: { ref: NonNullable<AnchoredDemo['ref']> }) {
  return (
    <AnchoredPopover anchorRef={ref} open onClose={noop}>
            <div className="w-44 py-1 rounded-lg bg-white border border-border shadow-[0_2px_6px_2px_rgba(0,0,0,.12)]">
              {['Renommer', 'Déplacer', 'Dupliquer', 'Supprimer'].map((l) => (
                <div key={l} className="px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2 cursor-default">{l}</div>
              ))}
            </div>
          </AnchoredPopover>
  )
}
