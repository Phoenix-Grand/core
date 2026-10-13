/**
 * The parts of `RoomStatsTab.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { type ReactNode } from "react"
import { Clock } from "lucide-react"
import { Dropdown } from "@ui"
import { BarChart } from "../../controls/BarChart"
import HBarList from "../../controls/HBarList"
import type { RoomStatsTab } from './RoomStatsTab'

function StatCard({
  label, value, icon: Icon, accent,
}: {
  label:   string
  value:   ReactNode
  icon:    typeof Clock
  accent?: ReactNode
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-surface-0 p-4">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {label}
        </span>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2">
          {/* A theme token, never a literal: this card is painted in both themes. */}
          <Icon size={16} style={{ color: 'var(--kb-chart-1)' }} />
        </span>
      </div>
      <p className="font-semibold leading-tight text-text-primary tabular-nums"
         style={{ fontSize: 'var(--kb-text-title)' }}>
        {value}
      </p>
      {accent && (
        <div className="mt-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>{accent}</div>
      )}
    </div>
  )
}
export { StatCard }

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface-0 p-4">
      <h3 className="mb-3 text-text-primary" style={{ fontSize: 'var(--kb-text-section)' }}>{title}</h3>
      {children}
    </section>
  )
}
export { ChartCard }

export function Part1({ period, setPeriod, periodOptions }: { period: NonNullable<RoomStatsTab['period']>; setPeriod: NonNullable<RoomStatsTab['setPeriod']>; periodOptions: NonNullable<RoomStatsTab['periodOptions']> }) {
  return (
    <Dropdown value={period} onChange={setPeriod} options={periodOptions} width={200} focusable />
  )
}

export function Part2({ t, perDay, series }: { t: NonNullable<RoomStatsTab['tr']>; perDay: NonNullable<RoomStatsTab['perDay']>; series: NonNullable<RoomStatsTab['series']> }) {
  return (
    <ChartCard title={t('admin.rs_per_day')}>
                  <BarChart data={perDay} color={series[0]} unit="h" xLabels />
                </ChartCard>
  )
}

export function Part3({ t, perHour, series }: { t: NonNullable<RoomStatsTab['tr']>; perHour: NonNullable<RoomStatsTab['perHour']>; series: NonNullable<RoomStatsTab['series']> }) {
  return (
    <ChartCard title={t('admin.rs_per_hour')}>
                  <BarChart data={perHour} color={series[0]} unit="h" xLabels />
                </ChartCard>
  )
}

export function Part4({ t, rooms, series, topHours, nf1 }: { t: NonNullable<RoomStatsTab['tr']>; rooms: NonNullable<RoomStatsTab['rooms']>; series: NonNullable<RoomStatsTab['series']>; topHours: NonNullable<RoomStatsTab['topHours']>; nf1: NonNullable<RoomStatsTab['nf1']> }) {
  return (
    <ChartCard title={t('admin.rs_per_room')}>
                {rooms.length === 0 ? (
                  <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-body)' }}>
                    {t('admin.rs_per_room_empty')}
                  </p>
                ) : (
                  <HBarList
                    color={series[0]}
                    // The bar is a share of the busiest room, not of a limit: a
                    // full bar is the leader, not a room in trouble.
                    warnFull={false}
                    items={rooms.map(r => ({
                      label: r.name,
                      value: r.hours,
                      max:   topHours,
                      // The figure is written out beside the bar: a bar answers
                      // "which room is busiest", never "by how much".
                      sub:   t('admin.rs_room_sub', {
                        hours:    nf1.format(r.hours),
                        count:    r.bookings,
                      }),
                    }))}
                  />
                )}
              </ChartCard>
  )
}
