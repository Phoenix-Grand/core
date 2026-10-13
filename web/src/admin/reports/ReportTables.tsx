import { useTranslation } from 'react-i18next'
import type { BreakdownRow, ReportModel } from './model'
import type { FlowItem } from './paged/types'
import ReportBlock from './ReportBlock'
import Nothing from './Nothing'
/**
 * The cell and heading classes of every table in the document.
 *
 * Exported rather than repeated: three tables that drifted apart on padding
 * would print as three tables from three documents. The print stylesheet
 * overrides borders and padding anyway (`index.css`), which is exactly why the
 * screen side has to be stated once.
 */
export const CELL = 'border-b border-border px-3 py-1.5 align-top'
export const HEAD = `${CELL} bg-surface-1 text-left font-medium text-text-secondary`

/**
 * The series, as a paginable item.
 *
 * A hook rather than a component: the paginator needs the ROWS, one node each,
 * so it can decide which of them land on which sheet. A component would hand it
 * one opaque `<table>` and the cut would go back to being the engine's guess.
 */
export function useSeriesItem(model: ReportModel): FlowItem {
  const { t } = useTranslation()

  if (model.series.length === 0) {
    return {
      kind: 'atom',
      id:   'series',
      node: (
        <ReportBlock title={t('admin.rep_series')}>
          <Nothing>{t('admin.rep_series_none')}</Nothing>
        </ReportBlock>
      ),
    }
  }

  const peak = model.series.reduce((m, r) => Math.max(m, r.value), 0)

  return {
    kind:     'table',
    id:       'series',
    title:    t('admin.rep_series'),
    fontSize: 'var(--kb-text-body)',
    head: (
      <tr>
        <th scope="col" className={HEAD}>{t('admin.rep_bucket')}</th>
        <th scope="col" className={`${HEAD} text-right`}>{t('admin.rep_value')}</th>
      </tr>
    ),
    // The busiest interval is marked rather than left to be found: it is the one
    // row of ninety a reader is actually looking for, and "En bref" names it
    // above — the mark is what lets them land on it.
    rows: model.series.map(row => (
      <tr key={row.label} data-peak={peak > 0 && row.value === peak ? '' : undefined}>
        <td className={CELL}>{row.label}</td>
        <td className={`${CELL} text-right tabular-nums`}>{row.text}</td>
      </tr>
    )),
    // The sum is stated only when the buckets actually add up to the period's
    // total — see `seriesTotal` in the model.
    foot: model.seriesTotal === null ? undefined : (
      <tr>
        <th scope="row" className={`${CELL} text-left font-medium`}>{t('admin.rep_total')}</th>
        <td className={`${CELL} text-right font-medium tabular-nums`}>{model.fmt(model.seriesTotal)}</td>
      </tr>
    ),
  }
}

/**
 * One row of the breakdown — with the colour of its slice and a bar for its
 * share.
 *
 * The swatch is not decoration: it is the SAME colour the chart gave that entry,
 * which is what lets a reader move between the two without counting positions.
 * The bar says at a glance what a column of percentages says only after
 * arithmetic — and it is drawn from `share`, the figure printed beside it, so
 * the picture and the number cannot disagree.
 */
function BreakdownRowCells({ row, quotas, fmt, lang, tone }: {
  row:    BreakdownRow
  quotas: boolean
  fmt:    (v: number) => string
  lang:   string
  tone:   string
}) {
  const pct = (v: number) => `${v.toLocaleString(lang, { maximumFractionDigits: 1 })} %`
  return (
    <tr>
      <td className={CELL}>
        <span className="flex items-center gap-2">
          <span
            data-tone
            aria-hidden
            className="inline-block size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: tone }}
          />
          <span className="min-w-0">{row.label}</span>
        </span>
      </td>
      <td className={`${CELL} text-right tabular-nums`}>{row.text}</td>
      <td className={`${CELL} tabular-nums`}>
        {row.share === null ? <span className="block text-right">—</span> : (
          <span className="flex items-center justify-end gap-2">
            <span data-share-track aria-hidden className="hidden sm:block">
              <span data-share-fill style={{ width: `${Math.max(2, Math.min(100, row.share))}%`, backgroundColor: tone }} />
            </span>
            <span className="w-14 text-right">{pct(row.share)}</span>
          </span>
        )}
      </td>
      {quotas && (
        <>
          <td className={`${CELL} text-right tabular-nums`}>
            {row.capacity === null ? '—' : fmt(row.capacity)}
          </td>
          <td className={`${CELL} text-right tabular-nums`}>
            {row.used === null ? '—' : pct(row.used)}
          </td>
        </>
      )}
    </tr>
  )
}

/** Every slice of the breakdown — the whole of it, not the head of it. */
export function useBreakdownItem(model: ReportModel, tones: (key: string, i: number) => string): FlowItem {
  const { t, i18n } = useTranslation()

  if (model.breakdown.length === 0) {
    return {
      kind: 'atom',
      id:   'breakdown',
      node: (
        <ReportBlock title={t('admin.rep_breakdown')}>
          <Nothing>{t('admin.rep_breakdown_none')}</Nothing>
        </ReportBlock>
      ),
    }
  }

  const quotas = model.breakdown.some(r => r.capacity !== null)

  return {
    kind:     'table',
    id:       'breakdown',
    title:    t('admin.rep_breakdown'),
    fontSize: 'var(--kb-text-body)',
    // A list that stopped at a ceiling is not a list that ended, and a printed
    // page has nobody left to ask.
    note: model.truncated ? t('admin.rep_truncated', { count: model.breakdown.length }) : undefined,
    head: (
      <tr>
        <th scope="col" className={HEAD}>{t('admin.rep_entry')}</th>
        <th scope="col" className={`${HEAD} text-right`}>{t('admin.rep_value')}</th>
        <th scope="col" className={`${HEAD} text-right`}>{t('admin.rep_share')}</th>
        {quotas && <th scope="col" className={`${HEAD} text-right`}>{t('admin.rep_quota')}</th>}
        {quotas && <th scope="col" className={`${HEAD} text-right`}>{t('admin.rep_used')}</th>}
      </tr>
    ),
    rows: model.breakdown.map((row, i) => (
      <BreakdownRowCells
        key={row.key}
        row={row}
        quotas={quotas}
        fmt={model.fmt}
        lang={i18n.language}
        tone={tones(row.key, i)}
      />
    )),
    foot: (
      <tr>
        <th scope="row" className={`${CELL} text-left font-medium`}>{t('admin.rep_total')}</th>
        <td className={`${CELL} text-right font-medium tabular-nums`}>{model.fmt(model.breakdownTotal)}</td>
        <td className={CELL} />
        {quotas && <td className={CELL} />}
        {quotas && <td className={CELL} />}
      </tr>
    ),
  }
}
