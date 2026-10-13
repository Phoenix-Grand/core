/**
 * The parts of `DashboardSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Check, Plus, SlidersHorizontal, Users } from "lucide-react"
import { Button, Callout, Dropdown, EmptyState } from "@ui"
import PanelCard from "../panels/PanelCard"
import { type DashboardRetention } from "./dashboard/api"
import { panelDef } from "./dashboard/panels"
import type { DashboardSection } from './DashboardSection'
const PERIOD_DAYS: Record<string, number> = {
  last_180_days: 180, last_90_days: 90, last_30_days: 30, last_7_days: 7,
}

function StatCard({
  label, value, icon: Icon, tone, accent, children,
}: {
  label: string
  value: ReactNode
  icon: typeof Users
  /** A theme token, never a literal: this card is painted in both themes. */
  tone: string
  accent?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface-0 p-4">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {label}
        </span>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2">
          <Icon size={16} style={{ color: tone }} />
        </span>
      </div>
      <p className="font-semibold leading-tight text-text-primary tabular-nums"
         style={{ fontSize: 'var(--kb-text-title)' }}>
        {value}
      </p>
      {accent && (
        <div className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{accent}</div>
      )}
      {children && <div className="mt-2">{children}</div>}
    </div>
  )
}
export { StatCard }

function ReachNotice({
  periodId, retention,
}: {
  periodId:  string
  retention: DashboardRetention
}) {
  const { t, i18n } = useTranslation()
  const asked = PERIOD_DAYS[periodId] ?? 0

  if (asked > 0 && asked > retention.module_usage_days) {
    return (
      <Callout variant="info" className="mb-4">
        {t('admin.dash_retention_notice', { days: asked, kept: retention.module_usage_days })}
      </Callout>
    )
  }

  const since = retention.module_usage_since
  if (asked > 0 && since) {
    const started = new Date(`${since}T00:00:00`)
    const windowStart = new Date()
    windowStart.setDate(windowStart.getDate() - asked)
    if (!Number.isNaN(started.getTime()) && started > windowStart) {
      return (
        <Callout variant="info" className="mb-4">
          {t('admin.dash_usage_since_notice', {
            date: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long' }).format(started),
          })}
        </Callout>
      )
    }
  }

  return null
}
export { ReachNotice }

export function Part1({ t, n, stats, activePct }: { t: NonNullable<DashboardSection['tr']>; n: DashboardSection['n']; stats: DashboardSection['stats']; activePct: NonNullable<DashboardSection['activePct']> }) {
  return (
    <StatCard
              label={t('admin.card_users_active')} value={n(stats?.users_active)} icon={Users}
              tone="var(--kb-chart-2)"
              accent={t('admin.sub_of_total', { pct: activePct })}
            >
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full bg-success" style={{ width: `${activePct}%` }} />
              </div>
            </StatCard>
  )
}

export function Part2({ period, setPeriod, periodOptions }: { period: NonNullable<DashboardSection['period']>; setPeriod: NonNullable<DashboardSection['setPeriod']>; periodOptions: NonNullable<DashboardSection['periodOptions']> }) {
  return (
    <Dropdown
                value={period}
                onChange={setPeriod}
                options={periodOptions}
                width={200}
                focusable
              />
  )
}

export function Part3({ editing, setEditing, t }: { editing: NonNullable<DashboardSection['editing']>; setEditing: NonNullable<DashboardSection['setEditing']>; t: NonNullable<DashboardSection['tr']> }) {
  return (
    <Button
                variant={editing ? 'primary' : 'secondary'}
                onClick={() => setEditing(v => !v)}
                icon={editing ? <Check size={15} /> : <SlidersHorizontal size={15} />}
              >
                {editing ? t('admin.sec_done') : t('admin.sec_customise')}
              </Button>
  )
}

export function Part4({ visible, received, bucket, editing, hide, move, openReport, moduleName }: { visible: NonNullable<DashboardSection['visible']>; received: NonNullable<DashboardSection['received']>; bucket: NonNullable<DashboardSection['bucket']>; editing: NonNullable<DashboardSection['editing']>; hide: NonNullable<DashboardSection['hide']>; move: NonNullable<DashboardSection['move']>; openReport: NonNullable<DashboardSection['openReport']>; moduleName: NonNullable<DashboardSection['moduleName']> }) {
  return (
    <>{visible.map((id, i) => {
                const def = panelDef(id)
                const panel = received.get(id)
                if (!def || !panel) return null
                return (
                  <PanelCard
                    key={id}
                    def={def}
                    panel={panel}
                    bucket={bucket}
                    editing={editing}
                    canMoveUp={i > 0}
                    canMoveDown={i < visible.length - 1}
                    onHide={() => hide(id, visible)}
                    onMove={d => move(id, d, visible)}
                    onReport={() => openReport(id)}
                    labelSlice={id === 'app_usage' ? moduleName : undefined}
                  />
                )
              })}</>
  )
}

export function Part5({ t, reset }: { t: NonNullable<DashboardSection['tr']>; reset: NonNullable<DashboardSection['reset']> }) {
  return (
    <EmptyState
              icon={<SlidersHorizontal size={28} />}
              title={t('admin.sec_all_hidden')}
              description={t('admin.sec_all_hidden_desc')}
              action={{ label: t('admin.sec_reset'), onClick: reset, variant: 'secondary' }}
            />
  )
}

export function Part6({ hiddenAvailable, show, visible, t }: { hiddenAvailable: NonNullable<DashboardSection['hiddenAvailable']>; show: NonNullable<DashboardSection['show']>; visible: NonNullable<DashboardSection['visible']>; t: NonNullable<DashboardSection['tr']> }) {
  return (
    <>{hiddenAvailable.map(id => {
                    const def = panelDef(id)
                    if (!def) return null
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => show(id, visible)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-0
                                     px-2.5 py-1.5 text-text-secondary hover:bg-surface-2"
                          style={{ fontSize: 'var(--kb-text-body)' }}
                        >
                          <Plus size={14} aria-hidden />
                          {t(def.titleKey)}
                        </button>
                      </li>
                    )
                  })}</>
  )
}
