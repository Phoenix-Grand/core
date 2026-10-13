import { useTranslation } from "react-i18next"
import type { PanelProvenance } from "./api"
import type { ReportModel } from "./model"
import ReportBlock from './ReportBlock'

/**
 * Where the number came from, and what it cannot mean.
 *
 * ## The method, in one sentence
 *
 * Assembled from the three facts the server states about its own query — the
 * table, the predicate, and how rows become one number — rather than from a
 * paragraph written by hand next to each panel. Prose would have to be
 * translated into thirteen languages and, worse, would go on describing the
 * query it was written for long after somebody changed it. These three fields
 * ARE the query, so they cannot drift; the sentence around them is what gets
 * translated.
 *
 * A server that does not state them (an older one) gets no method section
 * inventing one.
 *
 * ## The caveats, which matter more here than on the card
 *
 * A caveat is a limit of the MEASUREMENT — the country database that may not be
 * installed, the failed sign-ins recorded for administrators only, the log
 * purged after thirty days. On the dashboard it sits three centimetres under the
 * chart it qualifies. On a sheet of paper handed to somebody else it is the only
 * thing standing between a number and a wrong conclusion, so it is printed as a
 * section of its own rather than as a footnote.
 */

/** The sentence a `measure` deserves. A closed vocabulary; see `Provenance`. */
function methodKey(measure: string): string | null {
  switch (measure) {
    case 'count':          return 'admin.rep_method_count'
    case 'count_distinct': return 'admin.rep_method_count_distinct'
    case 'sum':            return 'admin.rep_method_sum'
    // A measure this build has no sentence for is left unstated rather than
    // described by the nearest one that happens to exist.
    default: return null
  }
}

export function MethodBlock({
  source, model,
}: {
  source: PanelProvenance | undefined
  model:  ReportModel
}) {
  const { t } = useTranslation()
  const key = source ? methodKey(source.measure) : null

  return (
    <ReportBlock title={t('admin.rep_method')}>
      {!source || !key ? (
        <p className="text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {t('admin.rep_method_unknown')}
        </p>
      ) : (
        <div className="space-y-2 text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
          <p>{t(key, { table: source.table, column: source.column ?? '' })}</p>
          <p>
            {t('admin.rep_method_filter')}{' '}
            {/* `TRUE` is what a predicate that restricts nothing looks like in
                SQL, and printing it verbatim would read as a placeholder. */}
            {source.filter === 'TRUE' ? (
              <span>{t('admin.rep_method_all_rows')}</span>
            ) : (
              <code className="rounded bg-surface-2 px-1 py-0.5 text-text-primary"
                    style={{ fontSize: 'var(--kb-text-meta)' }}>
                {source.filter}
              </code>
            )}
          </p>
          <p>
            {model.snapshot
              ? t('admin.rep_method_snapshot')
              : t('admin.rep_method_window', {
                  tz:   model.timezone,
                  from: model.previousFrom,
                  to:   model.previousTo,
                })}
          </p>
        </div>
      )}
    </ReportBlock>
  )
}
