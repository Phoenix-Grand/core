/**
 * The parts of `HealthTopbarChip.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { HealthTopbarChip } from './HealthTopbarChip'

export function Part1({ Icon, isCritical }: { Icon: NonNullable<HealthTopbarChip['Icon']>; isCritical: NonNullable<HealthTopbarChip['isCritical']> }) {
  return (
    <Icon size={16} className={`shrink-0 ${isCritical ? 'text-danger' : 'text-warning'}`} />
  )
}
