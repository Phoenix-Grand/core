/**
 * The parts of `RuleSentence.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { RuleSentence } from './RuleSentence'

export function Part1({ parts }: { parts: NonNullable<RuleSentence['parts']> }) {
  return (
    <>{parts.map((p, i) => p.strong
            ? <strong key={i} className="font-medium text-text-primary">{p.text}</strong>
            : <span key={i}>{p.text}</span>)}</>
  )
}
