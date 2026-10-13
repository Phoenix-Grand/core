/**
 * The parts of `QuotaField.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { cn } from "../../ui/cn"
import { Input } from "@ui"
import type { QuotaField } from './QuotaField'

export function Part1({ label, amount, autoFocus, onAmount, error }: { label: NonNullable<QuotaField['props']['label']>; amount: NonNullable<QuotaField['props']['amount']>; autoFocus: QuotaField['props']['autoFocus']; onAmount: NonNullable<QuotaField['props']['onAmount']>; error: QuotaField['props']['error'] }) {
  return (
    <Input
                label={label}
                value={amount}
                inputMode="decimal"
                autoFocus={autoFocus}
                onChange={e => onAmount(e.target.value)}
                error={error}
              />
  )
}

export function Part2({ u, unit, onUnit }: { u: NonNullable<QuotaField['rows_units']>[number]['u']; unit: NonNullable<QuotaField['props']['unit']>; onUnit: NonNullable<QuotaField['props']['onUnit']> }) {
  return (
    <button
                  key={u.id}
                  type="button"
                  aria-pressed={unit === u.id}
                  onClick={() => onUnit(u.id)}
                  className={cn(
                    'px-3 py-2 transition-colors',
                    unit === u.id
                      ? 'bg-primary-light text-primary'
                      : 'text-text-secondary hover:bg-surface-2',
                  )}
                  style={{ fontSize: 'var(--kb-text-body)' }}
                >
                  {u.label}
                </button>
  )
}
