/**
 * The parts of `ReconciliationCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Callout } from "@ui"
import { formatBytes } from "../sections/format"
import Figure from "./Figure"
import type { ReconciliationCard } from './ReconciliationCard'

export function Part1({ t, data }: { t: NonNullable<ReconciliationCard['tr']>; data: NonNullable<ReconciliationCard['props']['data']> }) {
  return (
    <Figure label={t('admin.sto_rec_fig_drifting')}>{data.drifting_accounts}</Figure>
  )
}

export function Part2({ t, data }: { t: NonNullable<ReconciliationCard['tr']>; data: NonNullable<ReconciliationCard['props']['data']> }) {
  return (
    <Figure label={t('admin.sto_rec_fig_threshold')}>{formatBytes(data.min_delta_bytes)}</Figure>
  )
}

export function Part3({ t, data }: { t: NonNullable<ReconciliationCard['tr']>; data: NonNullable<ReconciliationCard['props']['data']> }) {
  return (
    <Figure label={t('admin.sto_rec_fig_corrected')}>{data.corrected_accounts}</Figure>
  )
}

export function Part4({ t, data }: { t: NonNullable<ReconciliationCard['tr']>; data: NonNullable<ReconciliationCard['props']['data']> }) {
  return (
    <Figure label={t('admin.sto_rec_fig_moved')}>{formatBytes(data.bytes_moved)}</Figure>
  )
}

export function Part5({ t, held }: { t: NonNullable<ReconciliationCard['tr']>; held: NonNullable<ReconciliationCard['held']> }) {
  return (
    <Callout
              variant="warning"
              className="mt-4"
              title={t('admin.sto_rec_held_title', { count: held.length })}
              t={t}
            >
              <p style={{ fontSize: 'var(--kb-text-body)' }}>{t('admin.sto_rec_held_desc')}</p>
    
              <ul className="mt-3 flex flex-col gap-2">
                {held.map(a => (
                  <li key={a.user_id} className="min-w-0">
                    <div className="truncate text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                      {a.email}
                    </div>
                    <div className="tabular-nums text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                      {t('admin.sto_rec_held_line', {
                        counter:  formatBytes(a.counter_bytes),
                        declared: formatBytes(a.declared_bytes),
                        quota:    formatBytes(a.quota_bytes),
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </Callout>
  )
}
