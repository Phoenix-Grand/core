/**
 * The parts of `InlineEditField.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { InlineEditField } from './InlineEditField'

export function Part1({ label }: { label: InlineEditField['props']['label'] }) {
  return (
    <dt
            className="shrink-0 text-text-tertiary sm:w-44"
            style={{ fontSize: 'var(--kb-text-body)' }}
          >
            {label}
          </dt>
  )
}

export function Part2({ children }: { children: InlineEditField['props']['children'] }) {
  return (
    <dd className="min-w-0 break-words text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
            {children}
          </dd>
  )
}
