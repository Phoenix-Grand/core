/**
 * The parts of `ExportSubjectsCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { X } from "lucide-react"
import { DataTable, EmptyState } from "@ui"
import type { ExportSubjectsCard } from './ExportSubjectsCard'

export function Part1({ data, columns, t }: { data: NonNullable<ExportSubjectsCard['data']>; columns: NonNullable<ExportSubjectsCard['columns']>; t: NonNullable<ExportSubjectsCard['tr']> }) {
  return (
    <DataTable
              rows={data}
              columns={columns}
              rowKey={r => r.id}
              defaultSort={null}
              pageSize={25}
              minTableWidth={820}
              configurableColumns
              t={t}
              emptyState={(
                <EmptyState
                  icon={<X size={26} />}
                  title={t('admin.dx_sub_empty')}
                  compact
                  t={t}
                />
              )}
            />
  )
}
