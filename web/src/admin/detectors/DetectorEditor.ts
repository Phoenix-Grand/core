/**
 * Code-behind of `DetectorEditor.kbcontrol` (converted from `DetectorEditor.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs, type ValueChangedEventArgs } from '@kubuno/views'
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { type ComboboxOption } from "@ui"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { errorMessage, useCreateDetector, useDetector, useUpdateDetector, type ChecksumAlgo, type Detector, type DetectorInput, type DetectorKind, type DetectorLimits } from "./api"
import { useAdminCrumbs } from "../pages/AdminBreadcrumb"

import { ViewBase } from './DetectorEditor.kbcontrol'
import * as __parts from './DetectorEditor.parts'

const KINDS: DetectorKind[] = ['regex', 'wordlist', 'checksum']

const CHECKSUMS: ChecksumAlgo[] = ['luhn', 'iban', 'nir', 'siret', 'rib_fr']

const CATEGORIES = ['identity', 'finance', 'contact', 'technical', 'secret', 'other']

interface Props {
  /** `null` creates a new detector. */
  id:      string | null
  limits?: DetectorLimits
  onClose: () => void
}

interface Form {
  key:                string
  label:              string
  description:        string
  category:           string
  kind:               DetectorKind
  pattern:            string
  terms:              string
  checksum:           ChecksumAlgo | ''
  proximity_terms:    string
  proximity_window:   number
  proximity_required: boolean
  base_confidence:    number
  checksum_bonus:     number
  proximity_bonus:    number
  min_confidence:     number
  min_matches:        number
  min_unique_matches: number
  is_enabled:         boolean
}

