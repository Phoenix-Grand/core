/**
 * The parts of `OverviewBar.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { RefreshCw } from "lucide-react"
import { Button } from "@ui"
import { errorMessage } from "./api"
import type { OverviewBar } from './OverviewBar'

function Figure({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="flex min-w-24 flex-col">
      <span className="text-text-primary" style={{ fontSize: 'var(--kb-text-section)' }}>{value}</span>
      <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-small)' }}>{label}</span>
    </div>
  )
}
export { Figure }

export function Part1({ reload, setError, t }: { reload: NonNullable<OverviewBar['reload']>; setError: NonNullable<OverviewBar['setError']>; t: NonNullable<OverviewBar['tr']> }) {
  return (
    <Button
                  variant="ghost"
                  disabled={reload.isPending}
                  onClick={() => {
                    setError(null)
                    reload.mutate(undefined, { onError: e => setError(errorMessage(e, t('admin.hol_save_failed'))) })
                  }}
                >
                  <RefreshCw size={16} /> {t('admin.hol_reload')}
                </Button>
  )
}
