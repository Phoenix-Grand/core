/**
 * The parts of `CalendarDialog.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input } from "@ui"
import type { CalendarDialog } from './CalendarDialog'

export function Part1({ t, name, setName }: { t: NonNullable<CalendarDialog['tr']>; name: NonNullable<CalendarDialog['name']>; setName: NonNullable<CalendarDialog['setName']> }) {
  return (
    <Input
                label={t('admin.hol_calendar_name')}
                value={name}
                maxLength={160}
                autoFocus
                onChange={e => setName(e.target.value)}
                hint={t('admin.hol_calendar_name_hint')}
              />
  )
}
