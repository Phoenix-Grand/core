/**
 * The parts of `RuleEditor.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Callout, Stepper, Tabs } from "@ui"
import type { RuleEditor } from './RuleEditor'
type Pane = 'basics' | 'conditions' | 'actions' | 'scope' | 'mode' | 'impact' | 'history'

export function Part1({ t, leafProblems }: { t: NonNullable<RuleEditor['tr']>; leafProblems: NonNullable<RuleEditor['leafProblems']> }) {
  return (
    <Callout variant="danger" title={t('admin.rl_leaf_problems_title')}>
                <ul className="list-disc ps-4">
                  {leafProblems.map((message, i) => <li key={i}>{message}</li>)}
                </ul>
              </Callout>
  )
}

export function Part2({ steps, stepIndex, setPane, t, PANES, pane }: { steps: NonNullable<RuleEditor['steps']>; stepIndex: NonNullable<RuleEditor['stepIndex']>; setPane: NonNullable<RuleEditor['setPane']>; t: NonNullable<RuleEditor['tr']>; PANES: NonNullable<RuleEditor['PANES']>; pane: NonNullable<RuleEditor['pane']> }) {
  return (
    <Stepper
                  steps={steps}
                  current={stepIndex}
                  onStepChange={id => setPane(id as Pane)}
                  allowForward
                  t={t}
                >
                  <div className="pt-4">{PANES[pane]}</div>
                </Stepper>
  )
}

export function Part3({ tabs, pane, setPane, t }: { tabs: NonNullable<RuleEditor['tabs']>; pane: NonNullable<RuleEditor['pane']>; setPane: NonNullable<RuleEditor['setPane']>; t: NonNullable<RuleEditor['tr']> }) {
  return (
    <Tabs tabs={tabs} value={pane} onChange={v => setPane(v as Pane)} size="sm" t={t} />
  )
}
