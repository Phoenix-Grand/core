/**
 * The parts of `TableFragment.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { TableFragment } from './TableFragment'

export function Part1({ item, widths, from, to, last, item_foot }: { item: NonNullable<TableFragment['props']['item']>; widths: NonNullable<TableFragment['props']['widths']>; from: NonNullable<TableFragment['from']>; to: NonNullable<TableFragment['to']>; last: NonNullable<TableFragment['last']>; item_foot: NonNullable<NonNullable<TableFragment['props']['item']>['foot']> }) {
  return (
    <table
            data-report-table
            data-paged-table
            className="w-full border-collapse text-text-primary"
            style={{ fontSize: item.fontSize, tableLayout: widths ? 'fixed' : 'auto' }}
          >
            {widths && (
              <colgroup>
                {widths.map((w, i) => <col key={i} style={{ width: `${w}px` }} />)}
              </colgroup>
            )}
            <thead data-paged-head>{item.head}</thead>
            <tbody data-paged-body>{item.rows.slice(from, to)}</tbody>
            {last && item.foot && <tfoot data-paged-foot>{item_foot}</tfoot>}
          </table>
  )
}
