/**
 * Code-behind of `SupportCard.kbcontrol` (converted from `SupportCard.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../core/hooks/useConfirm"
import { errorMessage, useRegisterSupportKey, useRemoveSupportKey, type SupportInfo } from "./api"

import { ViewBase } from './SupportCard.kbcontrol'
import * as __parts from './SupportCard.parts'

export type SupportCardProps = {
  support:   SupportInfo
  canManage: boolean
}

export class SupportCard extends ViewBase {
  @bind accessor formOpen = false
  @bind accessor draft = ''
  @bind accessor error: string | null = null
  tr!: SupportCardStores['t']
  i18n!: SupportCardStores['i18n']
  confirm!: SupportCardStores['confirm']
  confirmState!: SupportCardStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  register!: SupportCardStores['register']
  remove!: SupportCardStores['remove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const register = useRegisterSupportKey()
    const remove = useRemoveSupportKey()
    return { t, i18n, confirm, confirmState, handleConfirm, handleCancel, register, remove }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, register: s.register, remove: s.remove })
  }

  get contract() {
    return this.memo('contract', [this.props], () => this.props.support.contract)
  }

  get show_can_manage_contract() {
    return this.memo('show_can_manage_contract', [this.props, this.contract], () => !!(this.props.canManage && this.contract))
  }

  get show_not_can_manage_contract() {
    return this.memo('show_not_can_manage_contract', [this.props, this.contract], () => !(this.props.canManage && this.contract))
  }

  get show_contract() {
    return this.memo('show_contract', [this.contract], () => !!(this.contract))
  }

  get show_not_contract() {
    return this.memo('show_not_contract', [this.contract], () => !(this.contract))
  }

  /** `<ContractDetails>`, rendered by a ReactHost. */
  get ContractDetails() {
    if (!(this.contract)) return undefined as never
    return __parts.ContractDetails
  }

  get contract_details_props() {
    return this.memo('contract_details_props', [this.contract, this.i18n, this.props], () => {
      if (!(this.contract)) return undefined as never
      return ({ contract: this.contract, locale: this.i18n.language, verificationAvailable: this.props.support.verification_available })
    })
  }

  /** `<CommunitySupport>`, rendered by a ReactHost. */
  get CommunitySupport() {
    if (!(!(this.contract))) return undefined as never
    return __parts.CommunitySupport
  }

  get community_support_props() {
    return this.memo('community_support_props', [this.props, this.contract], () => {
      if (!(!(this.contract))) return undefined as never
      return ({ support: this.props.support })
    })
  }

  get show_not_form_open() {
    if (!(this.props.canManage)) return undefined as never
    return !(this.formOpen)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.draft, this.memo, this.props, this.formOpen], () => {
      if (!(this.props.canManage) || !(this.formOpen)) return undefined as never
      return ({ t: this.tr, draft: this.draft, setDraft: this.memo("setDraft:bound", [], () => this.setDraft.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<TextArea> spellCheck, autoComplete: no .kbview property). */
  get Part1() {
    if (!(this.props.canManage) || !(this.formOpen)) return undefined as never
    return __parts.Part1
  }

  get enabled_unless_draft_trim() {
    if (!(this.props.canManage) || !(this.formOpen)) return undefined as never
    return !(!this.draft.trim())
  }

  get button_text() {
    if (!(this.props.canManage) || !(!(this.formOpen))) return undefined as never
    return this.contract ? this.tr('admin.sub_key_replace') : this.tr('admin.sub_key_add')
  }

  get show_contract_form_open() {
    if (!(this.props.canManage)) return undefined as never
    return !this.contract && !this.formOpen
  }

  get show_error() {
    if (!(this.props.canManage)) return undefined as never
    return !!(this.error)
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState], () => !!(this.confirmState))
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel], () => {
      if (!(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  async submit() {
    this.error = null
    try {
      await this.register.mutateAsync(this.draft.trim())
      this.draft = ''
      this.formOpen = false
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.sub_key_failed'))
    }
  }

  async askRemove() {
    const ok = await this.confirm({
      title:       this.tr('admin.sub_remove_title'),
      message:     this.tr('admin.sub_remove_message'),
      confirmLabel: this.tr('admin.sub_remove_confirm'),
      variant:     'danger',
    })
    if (!ok) return
    this.error = null
    try {
      await this.remove.mutateAsync()
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.sub_remove_failed'))
    }
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.props.canManage && this.contract)) return undefined as never
    void this.askRemove()
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.props.canManage) || !(this.formOpen)) return undefined as never
    void this.submit()
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.props.canManage) || !(this.formOpen)) return undefined as never
 this.formOpen = false; this.draft = ''; this.error = null }

  button_click4(_sender: unknown, _args: MouseEventArgs) {
    if (!(this.props.canManage) || !(!(this.formOpen))) return undefined as never
    this.formOpen = true
  }

  /** `setDraft` of the TSX: a value, or an update of the previous one. */
  setDraft(value: SupportCard['draft'] | ((prev: SupportCard['draft']) => SupportCard['draft'])) {
    this.draft = typeof value === 'function' ? (value as (prev: SupportCard['draft']) => SupportCard['draft'])(this.draft) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SupportCardStores = ReturnType<SupportCard['useStores']>

export default SupportCard.component()
