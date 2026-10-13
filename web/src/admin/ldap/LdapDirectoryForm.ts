/**
 * Code-behind of `LdapDirectoryForm.kbcontrol` (converted from `LdapDirectoryForm.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Network, KeyRound, Users, RefreshCw } from "lucide-react"
import type { ComboboxOption } from "@ui"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import type { OrgUnit } from "../../core/types"
import { DEFAULT_PORT, IS_DEFAULT_PORT, PRESETS, type DirectoryForm } from "./types"

import { ViewBase } from './LdapDirectoryForm.kbcontrol'
import * as __parts from './LdapDirectoryForm.parts'

export const StepIcons = { Network, KeyRound, Users, RefreshCw }

export type LdapDirectoryFormProps = {
  form: DirectoryForm
  setForm: (f: DirectoryForm) => void
  isEdit: boolean
  hasStoredPassword: boolean
  onSave: () => void
  onCancel: () => void
  saving: boolean
  onClearPassword?: () => void
}

export class LdapDirectoryForm extends ViewBase {
  @bind accessor step = 'connection'
  tr!: LdapDirectoryFormStores['t']
  unitOptions!: ComboboxOption[]
  securityOptions!: ComboboxOption[]
  scopeOptions!: ComboboxOption[]
  missingOptions!: ComboboxOption[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { data: orgUnits } = useQuery({
      queryKey: ['admin-org-units'],
      queryFn: () => api.get<{ org_units: OrgUnit[] }>('/admin/org-units').then(r => r.data.org_units),
      staleTime: 30_000,
    })
    const unitOptions: ComboboxOption[] = useMemo(
      () => [
        { value: '', label: t('ldap.unit_none'), description: t('ldap.unit_none_desc') },
        ...(orgUnits ?? []).map(u => ({ value: u.id, label: u.name })),
      ],
      [orgUnits, t],
    )
    const securityOptions: ComboboxOption[] = useMemo(
      () => [
        { value: 'starttls', label: t('ldap.sec_starttls'), description: t('ldap.sec_starttls_desc') },
        { value: 'ldaps', label: t('ldap.sec_ldaps'), description: t('ldap.sec_ldaps_desc') },
        { value: 'none', label: t('ldap.sec_none'), description: t('ldap.sec_none_desc') },
      ],
      [t],
    )
    const scopeOptions: ComboboxOption[] = useMemo(
      () => [
        { value: 'subtree', label: t('ldap.scope_subtree') },
        { value: 'onelevel', label: t('ldap.scope_onelevel') },
        { value: 'base', label: t('ldap.scope_base') },
      ],
      [t],
    )
    const missingOptions: ComboboxOption[] = useMemo(
      () => [
        { value: 'disable', label: t('ldap.missing_disable'), description: t('ldap.missing_disable_desc') },
        { value: 'ignore', label: t('ldap.missing_ignore'), description: t('ldap.missing_ignore_desc') },
      ],
      [t],
    )
    return { t, orgUnits, unitOptions, securityOptions, scopeOptions, missingOptions }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, unitOptions: s.unitOptions, securityOptions: s.securityOptions, scopeOptions: s.scopeOptions, missingOptions: s.missingOptions })
  }

  get canSave(): boolean {
    return this.props.form.slug.trim() !== '' &&
    this.props.form.display_name.trim() !== '' &&
    this.props.form.host.trim() !== '' &&
    this.props.form.base_dn.trim() !== '' &&
    this.props.form.user_filter.includes('{login}')
  }

  get steps(): { id: string; label: string; }[] {
    return this.memo('steps', [this.tr], () => [
    { id: 'connection', label: this.tr('ldap.step_connection') },
    { id: 'service', label: this.tr('ldap.step_service') },
    { id: 'mapping', label: this.tr('ldap.step_mapping') },
    { id: 'sync', label: this.tr('ldap.step_sync') },
  ])
  }

  get title() {
    return this.props.isEdit ? this.tr('ldap.edit_title', { name: this.props.form.display_name }) : this.tr('ldap.add_title')
  }

  get part1_props() {
    return this.memo('part1_props', [this.steps, this.step, this.memo, this.tr], () => ({ steps: this.steps, step: this.step, setStep: this.memo("setStep:bound", [], () => this.setStep.bind(this)), t: this.tr }))
  }

  /** A part of the screen still written in React (<Stepper> steps: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_step_connection() {
    return this.step === 'connection'
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.props, this.memo, this.step], () => {
      if (!(this.step === 'connection')) return undefined as never
      return ({ t: this.tr, form: this.props.form, isEdit: this.props.isEdit, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part2() {
    if (!(this.step === 'connection')) return undefined as never
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.props, this.memo, this.step], () => {
      if (!(this.step === 'connection')) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part3() {
    if (!(this.step === 'connection')) return undefined as never
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part4() {
    if (!(this.step === 'connection')) return undefined as never
    return __parts.Part4
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part5() {
    if (!(this.step === 'connection')) return undefined as never
    return __parts.Part5
  }

  get part6_props() {
    return this.memo('part6_props', [this.tr, this.props, this.memo, this.securityOptions, this.step], () => {
      if (!(this.step === 'connection')) return undefined as never
      return ({ t: this.tr, form: this.props.form, onSecurityChange: this.memo("onSecurityChange:bound", [], () => this.onSecurityChange.bind(this)), securityOptions: this.securityOptions })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part6() {
    if (!(this.step === 'connection')) return undefined as never
    return __parts.Part6
  }

  get show_form_security_none() {
    if (!(this.step === 'connection')) return undefined as never
    return this.props.form.security === 'none'
  }

  get show_form_security_none2() {
    if (!(this.step === 'connection')) return undefined as never
    return this.props.form.security !== 'none'
  }

  /** `<SwitchRow>`, rendered by a ReactHost. */
  get SwitchRow() {
    if (!(this.step === 'connection') || !(this.props.form.security !== 'none')) return undefined as never
    return __parts.SwitchRow
  }

  get switch_row_props() {
    return this.memo('switch_row_props', [this.tr, this.props, this.step], () => {
      if (!(this.step === 'connection') || !(this.props.form.security !== 'none')) return undefined as never
      return ({ label: this.tr('ldap.verify_certificate'), hint: this.tr('ldap.verify_certificate_hint'), checked: this.props.form.verify_certificate, onChange: v => this.set('verify_certificate', v) } as React.ComponentProps<typeof __parts.SwitchRow>)
    })
  }

  get show_form_verify_certificate() {
    if (!(this.step === 'connection') || !(this.props.form.security !== 'none')) return undefined as never
    return !this.props.form.verify_certificate
  }

  get part7_props() {
    return this.memo('part7_props', [this.tr, this.props, this.memo, this.step], () => {
      if (!(this.step === 'connection') || !(this.props.form.security !== 'none') || !(this.props.form.verify_certificate)) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part7() {
    if (!(this.step === 'connection') || !(this.props.form.security !== 'none') || !(this.props.form.verify_certificate)) return undefined as never
    return __parts.Part7
  }

  get visible() {
    return this.memo('visible', [this.show_form_verify_certificate, this.show_form_security_none2, this.step], () => {
      if (!(this.step === 'connection')) return undefined as never
      return this.show_form_verify_certificate && this.show_form_security_none2
    })
  }

  get visible2() {
    return this.memo('visible2', [this.props, this.show_form_security_none2, this.step], () => {
      if (!(this.step === 'connection')) return undefined as never
      return this.props.form.verify_certificate && this.show_form_security_none2
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part8() {
    if (!(this.step === 'connection')) return undefined as never
    return __parts.Part8
  }

  get show_step_service() {
    return this.step === 'service'
  }

  get part9_props() {
    return this.memo('part9_props', [this.tr, this.props, this.memo, this.step], () => {
      if (!(this.step === 'service')) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part9() {
    if (!(this.step === 'service')) return undefined as never
    return __parts.Part9
  }

  get part10_props() {
    return this.memo('part10_props', [this.tr, this.props, this.memo, this.step], () => {
      if (!(this.step === 'service')) return undefined as never
      return ({ t: this.tr, hasStoredPassword: this.props.hasStoredPassword, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part10() {
    if (!(this.step === 'service')) return undefined as never
    return __parts.Part10
  }

  get show_has_stored_password_on_clear_password() {
    return this.memo('show_has_stored_password_on_clear_password', [this.props, this.step], () => {
      if (!(this.step === 'service')) return undefined as never
      return !!(this.props.hasStoredPassword && this.props.onClearPassword)
    })
  }

  get enabled_unless_saving() {
    if (!(this.step === 'service') || !(this.props.hasStoredPassword && this.props.onClearPassword)) return undefined as never
    return !(this.props.saving)
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part11() {
    if (!(this.step === 'service')) return undefined as never
    return __parts.Part11
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part12() {
    if (!(this.step === 'service')) return undefined as never
    return __parts.Part12
  }

  get show_form_user_filter() {
    if (!(this.step === 'service')) return undefined as never
    return !this.props.form.user_filter.includes('{login}')
  }

  get part13_props() {
    return this.memo('part13_props', [this.tr, this.props, this.memo, this.scopeOptions, this.step], () => {
      if (!(this.step === 'service')) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)), scopeOptions: this.scopeOptions })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part13() {
    if (!(this.step === 'service')) return undefined as never
    return __parts.Part13
  }

  get show_step_mapping() {
    return this.step === 'mapping'
  }

  get part14_props() {
    return this.memo('part14_props', [this.tr, this.props, this.memo, this.step], () => {
      if (!(this.step === 'mapping')) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part14() {
    if (!(this.step === 'mapping')) return undefined as never
    return __parts.Part14
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part15() {
    if (!(this.step === 'mapping')) return undefined as never
    return __parts.Part15
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part16() {
    if (!(this.step === 'mapping')) return undefined as never
    return __parts.Part16
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part17() {
    if (!(this.step === 'mapping')) return undefined as never
    return __parts.Part17
  }

  get show_step_sync() {
    return this.step === 'sync'
  }

  /** `<SwitchRow>`, rendered by a ReactHost. */
  get SwitchRow2() {
    if (!(this.step === 'sync')) return undefined as never
    return __parts.SwitchRow
  }

  get switch_row_props2() {
    return this.memo('switch_row_props2', [this.tr, this.props, this.step], () => {
      if (!(this.step === 'sync')) return undefined as never
      return ({ label: this.tr('ldap.allow_signup'), hint: this.tr('ldap.allow_signup_hint'), checked: this.props.form.allow_signup, onChange: v => this.set('allow_signup', v) } as React.ComponentProps<typeof __parts.SwitchRow>)
    })
  }

  get part18_props() {
    return this.memo('part18_props', [this.tr, this.props, this.memo, this.unitOptions, this.step], () => {
      if (!(this.step === 'sync')) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)), unitOptions: this.unitOptions })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part18() {
    if (!(this.step === 'sync')) return undefined as never
    return __parts.Part18
  }

  get switch_row_props3() {
    return this.memo('switch_row_props3', [this.tr, this.props, this.step], () => {
      if (!(this.step === 'sync')) return undefined as never
      return ({ label: this.tr('ldap.sync_groups'), hint: this.tr('ldap.sync_groups_hint'), checked: this.props.form.sync_groups, onChange: v => this.set('sync_groups', v) } as React.ComponentProps<typeof __parts.SwitchRow>)
    })
  }

  get part19_props() {
    return this.memo('part19_props', [this.tr, this.props, this.memo, this.step], () => {
      if (!(this.step === 'sync') || !(this.props.form.sync_groups)) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part19() {
    if (!(this.step === 'sync') || !(this.props.form.sync_groups)) return undefined as never
    return __parts.Part19
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part20() {
    if (!(this.step === 'sync') || !(this.props.form.sync_groups)) return undefined as never
    return __parts.Part20
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part21() {
    if (!(this.step === 'sync') || !(this.props.form.sync_groups)) return undefined as never
    return __parts.Part21
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part22() {
    if (!(this.step === 'sync') || !(this.props.form.sync_groups)) return undefined as never
    return __parts.Part22
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part23() {
    if (!(this.step === 'sync') || !(this.props.form.sync_groups)) return undefined as never
    return __parts.Part23
  }

  get switch_row_props4() {
    return this.memo('switch_row_props4', [this.tr, this.props, this.step], () => {
      if (!(this.step === 'sync')) return undefined as never
      return ({ label: this.tr('ldap.sync_enabled'), hint: this.tr('ldap.sync_enabled_hint'), checked: this.props.form.sync_enabled, onChange: v => this.set('sync_enabled', v) } as React.ComponentProps<typeof __parts.SwitchRow>)
    })
  }

  get part24_props() {
    return this.memo('part24_props', [this.tr, this.props, this.memo, this.step], () => {
      if (!(this.step === 'sync') || !(this.props.form.sync_enabled)) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part24() {
    if (!(this.step === 'sync') || !(this.props.form.sync_enabled)) return undefined as never
    return __parts.Part24
  }

  get part25_props() {
    return this.memo('part25_props', [this.tr, this.props, this.memo, this.missingOptions, this.step], () => {
      if (!(this.step === 'sync')) return undefined as never
      return ({ t: this.tr, form: this.props.form, set: this.memo("set:bound", [], () => this.set.bind(this)), missingOptions: this.missingOptions })
    })
  }

  /** A part of the screen still written in React (<Field> is no .kbview element (a local or dynamic component)). */
  get Part25() {
    if (!(this.step === 'sync')) return undefined as never
    return __parts.Part25
  }

  get switch_row_props5() {
    return this.memo('switch_row_props5', [this.tr, this.props, this.step], () => {
      if (!(this.step === 'sync')) return undefined as never
      return ({ label: this.tr('ldap.enabled'), hint: this.tr('ldap.enabled_hint'), checked: this.props.form.enabled, onChange: v => this.set('enabled', v) } as React.ComponentProps<typeof __parts.SwitchRow>)
    })
  }

  get enabled_unless_can_save() {
    return !(!this.canSave)
  }

  get button_text() {
    return this.props.isEdit ? this.tr('common.save') : this.tr('ldap.create')
  }

  set<K extends keyof DirectoryForm>(key: K, value: DirectoryForm[K]) {
    return this.props.setForm({ ...this.props.form, [key]: value })
  }

  applyPreset(kind: 'standard' | 'ad') {
    return this.props.setForm({ ...this.props.form, ...PRESETS[kind] })
  }

  onSecurityChange(value: string) {
    const port = IS_DEFAULT_PORT(this.props.form.port) ? DEFAULT_PORT[value] ?? this.props.form.port : this.props.form.port
    this.props.setForm({ ...this.props.form, security: value, port })
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.step === 'connection')) return undefined as never
    this.applyPreset('standard')
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.step === 'connection')) return undefined as never
    this.applyPreset('ad')
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.step === 'service') || !(this.props.hasStoredPassword && this.props.onClearPassword)) return undefined as never
    this.props.onClearPassword?.()
  }

  button_click4(_sender: unknown, _args: MouseEventArgs) {
    this.props.onCancel?.()
  }

  button_click5(_sender: unknown, _args: MouseEventArgs) {
    this.props.onSave?.()
  }

  /** `setStep` of the TSX: a value, or an update of the previous one. */
  setStep(value: LdapDirectoryForm['step'] | ((prev: LdapDirectoryForm['step']) => LdapDirectoryForm['step'])) {
    this.step = typeof value === 'function' ? (value as (prev: LdapDirectoryForm['step']) => LdapDirectoryForm['step'])(this.step) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type LdapDirectoryFormStores = ReturnType<LdapDirectoryForm['useStores']>

export default LdapDirectoryForm.component()
