/**
 * The parts of `SecurityDashboardSection.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Check, Plus, SlidersHorizontal } from "lucide-react"
import { Button, Callout, Dropdown, EmptyState } from "@ui"
import PanelCard from "../panels/PanelCard"
import { panelDef } from "./panels"
import type { SecurityDashboardSection } from './SecurityDashboardSection'

function RetentionNotice({
  periodId, retention,
}: {
  periodId:  string
  retention: { audit_days: number; alerts_days: number; rule_executions_days: number }
}) {
  const { t } = useTranslation()
  const DAYS: Record<string, number> = {
    last_180_days: 180, last_90_days: 90, last_30_days: 30, last_7_days: 7,
  }
  const asked = DAYS[periodId] ?? 0
  const shortest = Math.min(retention.audit_days, retention.alerts_days, retention.rule_executions_days)
  if (asked <= shortest) return null
  return (
    <Callout variant="info" className="mb-4">
      {t('admin.sec_retention_notice', { days: asked, kept: shortest })}
    </Callout>
  )
}
export { RetentionNotice }

export function Part1({ period, setPeriod, periodOptions }: { period: NonNullable<SecurityDashboardSection['period']>; setPeriod: NonNullable<SecurityDashboardSection['setPeriod']>; periodOptions: NonNullable<SecurityDashboardSection['periodOptions']> }) {
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

export function Part2({ editing, setEditing, t }: { editing: NonNullable<SecurityDashboardSection['editing']>; setEditing: NonNullable<SecurityDashboardSection['setEditing']>; t: NonNullable<SecurityDashboardSection['tr']> }) {
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

export function Part3({ visible, received, bucket, editing, hide, move, openReport }: { visible: NonNullable<SecurityDashboardSection['visible']>; received: NonNullable<SecurityDashboardSection['received']>; bucket: NonNullable<SecurityDashboardSection['bucket']>; editing: NonNullable<SecurityDashboardSection['editing']>; hide: NonNullable<SecurityDashboardSection['hide']>; move: NonNullable<SecurityDashboardSection['move']>; openReport: NonNullable<SecurityDashboardSection['openReport']> }) {
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
                  />
                )
              })}</>
  )
}

export function Part4({ t, reset }: { t: NonNullable<SecurityDashboardSection['tr']>; reset: NonNullable<SecurityDashboardSection['reset']> }) {
  return (
    <EmptyState
              icon={<SlidersHorizontal size={28} />}
              title={t('admin.sec_all_hidden')}
              description={t('admin.sec_all_hidden_desc')}
              action={{ label: t('admin.sec_reset'), onClick: reset, variant: 'secondary' }}
            />
  )
}

export function Part5({ hiddenAvailable, show, visible, t }: { hiddenAvailable: NonNullable<SecurityDashboardSection['hiddenAvailable']>; show: NonNullable<SecurityDashboardSection['show']>; visible: NonNullable<SecurityDashboardSection['visible']>; t: NonNullable<SecurityDashboardSection['tr']> }) {
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
