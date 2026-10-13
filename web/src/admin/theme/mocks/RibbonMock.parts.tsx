/**
 * The parts of `RibbonMock.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { RibbonMock } from './RibbonMock'

export function Part1({ groupLabel }: { groupLabel: NonNullable<RibbonMock['groupLabel']> }) {
  return (
    <div className="text-[10px] text-center whitespace-nowrap" style={groupLabel}>Presse-papiers</div>
  )
}

export function Part2({ sep }: { sep: NonNullable<RibbonMock['sep']> }) {
  return (
    <div className="self-stretch my-2" style={sep} />
  )
}

export function Part3({ groupLabel }: { groupLabel: NonNullable<RibbonMock['groupLabel']> }) {
  return (
    <div className="text-[10px] text-center whitespace-nowrap" style={groupLabel}>Police</div>
  )
}

export function Part4({ sep }: { sep: NonNullable<RibbonMock['sep']> }) {
  return (
    <div className="self-stretch my-2" style={sep} />
  )
}

export function Part5({ groupLabel }: { groupLabel: NonNullable<RibbonMock['groupLabel']> }) {
  return (
    <div className="text-[10px] text-center whitespace-nowrap" style={groupLabel}>Objets</div>
  )
}
