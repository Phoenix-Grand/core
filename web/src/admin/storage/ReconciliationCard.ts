/**
 * Code-behind of `ReconciliationCard.kbcontrol` (converted from `ReconciliationCard.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import type { ModuleUsage, Reconciliation, ReconciliationBlocker } from "./api"

import { ViewBase } from './ReconciliationCard.kbcontrol'
import * as __parts from './ReconciliationCard.parts'

const BLOCKER_KEY: Record<ReconciliationBlocker, string> = {
  never_fully_synced: 'admin.sto_rec_blocker_never_synced',
  stale:              'admin.sto_rec_blocker_stale',
  no_declarant:       'admin.sto_rec_blocker_no_declarant',
}

export type ReconciliationCardProps = {
  data:       Reconciliation
  /** Only to put a display name on a blocking module id. */
  modules:    ModuleUsage[]
  staleHours: number
}

export class ReconciliationCard extends ViewBase {
  tr!: ReconciliationCardStores['t']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
  }

  get blocks() {
    return this.memo('blocks', [this.props], () => this.props.data.blocked_by ?? [])
  }

  get held() {
    return this.memo('held', [this.props], () => this.props.data.held_back ?? [])
  }

  get variant() {
    return this.props.data.enabled ? 'success' : 'default'
  }

  get badge_text() {
    return this.props.data.enabled ? this.tr('admin.sto_rec_on') : this.tr('admin.sto_rec_off')
  }

  get p_text() {
    return this.props.data.enabled ? this.tr('admin.sto_rec_on_desc') : this.tr('admin.sto_rec_off_desc')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.props], () => ({ t: this.tr, data: this.props.data }))
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part2() {
    return __parts.Part2
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Figure> is no .kbview element (./Figure#default)). */
  get Part4() {
    return __parts.Part4
  }

  get show_blocks() {
    return this.blocks.length > 0
  }

  /** The rows of the Repeater over `blocks`. */
  get rows_blocks() {
    return this.memo('rows_blocks', [this.blocks, this.props, this.tr], () => {
      if (!(this.blocks.length > 0)) return undefined as never
      return this.blocks.map((b, i) => {
      return { b, i, span_text: ((this.blocks.length > 0)) ? (b.module_id
                    ? this.nameOf(b.module_id)
                    : this.tr('admin.sto_rec_blocker_scope_instance')) : undefined, p_text: ((this.blocks.length > 0)) ? (this.tr(BLOCKER_KEY[b.blocker] ?? 'admin.sto_rec_blocker_unknown', {
                    hours: this.props.staleHours,
                    blocker: b.blocker,
                  })) : undefined, key: `${b.blocker}:${b.module_id}:${i}` }
    })
    })
  }

  get show_held() {
    return this.held.length > 0
  }

  get part5_props() {
    return this.memo('part5_props', [this.tr, this.held], () => {
      if (!(this.held.length > 0)) return undefined as never
      return ({ t: this.tr, held: this.held })
    })
  }

  /** A part of the screen still written in React (<Callout> with element children). */
  get Part5() {
    if (!(this.held.length > 0)) return undefined as never
    return __parts.Part5
  }

  get show_blocks_held_data() {
    return this.blocks.length === 0 && this.held.length === 0 && this.props.data.drifting_accounts > 0
  }

  nameOf(id: string) {
    return this.props.modules.find(m => m.module_id === id)?.display_name ?? id
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ReconciliationCardStores = ReturnType<ReconciliationCard['useStores']>

export default ReconciliationCard.component()
