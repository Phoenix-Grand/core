/**
 * Code-behind of `TabsTextGroup.kbcontrol` (converted from `TabsTextGroup.tsx` by @kubuno/views-migrate).
 */
import { bind } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { RichText } from "@ui"

import { ViewBase } from './TabsTextGroup.kbcontrol'
import * as __parts from './TabsTextGroup.parts'

export class TabsTextGroup extends ViewBase {
  @bind accessor tab = 'apercu'
  @bind accessor rich = '<p>Texte <strong>riche</strong></p>'
  tr!: TabsTextGroupStores['t']

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

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.tab, this.memo], () => ({ t: this.tr, tab: this.tab, setTab: this.memo("setTab:bound", [], () => this.setTab.bind(this)) }))
  }

  /** A part of the screen still written in React (<Tabs> tabs: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  /** `<RichText>`, rendered by a ReactHost. */
  get RichText() {
    return RichText
  }

  get rich_text_props() {
    return this.memo('rich_text_props', [this.rich, this.memo, this.tr], () => ({ value: this.rich, onChange: this.memo("setRich:bound", [], () => this.setRich.bind(this)), placeholder: this.tr('admin.t_prev_write', { defaultValue: 'Écrire…' }) }))
  }

  /** `setTab` of the TSX: a value, or an update of the previous one. */
  setTab(value: TabsTextGroup['tab'] | ((prev: TabsTextGroup['tab']) => TabsTextGroup['tab'])) {
    this.tab = typeof value === 'function' ? (value as (prev: TabsTextGroup['tab']) => TabsTextGroup['tab'])(this.tab) : value
  }

  /** `setRich` of the TSX: a value, or an update of the previous one. */
  setRich(value: TabsTextGroup['rich'] | ((prev: TabsTextGroup['rich']) => TabsTextGroup['rich'])) {
    this.rich = typeof value === 'function' ? (value as (prev: TabsTextGroup['rich']) => TabsTextGroup['rich'])(this.rich) : value
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type TabsTextGroupStores = ReturnType<TabsTextGroup['useStores']>

export default TabsTextGroup.component()
