/**
 * The parts of `ConditionTester.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Textarea } from "@ui"
import type { ConditionTester } from './ConditionTester'

export function Part1({ text, setText, suggestion, t }: { text: NonNullable<ConditionTester['text']>; setText: NonNullable<ConditionTester['setText']>; suggestion: NonNullable<ConditionTester['suggestion']>; t: NonNullable<ConditionTester['tr']> }) {
  return (
    <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={suggestion}
            rows={8}
            spellCheck={false}
            className="font-mono"
            aria-label={t('admin.rl_test_fact')}
          />
  )
}
