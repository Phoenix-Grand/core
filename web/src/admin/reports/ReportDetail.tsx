import { useTranslation } from 'react-i18next'
import { CELL, HEAD } from './ReportTables'
import type { ReportModel } from './model'
import type { FlowItem } from './paged/types'
import Nothing from './Nothing'
import ReportBlock from './ReportBlock'

/**
 * The records behind the figure — who, when, what.
 *
 * ## Why a total and a curve are not a report
 *
 * "47 échecs de connexion" is a counter. The question it provokes — *which
 * accounts* — is the one an operator actually has to answer, and until this
 * section existed the document could not. A chart shows a shape, a breakdown
 * shows proportions; only a list of the underlying records lets somebody act,
 * and a report is written for somebody who was not in the room and cannot ask.
 *
 * ## What it prints, and what it never prints
 *
 * The columns are the server's, not this file's: it declares them per SOURCE
 * TABLE (`handlers/admin/detail.rs`) and this component renders whatever it is
 * handed. That is deliberate — a console inventing headings would eventually
 * name a column the server never meant to publish. No password, no token, no
 * hash and no fingerprint reaches this table, by construction on that side.
 *
 * ## The two sentences that keep it honest
 *
 *   • **How many, out of how many.** A list of 2 000 rows under a total of
 *     9 400 must say so, or it reads as the whole period.
 *   • **Why there is none.** A panel that describes a state, counts distinct
 *     values or reads an aggregated counter has no records to list. It says
 *     which of those it is, in one sentence, instead of leaving the reader to
 *     assume nothing happened.
 */
export function useDetailItem(model: ReportModel, total: number): FlowItem | null {
  const { t, i18n } = useTranslation()
  const detail = model.detail

  if (!detail) {
    // The server said nothing at all about records: an older build, or a panel
    // it does not describe. Nothing is printed rather than a section explaining
    // an absence this console cannot account for.
    if (!model.detailAbsent) return null
    return {
      kind: 'atom',
      id:   'detail',
      node: (
        <ReportBlock title={t('admin.rep_detail')}>
          <Nothing>
            {t(`admin.rep_detail_none_${model.detailAbsent}`, {
              defaultValue: t('admin.rep_detail_none'),
            })}
          </Nothing>
        </ReportBlock>
      ),
    }
  }

  if (detail.rows.length === 0) {
    return {
      kind: 'atom',
      id:   'detail',
      node: (
        <ReportBlock title={t('admin.rep_detail')}>
          <Nothing>{t('admin.rep_detail_empty')}</Nothing>
        </ReportBlock>
      ),
    }
  }

  const n = (v: number) => v.toLocaleString(i18n.language)

  return {
    kind:     'table',
    id:       'detail',
    title:    t('admin.rep_detail'),
    // Records print a step smaller than the aggregates: there are many more of
    // them, and each row is read once, looking for one line.
    fontSize: 'var(--kb-text-meta)',
    note: (
      <>
        {/* `listed`, not `count`: `count` is i18next's pluralisation variable,
            and this sentence is a label with two figures in it, not a phrase
            that changes shape at one. */}
        {t('admin.rep_detail_count', { listed: n(detail.rows.length), total: n(total) })}
        {detail.truncated && ` ${t('admin.rep_detail_truncated', { limit: n(detail.limit) })}`}
      </>
    ),
    head: (
      <tr>
        {detail.headers.map((head, i) => (
          <th key={`${head}-${i}`} scope="col" className={HEAD}>{head}</th>
        ))}
      </tr>
    ),
    rows: detail.rows.map((row, r) => (
      // No stable key exists — the server sends facts, not identities, and it
      // is right not to publish a row id nobody would use. The index is honest
      // here: the list is read-only, never reordered and never filtered.
      <tr key={r}>
        {row.map((cell, c) => (
          <td
            key={c}
            className={
              // A timestamp is read as one thing and never broken across two
              // lines. An identifier is typed rather than read, so its digits
              // line up down the column — but it MAY wrap: a column that
              // refuses to narrow pushes the table off the edge of the sheet,
              // and a clipped address is worse than a wrapped one.
              detail.kinds[c] === 'instant'
                ? `${CELL} whitespace-nowrap tabular-nums`
                : detail.kinds[c] === 'code'
                  ? `${CELL} tabular-nums`
                  : CELL
            }
          >
            {cell ?? '—'}
          </td>
        ))}
      </tr>
    )),
  }
}
