/**
 * The parts of `ModulesLicenceCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { DataTable } from "@ui"
import type { ModulesLicenceCard } from './ModulesLicenceCard'

export function Part1({ modules, columns, t }: { modules: NonNullable<ModulesLicenceCard['props']['modules']>; columns: NonNullable<ModulesLicenceCard['columns']>; t: NonNullable<ModulesLicenceCard['tr']> }) {
  return (
    <DataTable
            rows={modules}
            columns={columns}
            rowKey={r => r.id}
            defaultSort={{ columnId: 'name', direction: 'asc' }}
            pageSize={0}
            t={t}
          />
  )
}
