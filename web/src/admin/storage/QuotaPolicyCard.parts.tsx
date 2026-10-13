/**
 * The parts of `QuotaPolicyCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Lock } from "lucide-react"
import type { QuotaPolicyCard } from './QuotaPolicyCard'

export function Part1({ t }: { t: NonNullable<QuotaPolicyCard['tr']> }) {
  return (
    <Lock size={14} className="text-text-tertiary" aria-label={t('admin.sto_policy_locked')} />
  )
}

export function Part2({ t }: { t: NonNullable<QuotaPolicyCard['tr']> }) {
  return (
    <Lock size={14} className="text-text-tertiary" aria-label={t('admin.sto_policy_locked')} />
  )
}
