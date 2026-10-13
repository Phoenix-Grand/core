/**
 * Code-behind of `ReportDocument.kbcontrol` (converted from `ReportDocument.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useChartSeries } from "../DashboardCharts"
import { useAdminModules } from "../adminModules"
import { useAdminCrumbs } from "../pages/AdminBreadcrumb"
import type { PanelDef, PanelPeriod } from "../panels/types"
import type { ReportPanel } from "./api"
import { csvFilename, downloadCsv, reportRows, toCsv } from "./csv"
import { formatInstant, useReportModel } from "./model"
import { useDetailItem } from "./ReportDetail"
import ReportHeader from "./ReportHeader"
import ReportSummary from "./ReportSummary"
import { useBreakdownItem, useSeriesItem } from "./ReportTables"
import { NO_WATERMARK } from "./paged/watermark"
import type { WatermarkSpec } from "./paged/watermark"
import CoverSheet from "./paged/CoverSheet"
import PagedPreview from "./paged/PagedPreview"
import { PAPER } from "./paged/geometry"
import type { Orientation } from "./paged/geometry"
import type { FlowItem } from "./paged/types"
import DonutChart from "../controls/DonutChart"
import HBarList from "../controls/HBarList"
import ProgressRing from "../controls/ProgressRing"
import { ReportSeriesChart } from "../pages/ReportSeriesChart"
import { CaveatBlock } from "./CaveatBlock"
import { MethodBlock } from "./MethodBlock"
import ReportBlock from "./ReportBlock"

import { ViewBase } from './ReportDocument.kbcontrol'
import * as __parts from './ReportDocument.parts'

const CHART_ENTRIES = 10

export type ReportDocumentProps = {
  def:      PanelDef
  panel:    ReportPanel
  period:   PanelPeriod
  periods:  string[]
  periodId: string
  onPeriod: (id: string) => void
  instance: string
  author:   string
}

export class ReportDocument extends ViewBase {
  @bind accessor paper = 'a4'
  @bind accessor orientation: Orientation = 'portrait'
  @bind accessor cover = false
  @bind accessor crumbH = 0
  @bind accessor barH = 0
  tr!: ReportDocumentStores['t']
  i18n!: ReportDocumentStores['i18n']
  series!: readonly string[]
  watermark!: WatermarkSpec
  setWatermark!: ReportDocumentStores['setWatermark']
  barRef!: ReportDocumentStores['barRef']
  modules!: ReportDocumentStores['modules']
  moduleName!: (id: string) => string
  model!: ReportDocumentHooks['model']
  generatedAt!: string
  periodOptions!: { value: string; label: string; }[]
  exportCsv!: () => void
  tones!: (key: string, i: number) => string
  seriesItem!: FlowItem
  breakdownItem!: FlowItem
  detailItem!: FlowItem | null

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const series = useChartSeries()
    const [watermark, setWatermark]     = useState<WatermarkSpec>(NO_WATERMARK)
    const barRef = useRef<HTMLDivElement>(null)
    const { data: modules } = useAdminModules()
    const moduleName = useCallback(
      (id: string) => modules?.find(m => m.id === id)?.display_name ?? id,
      [modules],
    )
    return { t, i18n, series, watermark, setWatermark, barRef, modules, moduleName }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const i18n = this.i18n
    const series = this.series
    const barRef = this.barRef
    const moduleName = this.moduleName
    useEffect(() => {
      const crumb = document.querySelector<HTMLElement>('[data-admin-crumbs]')
      const bar   = barRef.current
      if (!crumb || !bar) return
      const read = () => {
        this.crumbH = crumb.getBoundingClientRect().height
        this.barH = bar.getBoundingClientRect().height
      }
      read()
      const ro = new ResizeObserver(read)
      ro.observe(crumb)
      ro.observe(bar)
      return () => ro.disconnect()
    }, [])
    const model = useReportModel(
      this.props.def, this.props.panel, this.props.period,
      this.props.def.id === 'app_usage' ? moduleName : undefined,
    )
    this.publish({ model })
    const generatedAt = useMemo(
      () => formatInstant(new Date().toISOString(), i18n.language, this.props.period.timezone),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [i18n.language, this.props.period.timezone, this.props.periodId, this.props.def.id],
    )
    this.publish({ generatedAt })
    useAdminCrumbs(useMemo(() => [{ label: this.title, title: this.title }], [this.title]))
    const periodOptions = useMemo(
      () => (this.props.periods.length > 0 ? this.props.periods : [this.props.periodId]).map(id => ({
        value: id, label: t(`admin.sec_period_${id}`, { defaultValue: id }),
      })),
      [this.props.periods, this.props.periodId, t],
    )
    this.publish({ periodOptions })
    const exportCsv = useCallback(() => {
      const rows = reportRows(
        model,
        { instance: this.props.instance, title: this.title, about: this.about, periodLabel: this.periodLabel, generatedAt, generatedBy: this.props.author },
        {
          instance:  t('admin.rep_instance'),
          report:    t('admin.rep_document'),
          about:     t('admin.rep_about'),
          period:    t('admin.rep_period'),
          from:      t('admin.rep_from'),
          to:        t('admin.rep_to'),
          timezone:  t('admin.rep_timezone'),
          generated: t('admin.rep_generated'),
          by:        t('admin.rep_generated_by'),
          total:     t('admin.rep_total'),
          previous:  t('admin.rep_previous'),
          variation: t('admin.rep_variation'),
          series:    t('admin.rep_series'),
          bucket:    t('admin.rep_bucket'),
          value:     t('admin.rep_value'),
          breakdown: t('admin.rep_breakdown'),
          entry:     t('admin.rep_entry'),
          share:     t('admin.rep_share'),
          quota:     t('admin.rep_quota'),
          used:      t('admin.rep_used'),
          truncated: t('admin.rep_truncated', { count: model.breakdown.length }),
          none:      t('admin.rep_nothing'),
          // The records section, spelt here rather than in `csv.ts`: the file and
          // the page must carry the SAME sentences, and they can only do that if
          // one place translates them.
          detail:     t('admin.rep_detail'),
          detailNone: model.detail || !model.detailAbsent
            ? ''
            : t(`admin.rep_detail_none_${model.detailAbsent}`, {
                defaultValue: t('admin.rep_detail_none'),
              }),
          detailCount: model.detail
            ? t('admin.rep_detail_count', {
                listed: model.detail.rows.length.toLocaleString(i18n.language),
                total:  this.props.panel.total.toLocaleString(i18n.language),
              })
            : '',
          detailTruncated: model.detail?.truncated
            ? t('admin.rep_detail_truncated', {
                limit: model.detail.limit.toLocaleString(i18n.language),
              })
            : '',
        },
        i18n.language,
      )
      downloadCsv(csvFilename(this.props.def.id, this.props.periodId), toCsv(rows, i18n.language))
    }, [model, this.props.instance, this.title, this.about, this.periodLabel, generatedAt, this.props.author, t, i18n.language, this.props.def.id, this.props.periodId, this.props.panel.total])
    this.publish({ exportCsv })
    const tones = useCallback(
      (key: string, i: number) => this.props.def.sliceTone?.(key) ?? series[i % series.length],
      [this.props.def, series],
    )
    this.publish({ tones })
    const seriesItem    = useSeriesItem(model)
    this.publish({ seriesItem })
    const breakdownItem = useBreakdownItem(model, tones)
    this.publish({ breakdownItem })
    const detailItem    = useDetailItem(model, this.props.panel.total)
    this.publish({ detailItem })
    return { model, generatedAt, periodOptions, exportCsv, tones, seriesItem, breakdownItem, detailItem }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, series: s.series, watermark: s.watermark, setWatermark: s.setWatermark, barRef: s.barRef, modules: s.modules, moduleName: s.moduleName })
    const h = this.useHooks()
    this.publish({ model: h.model, generatedAt: h.generatedAt, periodOptions: h.periodOptions, exportCsv: h.exportCsv, tones: h.tones, seriesItem: h.seriesItem, breakdownItem: h.breakdownItem, detailItem: h.detailItem })
  }

  get title(): string {
    return this.tr(this.props.def.titleKey)
  }

  get about(): string {
    return this.tr(this.props.def.aboutKey)
  }

  get periodLabel(): string {
    return this.tr(`admin.sec_period_${this.props.periodId}`, { defaultValue: this.props.periodId })
  }

  get chart() {
    return this.memo('chart', [this.props, this.title, this.series, this.model, this.tones], () => (() => {
    if (this.props.def.shape === 'gauge') {
      const capacity = this.props.panel.capacity ?? 0
      if (capacity <= 0) return null
      const pct = (this.props.panel.total / capacity) * 100
      return (
        <ProgressRing
          pct={pct}
          value={`${Math.round(pct)} %`}
          label={this.title}
          size={180}
          color={pct >= 90 ? 'var(--color-danger)' : this.series[0]}
          sub={`${this.model.fmt(this.props.panel.total)} / ${this.model.fmt(capacity)}`}
        />
      )
    }
    if (this.props.def.shape === 'donut') {
      if (this.model.breakdown.length === 0) return null
      return (
        <DonutChart
          size={180}
          centerValue={this.model.totalText}
          data={this.model.breakdown.map((s, i) => ({
            label: s.label,
            value: s.value,
            color: this.tones(s.key, i),
          }))}
        />
      )
    }
    if (this.props.def.shape === 'ranking') {
      if (this.model.breakdown.length === 0) return null
      const largest = Math.max(1, ...this.model.breakdown.map(s => s.value))
      // A ranking's height grows with its ENTRIES, not with the paper: sixteen
      // modules make a chart taller than a landscape sheet, which then prints
      // clipped. It is capped — and the cap is STATED, right under the chart,
      // with a pointer to the breakdown below, which stays exhaustive. A silent
      // truncation would read as "that is all there was".
      return (
        <HBarList
          color={this.series[0]}
          items={this.model.breakdown.slice(0, CHART_ENTRIES).map((s, i) => ({
            label: s.label,
            value: s.value,
            max:   s.capacity ?? largest,
            sub:   s.capacity ? `${s.text} / ${this.model.fmt(s.capacity)}` : s.text,
            color: this.tones(s.key, i),
          }))}
        />
      )
    }
    if (this.model.series.length === 0) return null
    return (
      <ReportSeriesChart
        shape={this.props.def.shape === 'area' ? 'area' : 'bars'}
        color={this.series[0]}
        unit={this.model.bytes ? this.model.fmt : undefined}
        data={this.model.series.map(r => ({ label: r.axis, value: r.value }))}
      />
    )
  })())
  }

  get secondChart() {
    return this.memo('secondChart', [this.props, this.model, this.series, this.tones], () => (() => {
    const timeShape = this.props.def.shape !== 'donut' && this.props.def.shape !== 'ranking' && this.props.def.shape !== 'gauge'
    if (timeShape) {
      if (this.model.breakdown.length < 2) return null
      const largest = Math.max(1, ...this.model.breakdown.map(s => s.value))
      return {
        titleKey: 'admin.rep_chart_breakdown',
        capped: this.model.breakdown.length > CHART_ENTRIES,
        node: (
          <HBarList
            color={this.series[0]}
            items={this.model.breakdown.slice(0, CHART_ENTRIES).map((s, i) => ({
              label: s.label,
              value: s.value,
              max:   largest,
              sub:   s.text,
              color: this.tones(s.key, i),
            }))}
          />
        ),
      }
    }
    if (this.model.series.length < 2) return null
    return {
      titleKey: 'admin.rep_chart_series',
      capped: false,
      node: (
        <ReportSeriesChart
          shape="area"
          color={this.series[0]}
          unit={this.model.bytes ? this.model.fmt : undefined}
          data={this.model.series.map(r => ({ label: r.axis, value: r.value }))}
        />
      ),
    }
  })())
  }

  get items(): FlowItem[] {
    return this.memo('items', [this.props, this.title, this.about, this.periodLabel, this.generatedAt, this.model, this.chart, this.tr, this.secondChart, this.i18n, this.seriesItem, this.breakdownItem, this.detailItem], () => [
    {
      kind: 'atom',
      id:   'head',
      node: (
        <ReportHeader
          instance={this.props.instance}
          title={this.title}
          about={this.about}
          periodLabel={this.periodLabel}
          generatedAt={this.generatedAt}
          generatedBy={this.props.author}
          model={this.model}
        />
      ),
    },
    // Read first, because it is what the rest of the document is FOR.
    { kind: 'atom', id: 'summary', node: <ReportSummary model={this.model} /> },
    ...(this.chart ? [{
      kind: 'atom' as const,
      id:   'chart',
      node: (
        <ReportBlock
          title={this.tr('admin.rep_chart')}
          note={this.model.breakdown.length > CHART_ENTRIES && (this.props.def.shape === 'ranking' || this.props.def.shape === 'donut')
            ? this.tr('admin.rep_chart_top', { count: CHART_ENTRIES, total: this.model.breakdown.length })
            : undefined}
        >
          {this.chart}
        </ReportBlock>
      ),
    }] : []),
    // ── The OTHER view ────────────────────────────────────────────────────
    // A time series answers "when", a breakdown answers "who" — and a report
    // that only ever draws one of the two leaves the other as a wall of rows.
    // So whichever the panel's own chart is, the complementary one is drawn
    // beside it when the data for it exists. Nothing here is a new measurement:
    // both come from the same model the tables print.
    ...(this.secondChart ? [{
      kind: 'atom' as const,
      id:   'chart2',
      node: (
        <ReportBlock
          title={this.tr(this.secondChart.titleKey)}
          note={this.secondChart.capped
            ? this.tr('admin.rep_chart_top', { count: CHART_ENTRIES, total: this.model.breakdown.length })
            : undefined}
        >
          {this.secondChart.node}
        </ReportBlock>
      ),
    }] : []),

    {
      kind: 'atom',
      id:   'figures',
      node: (
        <ReportBlock title={this.tr('admin.rep_figures')}>
          <dl className="grid grid-cols-3 gap-4">
            <div>
              <dt className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {this.tr('admin.rep_total')}
              </dt>
              <dd className="mt-0.5 tabular-nums text-text-primary" style={{ fontSize: 'var(--kb-text-title)' }}>
                {this.model.totalText}
              </dd>
            </div>
            <div>
              <dt className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {this.tr('admin.rep_previous')}
              </dt>
              <dd className="mt-0.5 tabular-nums text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                {this.model.snapshot ? this.tr('admin.dash_snapshot') : this.model.previousText}
              </dd>
              {!this.model.snapshot && (
                <dd className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                  {this.tr('admin.rep_window_value', { from: this.model.previousFrom, to: this.model.previousTo })}
                </dd>
              )}
            </div>
            <div>
              <dt className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {this.tr('admin.rep_variation')}
              </dt>
              <dd className="mt-0.5 tabular-nums text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                {/* No arrow and no colour here. On paper a red arrow is a grey
                    one, and "worse" is a judgement the card makes for a glance —
                    a document states the figure and lets the reader judge. */}
                {this.model.snapshot
                  ? this.tr('admin.rep_no_variation_snapshot')
                  : this.model.delta === null
                    ? this.tr('admin.rep_no_variation')
                    : `${this.model.delta > 0 ? '+' : ''}${this.model.delta.toLocaleString(this.i18n.language)} %`}
              </dd>
            </div>
          </dl>
        </ReportBlock>
      ),
    },
    this.seriesItem,
    this.breakdownItem,
    ...(this.detailItem ? [this.detailItem] : []),
    { kind: 'atom', id: 'method',  node: <MethodBlock source={this.props.panel.source} model={this.model} /> },
    { kind: 'atom', id: 'caveats', node: <CaveatBlock def={this.props.def} caveat={this.props.panel.caveat} /> },
  ])
  }

  get revision(): string {
    return [
    this.props.def.id, this.props.periodId, this.i18n.language, this.generatedAt,
    this.model.series.length, this.model.breakdown.length, this.model.detail?.rows.length ?? 0,
  ].join('|')
  }

  get part1_props() {
    return this.memo('part1_props', [this.barRef, this.crumbH, this.props, this.periodOptions, this.paper, this.memo, this.tr, this.orientation, this.cover, this.watermark, this.setWatermark, this.exportCsv], () => ({ barRef: this.barRef, crumbH: this.crumbH, periodId: this.props.periodId, onPeriod: this.props.onPeriod, periodOptions: this.periodOptions, paper: this.paper, setPaper: this.memo("setPaper:bound", [], () => this.setPaper.bind(this)), t: this.tr, orientation: this.orientation, setOrientation: this.memo("setOrientation:bound", [], () => this.setOrientation.bind(this)), cover: this.cover, setCover: this.memo("setCover:bound", [], () => this.setCover.bind(this)), watermark: this.watermark, setWatermark: this.setWatermark, exportCsv: this.exportCsv }))
  }

  /** A part of the screen still written in React (<div ref>: attribute(s) without a .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** `<PagedPreview>`, rendered by a ReactHost. */
  get PagedPreview() {
    return PagedPreview
  }

  get paged_preview_props() {
    return this.memo('paged_preview_props', [this.items, this.paper, this.orientation, this.revision, this.cover, this.watermark, this.crumbH, this.barH, this.memo, this.props, this.title, this.about, this.periodLabel, this.generatedAt, this.model, this.tr], () => ({ items: this.items, format: PAPER[this.paper] ?? PAPER.a4, orientation: this.orientation, revision: `${this.revision}|${this.cover}`, watermark: this.watermark, bandHeight: this.crumbH + this.barH, onToggleCover: () => this.cover = !this.cover, onOrientation: this.memo("setOrientation:bound", [], () => this.setOrientation.bind(this)), cover: this.cover ? (
          <CoverSheet
            instance={this.props.instance}
            title={this.title}
            about={this.about}
            periodLabel={this.periodLabel}
            generatedAt={this.generatedAt}
            generatedBy={this.props.author}
            model={this.model}
          />
        ) : undefined, footer: this.memo("footer:bound", [], () => this.footer.bind(this)) } as React.ComponentProps<typeof PagedPreview>))
  }

  footer(page: number, total: number) {
    return (
    <>
      <span>{this.tr('admin.rep_footer', { instance: this.props.instance, date: this.generatedAt })}</span>
      <span>{this.tr('admin.rep_page_of', { page, total })}</span>
    </>
  )
  }

  /** `setPaper` of the TSX: a value, or an update of the previous one. */
  setPaper(value: ReportDocument['paper'] | ((prev: ReportDocument['paper']) => ReportDocument['paper'])) {
    this.paper = typeof value === 'function' ? (value as (prev: ReportDocument['paper']) => ReportDocument['paper'])(this.paper) : value
  }

  /** `setOrientation` of the TSX: a value, or an update of the previous one. */
  setOrientation(value: Orientation | ((prev: Orientation) => Orientation)) {
    this.orientation = typeof value === 'function' ? (value as (prev: Orientation) => Orientation)(this.orientation) : value
  }

  /** `setCover` of the TSX: a value, or an update of the previous one. */
  setCover(value: ReportDocument['cover'] | ((prev: ReportDocument['cover']) => ReportDocument['cover'])) {
    this.cover = typeof value === 'function' ? (value as (prev: ReportDocument['cover']) => ReportDocument['cover'])(this.cover) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ReportDocumentStores = ReturnType<ReportDocument['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ReportDocumentHooks = ReturnType<ReportDocument['useHooks']>

export default ReportDocument.component()
