/**
 * The parts of `ColorsGroup.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */

function Swatch({ varName, label }: { varName: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="w-10 h-10 rounded-lg border border-border"
        style={{ background: `var(${varName})` }}
      />
      <span className="text-[10px] text-text-tertiary">{label}</span>
    </div>
  )
}
export { Swatch }
