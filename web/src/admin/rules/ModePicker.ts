/**
 * Code-behind of `ModePicker.kbcontrol` (converted from `ModePicker.tsx` by @kubuno/views-migrate).
 */
import { type ValueChangedEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { Ban, Eye, FlaskConical, ShieldAlert } from "lucide-react"
import { MODE_FACTS, MODE_ORDER, modeLabel, modeVariant } from "./labels"
import type { Mode } from "./types"

import { ViewBase } from './ModePicker.kbcontrol'
import * as __parts from './ModePicker.parts'

const GLYPH: Record<Mode, typeof Eye> = {
  inactive: Ban,
  simulate: FlaskConical,
  monitor:  Eye,
  enforce:  ShieldAlert,
}

interface Props {
  value:    Mode
  onChange: (mode: Mode) => void
  /** Modes the catalogue says are settable. Anything else is not offered. */
  modes:    Mode[]
  /** `enforce` needs at least one action — the server refuses it otherwise. */
  hasActions: boolean
  disabled?: boolean
}

export type { Props }

export class ModePicker extends ViewBase {
  tr!: ModePickerStores['t']

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

  get offered(): Mode[] {
    return this.memo('offered', [this.props], () => MODE_ORDER.filter(m => this.props.modes.includes(m)))
  }

  /** A part of the screen still written in React (<Glyph> is no .kbview element (a local or dynamic component)). */
  get Part1() {
    return __parts.Part1
  }

  /** The rows of the Repeater over `offered`. */
  get rows_offered() {
    return this.memo('rows_offered', [this.offered, this.props, this.tr], () => this.offered.map((mode) => {
      const facts = MODE_FACTS[mode]
      const Glyph = GLYPH[mode]
      const blocked = mode === 'enforce' && !this.props.hasActions
      const selected = this.props.value === mode
      return { mode, facts, Glyph, blocked, selected, label_class: `flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors
              ${selected ? 'border-primary bg-primary-light' : 'border-border bg-surface-0 hover:bg-surface-1'}
              ${blocked || this.props.disabled ? 'cursor-not-allowed opacity-60' : ''}`, enabled_unless_blocked_disabled: !(blocked || this.props.disabled), part1_props: { Glyph: Glyph }, span_text: modeLabel(this.tr, mode), variant: modeVariant(mode), badge_text: this.tr(facts.acts ? 'admin.rl_mode_tag_acts' : 'admin.rl_mode_tag_safe'), p_text: this.tr(`admin.rl_mode_${mode}_desc`), li_text: this.tr(facts.evaluates ? 'admin.rl_fact_evaluates_yes' : 'admin.rl_fact_evaluates_no'), li_text2: this.tr(facts.logs ? 'admin.rl_fact_logs_yes' : 'admin.rl_fact_logs_no'), li_text3: this.tr(facts.acts ? 'admin.rl_fact_acts_yes' : 'admin.rl_fact_acts_no'), li_text4: this.tr(`admin.rl_fact_alerts_${facts.alerts}`), key: mode }
    }))
  }

  radio_button_checked_changed(_sender: unknown, args: ValueChangedEventArgs) {
    const { mode, blocked } = args.row as RowOf_rows_offered
 if (!blocked && !this.props.disabled) this.props.onChange(mode) }

}

type RowOf_rows_offered = ModePicker['rows_offered'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ModePickerStores = ReturnType<ModePicker['useStores']>

export default ModePicker.component()
