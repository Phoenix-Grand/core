/**
 * The parts of `SettingsGroupPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Fragment } from "react"
import ProvenanceLine from "../controls/ProvenanceLine"
import SettingControl from "../pages/SettingControl"
import CaptchaPreview from "../pages/CaptchaPreview"
import type { SettingsGroupPanel } from './SettingsGroupPanel'

export function Part1({ section, visibleForBranch, currentValue, canManage, setEdits, update, highlight, highlightRef, revert, lock, setChainKey }: { section: NonNullable<SettingsGroupPanel['rows_sections']>[number]['section']; visibleForBranch: SettingsGroupPanel['visibleForBranch']; currentValue: SettingsGroupPanel['currentValue']; canManage: NonNullable<SettingsGroupPanel['canManage']>; setEdits: NonNullable<SettingsGroupPanel['setEdits']>; update: NonNullable<SettingsGroupPanel['update']>; highlight: SettingsGroupPanel['highlight']; highlightRef: NonNullable<SettingsGroupPanel['highlightRef']>; revert: NonNullable<SettingsGroupPanel['revert']>; lock: NonNullable<SettingsGroupPanel['lock']>; setChainKey: NonNullable<SettingsGroupPanel['setChainKey']> }) {
  return (
    <>{section.items.filter(visibleForBranch).map(s => (
                  <Fragment key={s.key}>
                    <SettingControl
                      setting={s}
                      value={currentValue(s)}
                      readOnly={s.locked_above || !canManage}
                      onCommit={v => {
                        setEdits(prev => ({ ...prev, [s.key]: v }))
                        update.mutate({ [s.key]: v })
                      }}
                      onDraft={v => setEdits(prev => ({ ...prev, [s.key]: v }))}
                      highlighted={highlight === s.key}
                      innerRef={highlight === s.key ? highlightRef : undefined}
                    >
                      <ProvenanceLine
                        setting={s}
                        onRevert={() => revert.mutate(s.key)}
                        onLock={locked => lock.mutate({ key: s.key, locked })}
                        onShowChain={() => setChainKey(s.key)}
                      />
                    </SettingControl>
                    {/* A live example of the chosen sign-in test, under its selector. */}
                    {s.key === 'security.captcha_type' && <CaptchaPreview />}
                  </Fragment>
                ))}</>
  )
}
