/**
 * Code-behind of `InheritanceChainWindow.kbview` (converted from `InheritanceChainWindow.tsx` by @kubuno/views-migrate).
 */
import { type EventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../core/api/client"
import { scopeLabel } from "../controls/ProvenanceLine"
import type { ActiveScope, ChainResponse } from "../scopeTypes"

import { ViewBase } from './InheritanceChainWindow.kbview'
import * as __parts from './InheritanceChainWindow.parts.tsx'

export type InheritanceChainWindowProps = {
  settingKey: string
  scope:      ActiveScope
  onClose:    () => void
  /**
   * The name the control above used. Passed in rather than taken from the
   * server response so the window and the row it was opened from say the same
   * thing — the catalogue translates a key the database only stores once.
   */
  title?:     string
}

export class InheritanceChainWindow extends ViewBase {
  tr!: InheritanceChainWindowStores['t']
  data!: InheritanceChainWindowHooks['data']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data } = useQuery({
      queryKey: ['setting-chain', this.props.settingKey, this.props.scope.type, this.props.scope.id],
      queryFn: () =>
        api
          .get<ChainResponse>(`/admin/settings/chain/${encodeURIComponent(this.props.settingKey)}`, {
            params: { scope_type: this.props.scope.type, scope_id: this.props.scope.id ?? undefined },
          })
          .then(r => r.data),
    })
    this.publish({ data })
    return { data }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ data: h.data })
  }

  get title() {
    return this.props.title ?? this.data?.label ?? this.props.settingKey
  }

  /** A part of the screen still written in React (<li> with a computed style). */
  get Part1() {
    return __parts.Part1
  }

  /** The rows of the Repeater over `(data?.levels ?? [])`. */
  get rows_items() {
    return this.memo('rows_items', [this.data, this.tr], () => (this.data?.levels ?? []).map((l, i) => {
      return { l, i, part1_props: { l: l, i: i, t: this.tr }, key: `${l.scope_type}-${l.scope_id ?? 'x'}-${i}` }
    }))
  }

  get show_data_overrides() {
    return (this.data?.overrides.length ?? 0) > 0
  }

  get chain_overrides_intro_count() {
    if (!((this.data?.overrides.length ?? 0) > 0)) return undefined as never
    return this.data?.overrides.length ?? 0
  }

  /** The rows of the Repeater over `data?.overrides`. */
  get rows_overrides() {
    return this.memo('rows_overrides', [this.data, this.tr], () => {
      if (!((this.data?.overrides.length ?? 0) > 0)) return undefined as never
      return this.data?.overrides.map((o) => {
      return { o, span_text: (((this.data?.overrides.length ?? 0) > 0)) ? (scopeLabel(this.tr, o.scope_type, null)) : undefined, key: `${o.scope_type}-${o.scope_id}` }
    })
    })
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type InheritanceChainWindowStores = ReturnType<InheritanceChainWindow['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type InheritanceChainWindowHooks = ReturnType<InheritanceChainWindow['useHooks']>

export default InheritanceChainWindow.component()
