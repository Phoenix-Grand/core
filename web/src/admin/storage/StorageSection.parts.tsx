/**
 * The parts of `StorageSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ProgressBar } from "@ui"
import { formatBytes } from "../sections/format"
import Figure from "./Figure"
import type { StorageSection } from './StorageSection'

export function Part1({ t, data }: { t: NonNullable<StorageSection['tr']>; data: NonNullable<StorageSection['data']> }) {
  return (
    <Figure label={t('admin.sto_fig_accounts')}>{data.accounts}</Figure>
  )
}

export function Part2({ t, data }: { t: NonNullable<StorageSection['tr']>; data: NonNullable<StorageSection['data']> }) {
  return (
    <Figure label={t('admin.sto_fig_allocated')}>{formatBytes(data.allocated_bytes)}</Figure>
  )
}

export function Part3({ t, trendData }: { t: NonNullable<StorageSection['tr']>; trendData: NonNullable<StorageSection['trendData']> }) {
  return (
    <Figure label={t('admin.sto_fig_measured')}>
                      {t('admin.sto_fig_days', { count: trendData.length })}
                    </Figure>
  )
}

export function Part4({ t, trendData }: { t: NonNullable<StorageSection['tr']>; trendData: NonNullable<StorageSection['trendData']> }) {
  return (
    <Figure label={t('admin.sto_fig_growth')}>
                      {formatBytes(Math.max(trendData[trendData.length - 1].value - trendData[0].value, 0))}
                    </Figure>
  )
}

export function Part5({ t, projection, projection_daysLeft }: { t: NonNullable<StorageSection['tr']>; projection: NonNullable<StorageSection['projection']>; projection_daysLeft: number }) {
  return (
    <Figure label={t('admin.sto_fig_forecast')}>
                        {projection.daysLeft != null
                          ? t('admin.sto_fig_days', { count: projection_daysLeft })
                          : t('admin.sto_fig_no_growth')}
                      </Figure>
  )
}

export function Part6({ u, data, t }: { u: NonNullable<StorageSection['rows_by_unit']>[number]['u']; data: NonNullable<StorageSection['data']>; t: NonNullable<StorageSection['tr']> }) {
  return (
    <ProgressBar
                        value={u.used_bytes}
                        max={Math.max(data.used_bytes, 1)}
                        variant="primary"
                        label={
                          <span>
                            {u.unit_name ?? t('admin.sto_no_unit')}
                            <span className="text-text-tertiary"> · {t('admin.sto_units_accounts', { count: u.accounts })}</span>
                          </span>
                        }
                        showValue
                        formatValue={() => formatBytes(u.used_bytes)}
                        t={t}
                      />
  )
}

export function Part7({ canManageSettings, warnDraft, data, setWarnDraft, t }: { canManageSettings: NonNullable<StorageSection['canManageSettings']>; warnDraft: StorageSection['warnDraft']; data: NonNullable<StorageSection['data']>; setWarnDraft: NonNullable<StorageSection['setWarnDraft']>; t: NonNullable<StorageSection['tr']> }) {
  return (
    <input
                  type="range"
                  min={50}
                  max={100}
                  step={5}
                  disabled={!canManageSettings}
                  value={warnDraft ?? data.warn_percent}
                  onChange={e => setWarnDraft(Number(e.target.value))}
                  aria-label={t('admin.sto_threshold_title')}
                  className="h-1 min-w-[180px] flex-1 accent-[var(--color-primary)]"
                />
  )
}
