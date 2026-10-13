/**
 * The parts of `IdentityCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */

function Action({
  icon, label, onClick, danger, disabled, reason,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?:   boolean
  disabled?: boolean
  reason?:   string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? reason : undefined}
      className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors
        ${disabled
          ? 'cursor-not-allowed text-text-tertiary'
          : danger
            ? 'text-danger hover:bg-danger-light'
            : 'text-text-primary hover:bg-surface-2'}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
export { Action }
