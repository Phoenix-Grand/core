/**
 * The parts of `MainDbMigrationCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Check, TriangleAlert } from "lucide-react"
import { Callout } from "@ui"
import type { MainDbMigrationCard } from './MainDbMigrationCard'

export function Part1({ t, job }: { t: NonNullable<MainDbMigrationCard['tr']>; job: NonNullable<MainDbMigrationCard['job']> }) {
  return (
    <Callout variant="success">
                <span className="inline-flex items-center gap-1.5">
                  <Check size={15} />
                  {t('admin.dbmig_result_ok', { tables: job.tables_total, rows: job.total_rows, engine: job.target_engine })}
                </span>
                <div className="mt-1">{t('admin.dbmig_restart_hint')}</div>
              </Callout>
  )
}

export function Part2({ t, job }: { t: NonNullable<MainDbMigrationCard['tr']>; job: NonNullable<MainDbMigrationCard['job']> }) {
  return (
    <Callout variant="danger" icon={<TriangleAlert size={16} />} title={t('admin.dbmig_error')}>
                {job.error}
              </Callout>
  )
}
