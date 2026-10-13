/**
 * Code-behind of `StepperDemo.kbcontrol` (converted from `StepperDemo.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { useStepper, type StepDef } from "@ui"

import { ViewBase } from './StepperDemo.kbcontrol'
import * as __parts from './StepperDemo.parts'

export class StepperDemo extends ViewBase {
  @bind accessor failing = false
  tr!: StepperDemoStores['t']
  wizard!: StepperDemoHooks['wizard']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const wizard = useStepper(this.steps)
    this.publish({ wizard })
    return { wizard }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ wizard: h.wizard })
  }

  get steps(): StepDef[] {
    return this.memo('steps', [this.tr], () => [
    { id: 'source',  label: this.tr('admin.t_prev_st_1', { defaultValue: 'Source' }),   description: this.tr('admin.t_prev_st_1d', { defaultValue: 'Annuaire ou CSV' }) },
    { id: 'mapping', label: this.tr('admin.t_prev_st_2', { defaultValue: 'Champs' }),   description: this.tr('admin.t_prev_st_2d', { defaultValue: 'Correspondances' }) },
    { id: 'rules',   label: this.tr('admin.t_prev_st_3', { defaultValue: 'Règles' }),   optional: true },
    { id: 'review',  label: this.tr('admin.t_prev_st_4', { defaultValue: 'Vérification' }) },
    { id: 'run',     label: this.tr('admin.t_prev_st_5', { defaultValue: 'Import' }) },
  ])
  }

  get resolved(): StepDef[] {
    return this.memo('resolved', [this.wizard, this.failing], () => this.wizard.resolved.map(s =>
    this.failing && s.id === 'mapping' ? { ...s, status: 'error' as const } : s))
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.resolved, this.wizard, this.steps], () => ({ t: this.tr, resolved: this.resolved, wizard: this.wizard, steps: this.steps }))
  }

  /** A part of the screen still written in React (<Stepper> steps: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get enabled_unless_wizard_is_first() {
    return !(this.wizard.isFirst)
  }

  get enabled_unless_wizard_is_last() {
    return !(this.wizard.isLast)
  }

  get button_text() {
    return this.failing
            ? this.tr('admin.t_prev_st_fix', { defaultValue: 'Corriger l’étape « Champs »' })
            : this.tr('admin.t_prev_st_break', { defaultValue: 'Mettre « Champs » en erreur' })
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.resolved, this.wizard], () => ({ t: this.tr, resolved: this.resolved, wizard: this.wizard }))
  }

  /** A part of the screen still written in React (<Stepper> steps: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    return (this.wizard.prev)?.()
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
    return (this.wizard.next)?.()
  }

  button_click3(_sender: unknown, _args: MouseEventArgs) {
    this.failing = !this.failing
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type StepperDemoStores = ReturnType<StepperDemo['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type StepperDemoHooks = ReturnType<StepperDemo['useHooks']>

export default StepperDemo.component()
