/**
 * The parts of `StepperDemo.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Stepper } from "@ui"
import type { StepperDemo } from './StepperDemo'

export function Part1({ t, resolved, wizard, steps }: { t: NonNullable<StepperDemo['tr']>; resolved: NonNullable<StepperDemo['resolved']>; wizard: NonNullable<StepperDemo['wizard']>; steps: NonNullable<StepperDemo['steps']> }) {
  return (
    <Stepper t={t} steps={resolved} current={wizard.id} onStepChange={wizard.goTo}>
            <div className="rounded-lg border border-border bg-surface-1 p-4 text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
              {t('admin.t_prev_st_panel', { defaultValue: 'Contenu de l’étape' })} « {steps[wizard.index].label} »
            </div>
          </Stepper>
  )
}

export function Part2({ t, resolved, wizard }: { t: NonNullable<StepperDemo['tr']>; resolved: NonNullable<StepperDemo['resolved']>; wizard: NonNullable<StepperDemo['wizard']> }) {
  return (
    <Stepper t={t} steps={resolved} current={wizard.id} orientation="vertical" onStepChange={wizard.goTo} className="max-w-xs" />
  )
}
