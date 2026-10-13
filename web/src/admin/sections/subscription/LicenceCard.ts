/**
 * Code-behind of `LicenceCard.kbcontrol` (converted from `LicenceCard.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import type { LicenceInfo } from "./api"

import { ViewBase } from './LicenceCard.kbcontrol'
import * as __parts from './LicenceCard.parts'

export type LicenceCardProps = { licence: LicenceInfo }

export class LicenceCard extends ViewBase {
  tr!: LicenceCardStores['t']

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
    return this.memo('part1_props', [this.props, this.tr], () => ({ licence: this.props.licence, t: this.tr }))
  }

  /** A part of the screen still written in React (<ExternalLink> is no .kbview element (./ExternalLink#ExternalLink)). */
  get Part1() {
    return __parts.Part1
  }

  /** A part of the screen still written in React (<ExternalLink> is no .kbview element (./ExternalLink#ExternalLink)). */
  get Part2() {
    return __parts.Part2
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type LicenceCardStores = ReturnType<LicenceCard['useStores']>

export default LicenceCard.component()
