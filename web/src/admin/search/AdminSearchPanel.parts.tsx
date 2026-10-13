/**
 * The parts of `AdminSearchPanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Clock } from "lucide-react"
import { KIND_LABEL_KEY, KIND_VIEW_ALL } from "./useAdminSearchSources"
import { ResultRow } from "./ResultRow"
import type { AdminSearchPanel } from './AdminSearchPanel'

function Heading({ label, onViewAll }: { label: string; onViewAll?: () => void }) {
  const { t } = useTranslation()
  return (
    <li role="presentation" className="flex items-center justify-between px-4 pb-1 pt-2">
      {/* Panel section title: 14px bold, no forced caps and no letter-spacing. */}
      <span className="font-bold text-text-secondary"
            style={{ fontSize: 'var(--kb-text-body)' }}>
        {label}
      </span>
      {onViewAll && (
        <button
          type="button"
          onMouseDown={e => { e.preventDefault(); onViewAll() }}
          className="rounded text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ fontSize: 'var(--kb-text-meta)' }}
        >
          {t('admin.search_view_all')}
        </button>
      )}
    </li>
  )
}
export { Heading }

export function Part1({ listId, t }: { listId: NonNullable<AdminSearchPanel['listId']>; t: NonNullable<AdminSearchPanel['tr']> }) {
  return (
    <ul id={listId} role="listbox" aria-label={t('admin.search_results')} className="py-2">
              <li role="presentation" className="px-4 py-3 text-text-tertiary" style={{ fontSize: 'var(--kb-text-body)' }}>
                {t('admin.search_hint')}
              </li>
            </ul>
  )
}

export function Part2({ listId, t, props, activeIndex, optionId, mobile, onPick, setActive }: { listId: NonNullable<AdminSearchPanel['listId']>; t: NonNullable<AdminSearchPanel['tr']>; props: NonNullable<AdminSearchPanel['props']>; activeIndex: NonNullable<AdminSearchPanel['activeIndex']>; optionId: NonNullable<AdminSearchPanel['optionId']>; mobile: NonNullable<AdminSearchPanel['mobile']>; onPick: NonNullable<AdminSearchPanel['onPick']>; setActive: NonNullable<AdminSearchPanel['setActive']> }) {
  return (
    <ul id={listId} role="listbox" aria-label={t('admin.search_results')} className="py-1.5">
            {props.recents.length > 0 && <Heading label={t('admin.search_cat_recent')} />}
            {props.recents.map((r, i) => (
              <ResultRow
                key={`recent:${r.url}`}
                result={{ key: `recent:${r.url}`, kind: r.kind, label: r.label, sublabel: r.sublabel, url: r.url, score: 0, Icon: Clock }}
                active={activeIndex === i}
                optionId={optionId(i)}
                mobile={mobile}
                onPick={onPick}
                onHover={() => setActive(i)}
              />
            ))}
            {props.suggestions.length > 0 && <Heading label={t('admin.search_cat_suggested')} />}
            {props.suggestions.map((r, i) => {
              const index = props.recents.length + i
              return (
                <ResultRow
                  key={r.key} result={r} active={activeIndex === index} optionId={optionId(index)}
                  mobile={mobile} onPick={onPick} onHover={() => setActive(index)}
                />
              )
            })}
          </ul>
  )
}

export function Part3({ listId, t, runs, onNavigate, query, index, activeIndex, optionId, mobile, onPick, setActive }: { listId: NonNullable<AdminSearchPanel['listId']>; t: NonNullable<AdminSearchPanel['tr']>; runs: NonNullable<AdminSearchPanel['runs']>; onNavigate: NonNullable<AdminSearchPanel['onNavigate']>; query: NonNullable<AdminSearchPanel['query']>; index: NonNullable<AdminSearchPanel['index']>; activeIndex: NonNullable<AdminSearchPanel['activeIndex']>; optionId: NonNullable<AdminSearchPanel['optionId']>; mobile: NonNullable<AdminSearchPanel['mobile']>; onPick: NonNullable<AdminSearchPanel['onPick']>; setActive: NonNullable<AdminSearchPanel['setActive']> }) {
  return (
    <ul id={listId} role="listbox" aria-label={t('admin.search_results')} className="py-1.5">
          {runs.map((run, ri) => {
            const viewAll = KIND_VIEW_ALL[run.kind]
            return (
              <li key={`${run.kind}-${ri}`} role="presentation">
                <ul role="group" aria-label={t(KIND_LABEL_KEY[run.kind])}
                    className={ri > 0 ? 'border-t border-border' : undefined}>
                  <Heading
                    label={t(KIND_LABEL_KEY[run.kind])}
                    onViewAll={viewAll ? () => onNavigate(viewAll(query.trim())) : undefined}
                  />
                  {run.items.map(r => {
                    index += 1
                    const i = index
                    return (
                      <ResultRow
                        key={r.key} result={r} active={activeIndex === i} optionId={optionId(i)}
                        mobile={mobile} onPick={onPick} onHover={() => setActive(i)}
                      />
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
  )
}
