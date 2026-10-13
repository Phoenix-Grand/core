/**
 * Code-behind of `ConditionTree.kbcontrol` (converted from `ConditionTree.tsx` by @kubuno/views-migrate).
 */
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { flatten, toWire, wireDepth, wireLeaves, type UiGroup, type Verdict } from "./condition"
import { leafQuotas, type LeafContext } from "./leafKinds"
import type { CondNode, RuleLimits } from "./types"

import { ViewBase } from './ConditionTree.kbcontrol'
import * as __parts from './ConditionTree.parts'

interface Props {
  root:      UiGroup
  onChange:  (next: UiGroup) => void
  ctx:       LeafContext
  limits:    RuleLimits
  /** Verdicts of the last test run, by node id. Absent ⇒ no test has run. */
  verdicts?: Record<string, Verdict>
  disabled?: boolean
}

function leafNodesOf(root: UiGroup): CondNode[] {
  return flatten(root).flatMap(n => (n.kind === 'leaf' ? [n.node] : []))
}

export type { Props }

export class ConditionTree extends ViewBase {
  tr!: ConditionTreeStores['t']
  depth!: number
  leaves!: number
  nodes!: number
  quotas!: ConditionTreeHooks['quotas']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const { depth, leaves, nodes } = useMemo(() => {
      const wire = toWire(this.props.root)
      return { depth: wireDepth(wire), leaves: wireLeaves(wire), nodes: flatten(this.props.root).length }
    }, [this.props.root])
    this.publish({ depth, leaves, nodes })
    const quotas = useMemo(() => leafQuotas(leafNodesOf(this.props.root), this.props.ctx, t), [this.props.root, this.props.ctx, t])
    this.publish({ quotas })
    return { depth, leaves, nodes, quotas }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ depth: h.depth, leaves: h.leaves, nodes: h.nodes, quotas: h.quotas })
  }

  get depthFull(): boolean {
    return this.depth >= this.props.limits.condition_depth
  }

  get leavesFull(): boolean {
    return this.leaves >= this.props.limits.condition_leaves
  }

  get span_class() {
    return this.depthFull ? 'text-warning' : 'text-text-tertiary'
  }

  get span_class2() {
    return this.leavesFull ? 'text-warning' : 'text-text-tertiary'
  }

  /** The rows of the Repeater over `quotas`. */
  get rows_quotas() {
    return this.memo('rows_quotas', [this.quotas], () => this.quotas.map((q) => {
      return { q, span_class: q.used >= q.max ? 'text-warning' : 'text-text-tertiary', key: q.type }
    }))
  }

  /** `<TreeNode>`, rendered by a ReactHost. */
  get TreeNode() {
    return __parts.TreeNode
  }

  get tree_node_props() {
    return this.memo('tree_node_props', [this.props], () => ({ node: this.props.root, root: this.props.root, onChange: this.props.onChange, ctx: this.props.ctx, limits: this.props.limits, verdicts: this.props.verdicts, disabled: this.props.disabled, depth: 0 }))
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ConditionTreeStores = ReturnType<ConditionTree['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ConditionTreeHooks = ReturnType<ConditionTree['useHooks']>

export default ConditionTree.component()
