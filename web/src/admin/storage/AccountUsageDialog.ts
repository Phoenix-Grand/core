/**
 * Code-behind of `AccountUsageDialog.kbview` (converted from `AccountUsageDialog.tsx` by @kubuno/views-migrate).
 */
import { type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { useCategoryReading, useCategoryRules } from "./categories"
import { useAccountStorageUsage, type Consumer } from "./api"

import { ViewBase } from './AccountUsageDialog.kbview'
import * as __parts from './AccountUsageDialog.parts'

export type AccountUsageDialogProps = {
  account:      Consumer
  onClose:      () => void
  /** Offered only where the caller can actually write the quota. */
  onEditQuota?: () => void
}

export class AccountUsageDialog extends ViewBase {
  tr!: AccountUsageDialogStores['t']
  data!: AccountUsageDialogHooks['data']
  isLoading!: boolean
  isError!: boolean
  refetch!: AccountUsageDialogHooks['refetch']
  rules!: AccountUsageDialogHooks['rules']
  reading!: AccountUsageDialogHooks['reading']
  modules!: AccountUsageDialogHooks['modules']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const { data, isLoading, isError, refetch } = useAccountStorageUsage(this.props.account.id)
    this.publish({ data, isLoading, isError, refetch })
    const rules   = useCategoryRules(data?.catalog)
    this.publish({ rules })
    const reading = useCategoryReading(data?.categories, rules, t)
    this.publish({ reading })
    const modules = useMemo(
      () => [...(data?.modules ?? [])].sort(
        (a, b) => (b.held_bytes - a.held_bytes) || (b.billable_bytes - a.billable_bytes),
      ),
      [data],
    )
    this.publish({ modules })
    return { data, isLoading, isError, refetch, rules, reading, modules }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ data: h.data, isLoading: h.isLoading, isError: h.isError, refetch: h.refetch, rules: h.rules, reading: h.reading, modules: h.modules })
  }

  get name(): string {
    return this.props.account.display_name?.trim() || this.props.account.username
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.name, this.props, this.isLoading, this.isError, this.refetch, this.data, this.reading, this.modules, this.rules], () => ({ t: this.tr, name: this.name, onClose: this.props.onClose, onEditQuota: this.props.onEditQuota, isLoading: this.isLoading, isError: this.isError, refetch: this.refetch, data: this.data, account: this.props.account, reading: this.reading, modules: this.modules, rules: this.rules }))
  }

  /** A part of the screen still written in React (<FloatingWindow> actions.confirm: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AccountUsageDialogStores = ReturnType<AccountUsageDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type AccountUsageDialogHooks = ReturnType<AccountUsageDialog['useHooks']>

export default AccountUsageDialog.component()
