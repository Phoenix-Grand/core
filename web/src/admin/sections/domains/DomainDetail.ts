/**
 * Code-behind of `DomainDetail.kbcontrol` (converted from `DomainDetail.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useToast } from "@ui"
import ConfirmDialog from "@ui/ConfirmDialog"
import { useConfirm } from "../../../core/hooks/useConfirm"
import { useAdminCrumbs } from "../../pages/AdminBreadcrumb"
import DomainDiagnosticsCard from "./DomainDiagnosticsCard"
import { errorMessage, useDomainDetail, usePromoteDomain, useRemoveDomain, useVerifyDomain } from "./api"

import { ViewBase } from './DomainDetail.kbcontrol'
import * as __parts from './DomainDetail.parts'

export type DomainDetailProps = {
  domainId: string
  canManage: boolean
  /** Called after a removal, so the page can return to the list. */
  onGone: () => void
}

export class DomainDetail extends ViewBase {
  @bind accessor error: string | null = null
  tr!: DomainDetailStores['t']
  toast!: DomainDetailStores['toast']
  confirm!: DomainDetailStores['confirm']
  confirmState!: DomainDetailStores['confirmState']
  handleConfirm!: () => void
  handleCancel!: () => void
  data!: DomainDetailHooks['data']
  isLoading!: boolean
  verify!: DomainDetailStores['verify']
  promote!: DomainDetailStores['promote']
  remove!: DomainDetailStores['remove']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const toast = useToast()
    const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()
    const verify   = useVerifyDomain()
    const promote  = usePromoteDomain()
    const remove   = useRemoveDomain()
    return { t, toast, confirm, confirmState, handleConfirm, handleCancel, verify, promote, remove }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data, isLoading } = useDomainDetail(this.props.domainId)
    this.publish({ data, isLoading })
    useAdminCrumbs(useMemo(() => (this.name ? [{ label: this.name, title: this.name }] : []), [this.name]))
    return { data, isLoading }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, toast: s.toast, confirm: s.confirm, confirmState: s.confirmState, handleConfirm: s.handleConfirm, handleCancel: s.handleCancel, verify: s.verify, promote: s.promote, remove: s.remove })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading })
  }

  get domain() {
    return this.memo('domain', [this.data], () => this.data?.domain)
  }

  get name(): string {
    return this.domain?.name ?? ''
  }

  get blockers(): string[] {
    return this.memo('blockers', [this.data, this.isLoading, this.domain], () => {
      if (!(!(this.isLoading || !this.domain))) return undefined as never
      return this.data?.removal_blockers ?? []
    })
  }

  get show_case_1() {
    return !!(this.isLoading || !this.domain)
  }

  get show_main() {
    return !(this.isLoading || !this.domain)
  }

  get h2_text() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return this.domain.name
  }

  get show_domain_kind_primary() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return this.domain.kind === 'primary'
  }

  get show_domain_kind_secondary() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return this.domain.kind === 'secondary'
  }

  get show_domain_kind_alias() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return this.domain.kind === 'alias'
  }

  get dom_alias_of_name() {
    if (!(!(this.isLoading || !this.domain)) || !(this.domain.kind === 'alias')) return undefined as never
    return this.domain.parent_name
  }

  get show_domain_verified() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return this.domain.verified
  }

  get show_not_domain_verified() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return !(this.domain.verified)
  }

  get show_error() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return !!(this.error)
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.domain, this.props, this.verify, this.memo, this.error, this.toast, this.isLoading], () => {
      if (!(!(this.isLoading || !this.domain))) return undefined as never
      return ({ t: this.tr, domain: this.domain, domain_last_error: this.domain?.last_error, canManage: this.props.canManage, verify: this.verify, setError: this.memo("setError:bound", [], () => this.setError.bind(this)), toast: this.toast, fail: this.memo("fail:bound", [], () => this.fail.bind(this)), domain_last_checked_at: this.domain?.last_checked_at })
    })
  }

  /** A part of the screen still written in React (<Card> title: an object value for a text property). */
  get Part1() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return __parts.Part1
  }

  /** `<DomainDiagnosticsCard>`, rendered by a ReactHost. */
  get DomainDiagnosticsCard() {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    return DomainDiagnosticsCard
  }

  get domain_diagnostics_card_props() {
    return this.memo('domain_diagnostics_card_props', [this.domain, this.props, this.isLoading], () => {
      if (!(!(this.isLoading || !this.domain))) return undefined as never
      return ({ domain: this.domain, canManage: this.props.canManage })
    })
  }

  get show_domain_kind_secondary2() {
    if (!(!(this.isLoading || !this.domain)) || !(this.props.canManage)) return undefined as never
    return this.domain.kind === 'secondary'
  }

  get part2_props() {
    return this.memo('part2_props', [this.domain, this.promote, this.tr, this.confirm, this.memo, this.error, this.toast, this.isLoading, this.props], () => {
      if (!(!(this.isLoading || !this.domain)) || !(this.props.canManage) || !(this.domain.kind === 'secondary')) return undefined as never
      return ({ domain: this.domain, promote: this.promote, t: this.tr, confirm: this.confirm, setError: this.memo("setError:bound", [], () => this.setError.bind(this)), toast: this.toast, fail: this.memo("fail:bound", [], () => this.fail.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part2() {
    if (!(!(this.isLoading || !this.domain)) || !(this.props.canManage) || !(this.domain.kind === 'secondary')) return undefined as never
    return __parts.Part2
  }

  get show_blockers() {
    if (!(!(this.isLoading || !this.domain)) || !(this.props.canManage)) return undefined as never
    return this.blockers.length > 0
  }

  /** The rows of the Repeater over `blockers`. */
  get rows_blockers() {
    return this.memo('rows_blockers', [this.blockers, this.isLoading, this.domain, this.props], () => {
      if (!(!(this.isLoading || !this.domain)) || !(this.props.canManage) || !(this.blockers.length > 0)) return undefined as never
      return this.blockers.map((b) => {
      return { b, key: b }
    })
    })
  }

  get part3_props() {
    return this.memo('part3_props', [this.blockers, this.remove, this.confirm, this.tr, this.domain, this.memo, this.error, this.props, this.isLoading], () => {
      if (!(!(this.isLoading || !this.domain)) || !(this.props.canManage)) return undefined as never
      return ({ blockers: this.blockers, remove: this.remove, confirm: this.confirm, t: this.tr, domain: this.domain, setError: this.memo("setError:bound", [], () => this.setError.bind(this)), onGone: this.props.onGone, fail: this.memo("fail:bound", [], () => this.fail.bind(this)) })
    })
  }

  /** A part of the screen still written in React (<Button> with element children). */
  get Part3() {
    if (!(!(this.isLoading || !this.domain)) || !(this.props.canManage)) return undefined as never
    return __parts.Part3
  }

  get show_confirm_state() {
    return this.memo('show_confirm_state', [this.confirmState, this.isLoading, this.domain], () => {
      if (!(!(this.isLoading || !this.domain))) return undefined as never
      return !!(this.confirmState)
    })
  }

  /** `<ConfirmDialog>`, rendered by a ReactHost. */
  get ConfirmDialog() {
    if (!(!(this.isLoading || !this.domain)) || !(this.confirmState)) return undefined as never
    return ConfirmDialog
  }

  get confirm_dialog_props() {
    return this.memo('confirm_dialog_props', [this.confirmState, this.handleConfirm, this.handleCancel, this.isLoading, this.domain], () => {
      if (!(!(this.isLoading || !this.domain)) || !(this.confirmState)) return undefined as never
      return ({ ...this.confirmState, onConfirm: this.handleConfirm, onCancel: this.handleCancel })
    })
  }

  fail(e: unknown) {
    if (!(!(this.isLoading || !this.domain))) return undefined as never
    this.error = errorMessage(e, this.tr('admin.dom_save_failed'))
  }

  /** `setError` of the TSX: a value, or an update of the previous one. */
  setError(value: string | null | ((prev: string | null) => string | null)) {
    this.error = typeof value === 'function' ? (value as (prev: string | null) => string | null)(this.error) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DomainDetailStores = ReturnType<DomainDetail['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type DomainDetailHooks = ReturnType<DomainDetail['useHooks']>

export default DomainDetail.component()
