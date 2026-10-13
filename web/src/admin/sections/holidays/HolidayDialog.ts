/**
 * Code-behind of `HolidayDialog.kbview` (converted from `HolidayDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { formatDate, monthName, weekdayName } from "./ruleText"
import { errorMessage, useCreateHoliday, usePreviewRule, useUpdateHoliday, type Category, type Holiday, type HolidayInput, type Observance, type PreviewDate, type RuleKind, type RuleParams } from "./api"

import { ViewBase } from './HolidayDialog.kbview'
import * as __parts from './HolidayDialog.parts'

function defaultsFor(kind: RuleKind): RuleParams {
  switch (kind) {
    case 'fixed':       return { month: 1, day: 1 }
    case 'easter':      return { offset: 0, basis: 'gregorian' }
    case 'nth_weekday': return { month: 1, weekday: 1, nth: 1 }
    case 'dates':       return { dates: [] }
  }
}

export type HolidayDialogProps = {
  calendarId: string
  /** `null` creates. */
  holiday: Holiday | null
  onClose: () => void
}

export class HolidayDialog extends ViewBase {
  @bind accessor error: string | null = null
  @bind accessor preview: PreviewDate[] = []
  tr!: HolidayDialogStores['t']
  i18n!: HolidayDialogStores['i18n']
  name!: HolidayDialogHooks['name']
  setName!: HolidayDialogHooks['setName']
  category!: Category
  setCategory!: HolidayDialogHooks['setCategory']
  kind!: RuleKind
  setKind!: HolidayDialogHooks['setKind']
  rule!: RuleParams
  setRule!: HolidayDialogHooks['setRule']
  observance!: Observance
  setObservance!: HolidayDialogHooks['setObservance']
  fromYear!: string
  setFromYear!: HolidayDialogHooks['setFromYear']
  toYear!: string
  setToYear!: HolidayDialogHooks['setToYear']
  datesText!: HolidayDialogHooks['datesText']
  setDatesText!: HolidayDialogHooks['setDatesText']
  create!: HolidayDialogHooks['create']
  update!: HolidayDialogStores['update']
  runPreview!: HolidayDialogStores['runPreview']
  composed!: RuleParams

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const update  = useUpdateHoliday()
    const runPreview = usePreviewRule()
    return { t, i18n, update, runPreview }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const runPreview = this.runPreview
    const [name, setName]             = useState<string>(this.props.holiday?.name ?? '')
    this.publish({ name, setName })
    const [category, setCategory]     = useState<Category>(this.props.holiday?.category ?? 'public')
    this.publish({ category, setCategory })
    const [kind, setKind]             = useState<RuleKind>(this.props.holiday?.kind ?? 'fixed')
    this.publish({ kind, setKind })
    const [rule, setRule]             = useState<RuleParams>(this.props.holiday?.rule ?? defaultsFor('fixed'))
    this.publish({ rule, setRule })
    const [observance, setObservance] = useState<Observance>(this.props.holiday?.observance ?? 'none')
    this.publish({ observance, setObservance })
    const [fromYear, setFromYear]     = useState<string>(this.props.holiday?.from_year?.toString() ?? '')
    this.publish({ fromYear, setFromYear })
    const [toYear, setToYear]         = useState<string>(this.props.holiday?.to_year?.toString() ?? '')
    this.publish({ toYear, setToYear })
    const [datesText, setDatesText]   = useState<string>((this.props.holiday?.rule.dates ?? []).join('\n'))
    this.publish({ datesText, setDatesText })
    const create  = useCreateHoliday(this.props.calendarId)
    this.publish({ create })
    const composed: RuleParams = useMemo(() => {
      if (kind !== 'dates') return rule
      return {
        dates: datesText
          .split(/[\s,;]+/)
          .map(s => s.trim())
          .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)),
      }
    }, [kind, rule, datesText])
    this.publish({ composed })
    useEffect(() => {
      const timer = setTimeout(() => {
        runPreview.mutate(
          { kind, rule: composed, observance },
          { onSuccess: this.memo("setPreview:bound", [], () => this.setPreview.bind(this)), onError: () => this.preview = [] },
        )
      }, 250)
      return () => clearTimeout(timer)
      // `runPreview` is a stable mutation object; including it would re-run on
      // every render of the dialog.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind, JSON.stringify(composed), observance])
    return { name, setName, category, setCategory, kind, setKind, rule, setRule, observance, setObservance, fromYear, setFromYear, toYear, setToYear, datesText, setDatesText, create, composed }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, update: s.update, runPreview: s.runPreview })
    const h = this.useHooks()
    this.publish({ name: h.name, setName: h.setName, category: h.category, setCategory: h.setCategory, kind: h.kind, setKind: h.setKind, rule: h.rule, setRule: h.setRule, observance: h.observance, setObservance: h.setObservance, fromYear: h.fromYear, setFromYear: h.setFromYear, toYear: h.toYear, setToYear: h.setToYear, datesText: h.datesText, setDatesText: h.setDatesText, create: h.create, composed: h.composed })
  }

  get locale(): string {
    return this.i18n.language || 'fr'
  }

  get busy(): boolean {
    return this.create.isPending || this.update.isPending
  }

  get months(): { value: string; label: string; }[] {
    return this.memo('months', [this.locale], () => Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: monthName(this.locale, i + 1) })))
  }

  get weekdays(): { value: string; label: string; }[] {
    return this.memo('weekdays', [this.locale], () => Array.from({ length: 7  }, (_, i) => ({ value: String(i + 1), label: weekdayName(this.locale, i + 1) })))
  }

  get enabled_unless_busy_name_trim() {
    return !(this.busy || this.name.trim() === '')
  }

  get title() {
    return this.props.holiday ? this.tr('admin.hol_edit_day') : this.tr('admin.hol_new_day')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.name, this.setName], () => ({ t: this.tr, name: this.name, setName: this.setName }))
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.category, this.tr, this.setCategory], () => ({ category: this.category, t: this.tr, setCategory: this.setCategory }))
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part4() {
    return __parts.Part4
  }

  get part5_props() {
    return this.memo('part5_props', [this.kind, this.tr, this.setKind, this.setRule], () => ({ kind: this.kind, t: this.tr, setKind: this.setKind, setRule: this.setRule }))
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part5() {
    return __parts.Part5
  }

  get show_kind_fixed() {
    return this.kind === 'fixed'
  }

  get part6_props() {
    return this.memo('part6_props', [this.tr, this.kind], () => {
      if (!(this.kind === 'fixed')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part6() {
    if (!(this.kind === 'fixed')) return undefined as never
    return __parts.Part6
  }

  get part7_props() {
    return this.memo('part7_props', [this.rule, this.months, this.setRule, this.kind], () => {
      if (!(this.kind === 'fixed')) return undefined as never
      return ({ rule: this.rule, months: this.months, setRule: this.setRule })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part7() {
    if (!(this.kind === 'fixed')) return undefined as never
    return __parts.Part7
  }

  get value() {
    if (!(this.kind === 'fixed')) return undefined as never
    return this.rule.day ?? 1
  }

  get show_kind_easter() {
    return this.kind === 'easter'
  }

  get value2() {
    if (!(this.kind === 'easter')) return undefined as never
    return this.rule.offset ?? 0
  }

  get minimum() {
    if (!(this.kind === 'easter')) return undefined as never
    return -200
  }

  get part8_props() {
    return this.memo('part8_props', [this.tr, this.kind], () => {
      if (!(this.kind === 'easter')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part8() {
    if (!(this.kind === 'easter')) return undefined as never
    return __parts.Part8
  }

  get part9_props() {
    return this.memo('part9_props', [this.rule, this.tr, this.setRule, this.kind], () => {
      if (!(this.kind === 'easter')) return undefined as never
      return ({ rule: this.rule, t: this.tr, setRule: this.setRule })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part9() {
    if (!(this.kind === 'easter')) return undefined as never
    return __parts.Part9
  }

  get show_kind_nth_weekday() {
    return this.kind === 'nth_weekday'
  }

  get part10_props() {
    return this.memo('part10_props', [this.tr, this.kind], () => {
      if (!(this.kind === 'nth_weekday')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part10() {
    if (!(this.kind === 'nth_weekday')) return undefined as never
    return __parts.Part10
  }

  get part11_props() {
    return this.memo('part11_props', [this.rule, this.tr, this.setRule, this.kind], () => {
      if (!(this.kind === 'nth_weekday')) return undefined as never
      return ({ rule: this.rule, t: this.tr, setRule: this.setRule })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part11() {
    if (!(this.kind === 'nth_weekday')) return undefined as never
    return __parts.Part11
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part12() {
    if (!(this.kind === 'nth_weekday')) return undefined as never
    return __parts.Part12
  }

  get part13_props() {
    return this.memo('part13_props', [this.rule, this.weekdays, this.setRule, this.kind], () => {
      if (!(this.kind === 'nth_weekday')) return undefined as never
      return ({ rule: this.rule, weekdays: this.weekdays, setRule: this.setRule })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part13() {
    if (!(this.kind === 'nth_weekday')) return undefined as never
    return __parts.Part13
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part14() {
    if (!(this.kind === 'nth_weekday')) return undefined as never
    return __parts.Part14
  }

  get part15_props() {
    return this.memo('part15_props', [this.rule, this.months, this.setRule, this.kind], () => {
      if (!(this.kind === 'nth_weekday')) return undefined as never
      return ({ rule: this.rule, months: this.months, setRule: this.setRule })
    })
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part15() {
    if (!(this.kind === 'nth_weekday')) return undefined as never
    return __parts.Part15
  }

  get show_kind_dates() {
    return this.kind === 'dates'
  }

  get part16_props() {
    return this.memo('part16_props', [this.tr, this.kind], () => {
      if (!(this.kind === 'dates')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part16() {
    if (!(this.kind === 'dates')) return undefined as never
    return __parts.Part16
  }

  get part17_props() {
    return this.memo('part17_props', [this.datesText, this.setDatesText, this.kind], () => {
      if (!(this.kind === 'dates')) return undefined as never
      return ({ datesText: this.datesText, setDatesText: this.setDatesText })
    })
  }

  /** A part of the screen still written in React (<textarea> has no .kbview element yet). */
  get Part17() {
    if (!(this.kind === 'dates')) return undefined as never
    return __parts.Part17
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part18() {
    return __parts.Part18
  }

  get part19_props() {
    return this.memo('part19_props', [this.observance, this.tr, this.setObservance], () => ({ observance: this.observance, t: this.tr, setObservance: this.setObservance }))
  }

  /** A part of the screen still written in React (<Dropdown> width, height, focusable: no .kbview property). */
  get Part19() {
    return __parts.Part19
  }

  get part20_props() {
    return this.memo('part20_props', [this.tr, this.fromYear, this.setFromYear], () => ({ t: this.tr, fromYear: this.fromYear, setFromYear: this.setFromYear }))
  }

  /** A part of the screen still written in React (<TextField> inputMode: no .kbview property). */
  get Part20() {
    return __parts.Part20
  }

  get part21_props() {
    return this.memo('part21_props', [this.tr, this.toYear, this.setToYear], () => ({ t: this.tr, toYear: this.toYear, setToYear: this.setToYear }))
  }

  /** A part of the screen still written in React (<TextField> inputMode: no .kbview property). */
  get Part21() {
    return __parts.Part21
  }

  /** A part of the screen still written in React (<FieldLabel> is no .kbview element (../resources/FieldLabel#default)). */
  get Part22() {
    return __parts.Part22
  }

  get show_preview() {
    return this.preview.length === 0
  }

  get show_not_preview() {
    return !(this.preview.length === 0)
  }

  /** The rows of the Repeater over `preview`. */
  get rows_preview() {
    return this.memo('rows_preview', [this.preview, this.locale, this.tr], () => {
      if (!(!(this.preview.length === 0))) return undefined as never
      return this.preview.map((d) => {
      return { d, text: ((!(this.preview.length === 0))) ? (formatDate(this.locale, d.date)) : undefined, show_d_observed_from: ((!(this.preview.length === 0))) ? (!!(d.observed_from)) : undefined, span_text: ((!(this.preview.length === 0)) && (d.observed_from)) ? (String(' ') + this.tr('admin.hol_preview_moved', { from: formatDate(this.locale, d.observed_from) })) : undefined, key: `${d.year}-${d.date}` }
    })
    })
  }

  get show_holiday_is_builtin() {
    return !!(this.props.holiday?.is_builtin && !this.props.holiday.is_overridden)
  }

  get show_error() {
    return !!(this.error)
  }

  async submit() {
    this.error = null
    const input: HolidayInput = {
      name: this.name.trim(),
      category: this.category,
      kind: this.kind,
      rule: this.composed,
      observance: this.observance,
      from_year: this.fromYear.trim() === '' ? null : Number(this.fromYear),
      to_year:   this.toYear.trim() === ''   ? null : Number(this.toYear),
      color: this.props.holiday?.color ?? null,
    }
    try {
      if (this.props.holiday) await this.update.mutateAsync({ id: this.props.holiday.id, input })
      else         await this.create.mutateAsync(input)
      this.props.onClose()
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.hol_save_failed'))
    }
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
    void this.submit()
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

  numeric_field_value_changed(_sender: unknown, args: ValueChangedEventArgs) {
    if (!(this.kind === 'fixed')) return undefined as never
    const v = args.value as number
    this.setRule({ ...this.rule, day: v })
  }

  numeric_field_value_changed2(_sender: unknown, args: ValueChangedEventArgs) {
    if (!(this.kind === 'easter')) return undefined as never
    const v = args.value as number
    this.setRule({ ...this.rule, offset: v })
  }

  /** `setPreview` of the TSX: a value, or an update of the previous one. */
  setPreview(value: PreviewDate[] | ((prev: PreviewDate[]) => PreviewDate[])) {
    this.preview = typeof value === 'function' ? (value as (prev: PreviewDate[]) => PreviewDate[])(this.preview) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type HolidayDialogStores = ReturnType<HolidayDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type HolidayDialogHooks = ReturnType<HolidayDialog['useHooks']>

export default HolidayDialog.component()
