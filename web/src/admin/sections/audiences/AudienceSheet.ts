/**
 * Code-behind of `AudienceSheet.kbcontrol` (converted from `AudienceSheet.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useConfirm } from "../../../core/hooks/useConfirm"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useAudience, useAudienceMutations, type AudienceMember } from "./api"
import IdentityCard from "./IdentityCard"
import MemberPicker from "./MemberPicker"
import { useAdminCrumbs } from "../../pages/AdminBreadcrumb"

import { ViewBase } from './AudienceSheet.kbcontrol'
import * as __parts from './AudienceSheet.parts'

function errMessage(err: unknown): string | undefined {
  const e = err as { message?: string; response?: { data?: { message?: string } } }
  return e?.response?.data?.message ?? e?.message
}

export type AudienceSheetProps = {
  id: string; canManage: boolean
}

export class AudienceSheet extends ViewBase {
  @bind accessor adding = false
  tr!: AudienceSheetStores['t']
  data!: AudienceSheetHooks['data']
  isLoading!: boolean
  addMembers!: AudienceSheetHooks['addMembers']
  removeMembers!: AudienceSheetHooks['removeMembers']
  confirm!: AudienceSheetStores['confirm']
  confirmState!: AudienceSheetStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    return { t, confirm, confirmState, handleConfirm, handleCancel }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data, isLoading } = useAudience(this.props.id)
    this.publish({ data, isLoading })
    const { addMembers, removeMembers } = useAudienceMutations(this.props.id)
    this.publish({ addMembers, removeMembers })
    useAdminCrumbs(useMemo(
      () => (data ? [{ label: data.audience.name, title: data.audience.name }] : []),
      [data],
    ))
    return { data, isLoading, addMembers, removeMembers }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, addMembers: h.addMembers, removeMembers: h.removeMembers })
  }

  get a() {
    return this.memo('a', [this.data, this.isLoading], () => {
      if (!(!(this.isLoading || !this.data))) return undefined as never
      return this.data.audience
    })
  }

  get show_case_1() {
    return !!(this.isLoading || !this.data)
  }

  get show_main() {
    return !(this.isLoading || !this.data)
  }

  get show_not_a_is_everyone() {
    if (!(!(this.isLoading || !this.data))) return undefined as never
    return !(this.a.is_everyone)
  }

  get show_a_is_everyone() {
    if (!(!(this.isLoading || !this.data))) return undefined as never
    return !this.a.is_everyone
  }

  get span_text() {
    if (!(!(this.isLoading || !this.data)) || !(!this.a.is_everyone)) return undefined as never
    return this.tr('admin.aud_reach_of', {
              defaultValue_one: '{{count}} entrée · comptes atteints : {{reach}}',
              defaultValue: '{{count}} entrées · comptes atteints : {{reach}}',
              count: this.a.member_count, reach: this.a.reach,
            })
  }

  /** `<IdentityCard>`, rendered by a ReactHost. */
  get IdentityCard() {
    if (!(!(this.isLoading || !this.data))) return undefined as never
    return IdentityCard
  }

  get identity_card_props() {
    return this.memo('identity_card_props', [this.a, this.props, this.isLoading, this.data], () => {
      if (!(!(this.isLoading || !this.data))) return undefined as never
      return ({ audience: this.a, canManage: this.props.canManage })
    })
  }

  get show_not_can_manage() {
    if (!(!(this.isLoading || !this.data)) || !(!this.a.is_everyone)) return undefined as never
    return !(this.props.canManage)
  }

  get part1_props() {
    return this.memo('part1_props', [this.memo, this.adding, this.tr, this.isLoading, this.data, this.a, this.props], () => {
      if (!(!(this.isLoading || !this.data)) || !(!this.a.is_everyone) || !(this.props.canManage)) return undefined as never
      return ({ setAdding: this.memo("setAdding:bound", [], () => this.setAdding.bind(this)), t: this.tr })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part1() {
    if (!(!(this.isLoading || !this.data)) || !(!this.a.is_everyone) || !(this.props.canManage)) return undefined as never
    return __parts.Part1
  }

  get show_data_members() {
    if (!(!(this.isLoading || !this.data)) || !(!this.a.is_everyone)) return undefined as never
    return this.data.members.length === 0
  }

  get show_not_data_members() {
    if (!(!(this.isLoading || !this.data)) || !(!this.a.is_everyone)) return undefined as never
    return !(this.data.members.length === 0)
  }

  /** `<MemberRow>`, rendered by a ReactHost. */
  get MemberRow() {
    if (!(!(this.isLoading || !this.data)) || !(!this.a.is_everyone) || !(!(this.data.members.length === 0))) return undefined as never
    return __parts.MemberRow
  }

  /** The rows of the Repeater over `data.members`. */
  get rows_members() {
    return this.memo('rows_members', [this.data, this.isLoading, this.a, this.props, this.confirm, this.tr, this.removeMembers], () => {
      if (!(!(this.isLoading || !this.data)) || !(!this.a.is_everyone) || !(!(this.data.members.length === 0))) return undefined as never
      return this.data.members.map((m) => {
      return { m, member_row_props: ((!(this.isLoading || !this.data)) && (!this.a.is_everyone) && (!(this.data.members.length === 0))) ? ({ m: m, canManage: this.props.canManage, onRemove: () => void this.removeOne(m) } as React.ComponentProps<typeof __parts.MemberRow>) : undefined, key: `${m.member_type}:${m.member_id}` }
    })
    })
  }

  get show_data_applied() {
    if (!(!(this.isLoading || !this.data))) return undefined as never
    return this.data.applied.length === 0
  }

  get show_not_data_applied() {
    if (!(!(this.isLoading || !this.data))) return undefined as never
    return !(this.data.applied.length === 0)
  }

  /** The rows of the Repeater over `data.applied`. */
  get rows_applied() {
    return this.memo('rows_applied', [this.data, this.isLoading], () => {
      if (!(!(this.isLoading || !this.data)) || !(!(this.data.applied.length === 0))) return undefined as never
      return this.data.applied.map((p) => {
      return { p, show_p_position: ((!(this.isLoading || !this.data)) && (!(this.data.applied.length === 0))) ? (p.position === 0) : undefined, key: `${p.module_id}:${p.org_unit_id}` }
    })
    })
  }

  /** `<MemberPicker>`, rendered by a ReactHost. */
  get MemberPicker() {
    if (!(!(this.isLoading || !this.data)) || !(this.adding)) return undefined as never
    return MemberPicker
  }

  get member_picker_props() {
    return this.memo('member_picker_props', [this.data, this.addMembers, this.adding, this.props, this.isLoading], () => {
      if (!(!(this.isLoading || !this.data)) || !(this.adding)) return undefined as never
      return ({ already: this.data.members, busy: this.addMembers.isPending, error: errMessage(this.addMembers.error), onCancel: () => this.adding = false, onAdd: members => this.addMembers.mutate({ id: this.props.id, members }, { onSuccess: () => this.adding = false }) } as React.ComponentProps<typeof MemberPicker>)
    })
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isLoading, this.data], () => {
      if (!(!(this.isLoading || !this.data))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.isLoading || !this.data)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isLoading, this.data], () => {
      if (!(!(this.isLoading || !this.data)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  async removeOne(m: AudienceMember) {
    if (!(!(this.isLoading || !this.data))) return undefined as never
    const ok = await this.confirm({
      title: this.tr('admin.aud_remove_member_q', { defaultValue: 'Retirer « {{name}} » ?', name: m.label }),
      message: this.tr('admin.aud_remove_member_msg', {
        defaultValue: 'Cette audience cessera d’être proposée à ces personnes. Aucun partage déjà effectué n’est retiré.',
      }),
      confirmLabel: this.tr('common.remove', { defaultValue: 'Retirer' }),
      variant: 'danger',
    })
    if (ok) this.removeMembers.mutate({ id: this.props.id, members: [{ member_type: m.member_type, member_id: m.member_id }] })
  }

  /** `setAdding` of the TSX: a value, or an update of the previous one. */
  setAdding(value: AudienceSheet['adding'] | ((prev: AudienceSheet['adding']) => AudienceSheet['adding'])) {
    this.adding = typeof value === 'function' ? (value as (prev: AudienceSheet['adding']) => AudienceSheet['adding'])(this.adding) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AudienceSheetStores = ReturnType<AudienceSheet['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AudienceSheetHooks = ReturnType<AudienceSheet['useHooks']>

export default AudienceSheet.component()