const BLANK: Form = {
  key: '', label: '', description: '', category: 'other', kind: 'regex',
  pattern: '', terms: '', checksum: '', proximity_terms: '', proximity_window: 120,
  proximity_required: false, base_confidence: 0.5, checksum_bonus: 0.35,
  proximity_bonus: 0.2, min_confidence: 0.7, min_matches: 1, min_unique_matches: 1,
  is_enabled: true,
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function formOf(d: Detector): Form {
  return {
    key: d.key,
    label: d.label,
    description: d.description ?? '',
    category: d.category,
    kind: d.kind,
    pattern: d.pattern ?? '',
    // One term per line: a comma is a legitimate character inside a term, and a
    // separator a term may contain is a separator that eventually splits one.
    terms: d.terms.join('\n'),
    checksum: d.checksum ?? '',
    proximity_terms: d.proximity_terms.join('\n'),
    proximity_window: d.proximity_window,
    proximity_required: d.proximity_required,
    base_confidence: round2(d.base_confidence),
    checksum_bonus: round2(d.checksum_bonus),
    proximity_bonus: round2(d.proximity_bonus),
    min_confidence: round2(d.min_confidence),
    min_matches: d.min_matches,
    min_unique_matches: d.min_unique_matches,
    is_enabled: d.is_enabled,
  }
}

function lines(raw: string): string[] {
  return raw.split('\n').map(s => s.trim()).filter(Boolean)
}

function inputOf(form: Form): DetectorInput {
  return {
    key: form.key.trim().toLowerCase(),
    label: form.label.trim(),
    description: form.description.trim() || null,
    category: form.category,
    kind: form.kind,
    pattern: form.kind === 'wordlist' ? null : form.pattern.trim() || null,
    terms: form.kind === 'wordlist' ? lines(form.terms) : [],
    checksum: form.kind === 'checksum' ? (form.checksum || null) : null,
    proximity_terms: lines(form.proximity_terms),
    proximity_window: form.proximity_window,
    proximity_required: form.proximity_required,
    base_confidence: form.base_confidence,
    checksum_bonus: form.checksum_bonus,
    proximity_bonus: form.proximity_bonus,
    min_confidence: form.min_confidence,
    min_matches: form.min_matches,
    min_unique_matches: form.min_unique_matches,
    is_enabled: form.is_enabled,
  }
}

export type { Props }

export class DetectorEditor extends ViewBase {
  @bind accessor error: string | null = null
  @bind accessor saved = false
  tr!: DetectorEditorStores['t']
  can!: DetectorEditorStores['can']
  data!: DetectorEditorHooks['data']
  isLoading!: boolean
  create!: DetectorEditorStores['create']
  update!: DetectorEditorStores['update']
  form!: Form
  setForm!: DetectorEditorStores['setForm']
  draftError!: string | null

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t }   = useTranslation()
    const { can } = usePrivileges()
    const create = useCreateDetector()
    const update = useUpdateDetector()
    const [form, setForm]   = useState<Form>(BLANK)
    const draftError = useMemo(() => {
      if (form.kind === 'wordlist' && lines(form.terms).length === 0) return t('admin.det_need_terms')
      if (form.kind !== 'wordlist' && !form.pattern.trim()) return t('admin.det_need_pattern')
      if (form.kind === 'checksum' && !form.checksum) return t('admin.det_need_checksum')
      if (form.proximity_required && lines(form.proximity_terms).length === 0) {
        return t('admin.det_need_proximity')
      }
      if (form.min_unique_matches > form.min_matches) return t('admin.det_unreachable_threshold')
      return null
    }, [form, t])
    return { t, can, create, update, form, setForm, draftError }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const setForm = this.setForm
    const { data, isLoading } = useDetector(this.props.id)
    this.publish({ data, isLoading })
    useEffect(() => {
      if (data?.detector) setForm(formOf(data.detector))
    }, [data])
    const id = this.props.id
    const detector = this.detector
    useAdminCrumbs(useMemo(
      () => (id ? [{ label: detector?.label ?? t('admin.det_edit') }] : []),
      [id, detector?.label, t],
    ))
    return { data, isLoading }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, can: s.can, create: s.create, update: s.update, form: s.form, setForm: s.setForm, draftError: s.draftError })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading })
  }

  get canManage(): boolean {
    return this.can(PRIV.RULES_MANAGE)
  }

  get detector(): Detector | undefined {
    return this.memo('detector', [this.data], () => this.data?.detector)
  }

  get usedBy(): string[] {
    return this.memo('usedBy', [this.data], () => this.data?.used_by ?? [])
  }

  get kindOptions(): ComboboxOption[] {
    return this.memo('kindOptions', [this.tr], () => KINDS.map(k => ({
    value: k,
    label: this.tr(`admin.det_kind_${k}`),
    description: this.tr(`admin.det_kind_${k}_help`),
  })))
  }

  get checksumOptions(): ComboboxOption[] {
    return this.memo('checksumOptions', [this.tr], () => [
    { value: '', label: this.tr('admin.det_sum_none') },
    ...CHECKSUMS.map(c => ({ value: c, label: this.tr(`admin.det_sum_${c}`) })),
  ])
  }

  get categoryOptions(): ComboboxOption[] {
    return this.memo('categoryOptions', [this.tr], () => CATEGORIES.map(c => ({
    value: c,
    label: this.tr(`admin.det_cat_${c}`),
  })))
  }

  get busy(): boolean {
    return this.create.isPending || this.update.isPending
  }

  get show_id() {
    return !this.props.id
  }

  get h1_text() {
    return this.props.id ? (this.detector?.label ?? this.tr('admin.det_edit')) : this.tr('admin.det_new')
  }

  get show_is_loading_id() {
    return !!(this.isLoading && this.props.id)
  }

  get show_error() {
    return !!(this.error)
  }

  get show_detector_is_builtin() {
    return !!(this.detector?.is_builtin)
  }

  get show_used_by() {
    return this.usedBy.length > 0
  }

  get callout_text() {
    if (!(this.usedBy.length > 0)) return undefined as never
    return this.usedBy.join(' · ')
  }

  get enabled_unless_can_manage() {
    return !(!this.canManage)
  }

  get enabled_unless_can_manage_detector_is() {
    return !(!this.canManage || !!this.detector?.is_builtin)
  }

  get show_form_kind_wordlist() {
    return this.form.kind === 'wordlist'
  }

  get show_not_form_kind_wordlist() {
    return !(this.form.kind === 'wordlist')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.form], () => {
      if (!(this.form.kind === 'wordlist')) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<label htmlFor>: attribute(s) without a .kbview property). */
  get Part1() {
    if (!(this.form.kind === 'wordlist')) return undefined as never
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.form, this.canManage, this.setForm], () => {
      if (!(this.form.kind === 'wordlist')) return undefined as never
      return ({ form: this.form, canManage: this.canManage, setForm: this.setForm })
    })
  }

  /** A part of the screen still written in React (<textarea> has no .kbview element yet). */
  get Part2() {
    if (!(this.form.kind === 'wordlist')) return undefined as never
    return __parts.Part2
  }

  get det_field_terms_hint_max() {
    if (!(this.form.kind === 'wordlist')) return undefined as never
    return this.props.limits?.terms ?? 200
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.form], () => {
      if (!(!(this.form.kind === 'wordlist'))) return undefined as never
      return ({ t: this.tr })
    })
  }

  /** A part of the screen still written in React (<label htmlFor>: attribute(s) without a .kbview property). */
  get Part3() {
    if (!(!(this.form.kind === 'wordlist'))) return undefined as never
    return __parts.Part3
  }

  get part4_props() {
    return this.memo('part4_props', [this.form, this.canManage, this.setForm], () => {
      if (!(!(this.form.kind === 'wordlist'))) return undefined as never
      return ({ form: this.form, canManage: this.canManage, setForm: this.setForm })
    })
  }

  /** A part of the screen still written in React (<textarea> has no .kbview element yet). */
  get Part4() {
    if (!(!(this.form.kind === 'wordlist'))) return undefined as never
    return __parts.Part4
  }

  get det_field_pattern_hint_max() {
    if (!(!(this.form.kind === 'wordlist'))) return undefined as never
    return this.props.limits?.pattern_len ?? 2000
  }

  get show_form_kind_checksum() {
    return this.form.kind === 'checksum'
  }

  get enabled_unless_can_manage2() {
    if (!(this.form.kind === 'checksum')) return undefined as never
    return !(!this.canManage)
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<label htmlFor>: attribute(s) without a .kbview property). */
  get Part5() {
    return __parts.Part5
  }

  get part6_props() {
    return this.memo('part6_props', [this.form, this.canManage, this.setForm], () => ({ form: this.form, canManage: this.canManage, setForm: this.setForm }))
  }

  /** A part of the screen still written in React (<textarea> has no .kbview element yet). */
  get Part6() {
    return __parts.Part6
  }

  get part7_props() {
    return this.memo('part7_props', [this.tr, this.form, this.canManage, this.setForm], () => ({ t: this.tr, form: this.form, canManage: this.canManage, setForm: this.setForm }))
  }

  /** A part of the screen still written in React (<TextField> min, max: no .kbview property). */
  get Part7() {
    return __parts.Part7
  }

  /** A part of the screen still written in React (<TextField> min, max, step: no .kbview property). */
  get Part8() {
    return __parts.Part8
  }

  /** A part of the screen still written in React (<TextField> min, max, step: no .kbview property). */
  get Part9() {
    return __parts.Part9
  }

  /** A part of the screen still written in React (<TextField> min, max, step: no .kbview property). */
  get Part10() {
    return __parts.Part10
  }

  /** A part of the screen still written in React (<TextField> min, max, step: no .kbview property). */
  get Part11() {
    return __parts.Part11
  }

  /** A part of the screen still written in React (<TextField> min, max: no .kbview property). */
  get Part12() {
    return __parts.Part12
  }

  /** A part of the screen still written in React (<TextField> min, max: no .kbview property). */
  get Part13() {
    return __parts.Part13
  }

  get detectorDraft(): DetectorInput | null {
    return this.memo('detectorDraft', [this.canManage, this.draftError, this.form], () => this.canManage && !this.draftError ? inputOf(this.form) : null)
  }

  get enabled_unless_busy() {
    if (!(this.canManage)) return undefined as never
    return !(this.busy)
  }

  async save() {
    this.error = null
    this.saved = false
    try {
      const input = inputOf(this.form)
      if (this.props.id) await this.update.mutateAsync({ id: this.props.id, input })
      else await this.create.mutateAsync(input)
      this.saved = true
      this.props.onClose()
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.det_save_failed'))
    }
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(!this.props.id)) return undefined as never
    this.props.onClose?.()
  }

  text_field_text_changed(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setForm(f => ({ ...f, label: e.target.value }))
  }

  text_field_text_changed2(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setForm(f => ({ ...f, key: e.target.value }))
  }

  text_field_text_changed3(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setForm(f => ({ ...f, description: e.target.value }))
  }

  combo_box_selected_value_changed(_sender: unknown, args: ValueChangedEventArgs) {
    const v = args.value as string
    this.setForm(f => ({ ...f, category: v }))
  }

  switch_checked_changed(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setForm(f => ({ ...f, is_enabled: e.target.checked }))
  }

  combo_box_selected_value_changed2(_sender: unknown, args: ValueChangedEventArgs) {
    const v = args.value as string
    this.setForm(f => ({ ...f, kind: v as DetectorKind }))
  }

  combo_box_selected_value_changed3(_sender: unknown, args: ValueChangedEventArgs) {
    if (!(this.form.kind === 'checksum')) return undefined as never
    const v = args.value as string
    this.setForm(f => ({ ...f, checksum: v as ChecksumAlgo | '' }))
  }

  switch_checked_changed2(_sender: unknown, args: EventArgs) {
    const e = args.native as React.ChangeEvent<HTMLInputElement, HTMLInputElement>
    this.setForm(f => ({ ...f, proximity_required: e.target.checked }))
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.canManage)) return undefined as never
    void this.save()
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.canManage)) return undefined as never
    this.props.onClose?.()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DetectorEditorStores = ReturnType<DetectorEditor['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type DetectorEditorHooks = ReturnType<DetectorEditor['useHooks']>

export default DetectorEditor.component()
