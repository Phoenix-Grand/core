/**
 * The parts of `MockSidebar.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { MockSidebar } from './MockSidebar'

export function Part1({ items }: { items: NonNullable<MockSidebar['items']> }) {
  return (
    <>{items.map(({ icon: Icon, label, active }) => (
            <div
              key={label}
              className={`flex items-center gap-3 h-9 px-3 rounded-full text-sm cursor-pointer
            ${active ? 'bg-primary-light text-text-nav-active font-medium' : 'text-text-secondary hover:bg-surface-2'}`}
            >
              <Icon size={18} /> {label}
            </div>
          ))}</>
  )
}
