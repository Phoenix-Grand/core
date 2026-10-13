/**
 * The parts of `AuthMethodsPanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Terminal } from "lucide-react"
import { Callout, Toggle } from "@ui"
import type { AuthMethodsPanel } from './AuthMethodsPanel'
type MethodId = 'local' | 'directory' | 'sso'

function MethodRow({
  id,
  icon,
  checked,
  disabled,
  onChange,
  t,
}: {
  id: MethodId
  icon: React.ReactNode
  checked: boolean
  disabled: boolean
  onChange: (v: boolean) => void
  t: (k: string) => string
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 shrink-0 text-text-tertiary">{icon}</span>
        <div className="min-w-0">
          <p className="font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
            {t(`authmethods.${id}`)}
          </p>
          <p className="mt-0.5 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {t(`authmethods.${id}_desc`)}
          </p>
        </div>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    </div>
  )
}
export { MethodRow }

export function Part1({ t }: { t: NonNullable<AuthMethodsPanel['tr']> }) {
  return (
    <Callout variant="info" title={t('authmethods.recovery_title')}>
                  <p>{t('authmethods.recovery_body')}</p>
                  <pre
                    className="mt-2 max-w-full overflow-x-auto rounded-md border border-border bg-surface-1 px-2.5 py-2 font-mono text-text-primary"
                    style={{ fontSize: 'var(--kb-text-meta)' }}
                  >
                    sudo kubuno auth:recover admin@exemple.com --local-access --set-password
                  </pre>
                  <p className="mt-2 flex items-start gap-2">
                    <Terminal size={15} className="mt-0.5 shrink-0" />
                    <span>{t('authmethods.recovery_note')}</span>
                  </p>
                </Callout>
  )
}
