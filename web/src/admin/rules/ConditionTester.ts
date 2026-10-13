/**
 * Code-behind of `ConditionTester.kbcontrol` (converted from `ConditionTester.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { flatten, verdictMap, type UiGroup, type Verdict } from "./condition"
import { sampleOfLeaf, type LeafContext } from "./leafKinds"
import type { TriggerRow } from "./types"

import { ViewBase } from './ConditionTester.kbcontrol'
import * as __parts from './ConditionTester.parts'

interface Props {
  root:    UiGroup
  ctx:     LeafContext
  trigger: TriggerRow | undefined
  /** Publishes the verdicts so the tree can paint itself. `null` clears them. */
  onVerdicts: (v: Record<string, Verdict> | null) => void
}

function mergeDeep(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v)
      && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      mergeDeep(target[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      target[k] = v
    }
  }
}

export type { Props }

export class ConditionTester extends ViewBase {
  @bind accessor text = ''
  @bind accessor error: string | null = null
  @bind accessor ran = false
  @bind accessor rootVerdict: Verdict | undefined = undefined
  tr!: ConditionTesterStores['t']
  suggestion!: string

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const trigger = this.props.trigger
    const suggestion = useMemo(() => {
      const facts: Record<string, unknown> = {}
      for (const node of flatten(this.props.root)) {
        if (node.kind === 'leaf') mergeDeep(facts, sampleOfLeaf(node.node, this.props.ctx))
      }
      // The three fields `rules::facts` adds to every fact, whatever the event.
      facts.event_type    = trigger?.event_type ?? 'UserCreated'
      facts.source_module = trigger?.module_id ?? 'core'
      facts.depth         = 0
      return JSON.stringify(facts, null, 2)
    }, [this.props.root, this.props.ctx, trigger])
    this.publish({ suggestion })
    return { suggestion }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ suggestion: h.suggestion })
  }

  get part1_props() {
    return this.memo('part1_props', [this.text, this.memo, this.suggestion, this.tr], () => ({ text: this.text, setText: this.memo("setText:bound", [], () => this.setText.bind(this)), suggestion: this.suggestion, t: this.tr }))
  }

  /** A part of the screen still written in React (<TextArea> rows, spellCheck: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get show_error() {
    return !!(this.error)
  }

  get show_ran_error() {
    return this.ran && !this.error
  }

  get variant() {
    if (!(this.ran && !this.error)) return undefined as never
    return this.rootVerdict === 'unknown' ? 'warning' : 'info'
  }

  get callout_text() {
    if (!(this.ran && !this.error)) return undefined as never
    return this.rootVerdict === 'unknown' ? this.tr('admin.rl_test_done_unknown') : this.tr('admin.rl_test_done')
  }

  run() {
    let parsed: unknown
    try {
      parsed = JSON.parse(this.text.trim() === '' ? this.suggestion : this.text)
    } catch {
      this.error = this.tr('admin.rl_test_bad_json')
      this.props.onVerdicts(null)
      this.ran = false
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.error = this.tr('admin.rl_test_not_object')
      this.props.onVerdicts(null)
      this.ran = false
      return
    }
    this.error = null
    const map = verdictMap(this.props.root, parsed)
    this.props.onVerdicts(map)
    this.rootVerdict = map[this.props.root.id]
    this.ran = true
  }

  clear() { this.props.onVerdicts(null); this.ran = false; this.error = null; this.rootVerdict = undefined }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    this.text = this.suggestion
  }

  /** `setText` of the TSX: a value, or an update of the previous one. */
  setText(value: ConditionTester['text'] | ((prev: ConditionTester['text']) => ConditionTester['text'])) {
    this.text = typeof value === 'function' ? (value as (prev: ConditionTester['text']) => ConditionTester['text'])(this.text) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ConditionTesterStores = ReturnType<ConditionTester['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ConditionTesterHooks = ReturnType<ConditionTester['useHooks']>

export default ConditionTester.component()
