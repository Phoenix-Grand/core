/**
 * The parts of `OverviewTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { ReactNode } from "react"

function Stat({ icon, value, label }: { icon: ReactNode; value: number; label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-0 px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full
                       bg-primary-light text-primary">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-text-primary" style={{ fontSize: 'var(--kb-text-title)' }}>
          {value}
        </span>
        <span className="block truncate text-text-secondary"
              style={{ fontSize: 'var(--kb-text-meta)' }}>
          {label}
        </span>
      </span>
    </div>
  )
}
export { Stat }
