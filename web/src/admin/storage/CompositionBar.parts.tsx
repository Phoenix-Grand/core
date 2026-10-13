/**
 * The parts of `CompositionBar.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { CompositionBar } from './CompositionBar'

export function Part1({ s, safeTotal, i }: { s: NonNullable<CompositionBar['rows_visible']>[number]['s']; safeTotal: NonNullable<CompositionBar['safeTotal']>; i: NonNullable<CompositionBar['rows_visible']>[number]['i'] }) {
  return (
    <div
                key={s.id}
                // The 2px separator is surface-coloured space, never a border: a
                // stroke around a mark adds ink that is not data.
                style={{
                  width:           `${(s.value / safeTotal) * 100}%`,
                  backgroundColor: s.color,
                  marginLeft:      i === 0 ? 0 : 2,
                }}
              />
  )
}

export function Part2({ s }: { s: NonNullable<CompositionBar['rows_segments']>[number]['s'] }) {
  return (
    <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: s.color,
                    // The track swatch is a light grey on a light card: without the
                    // ring it is a blank space where a key should be.
                    boxShadow: s.track ? 'inset 0 0 0 1px var(--color-border-strong)' : undefined,
                  }}
                  aria-hidden
                />
  )
}
