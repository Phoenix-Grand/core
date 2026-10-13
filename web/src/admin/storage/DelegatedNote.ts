/**
 * Code-behind of `DelegatedNote.kbcontrol` (converted from `DelegatedNote.tsx` by @kubuno/views-migrate).
 */
import { useTranslation } from "react-i18next"
import { formatCount } from "./CategoryBreakdown"

import { ViewBase } from './DelegatedNote.kbcontrol'

export type DelegatedNoteProps = {
  bytes:    number
  objects:  number
  /** Changes only the wording; the arithmetic is the same everywhere: none. */
  scope?:   'instance' | 'module'
  className?: string
}

export class DelegatedNote extends ViewBase {
  tr!: DelegatedNoteStores['t']

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

  get scope() {
    return this.props.scope ?? 'instance'
  }

  get show_case_1() {
    return !!(this.props.objects <= 0 && this.props.bytes <= 0)
  }

  get show_main() {
    return !(this.props.objects <= 0 && this.props.bytes <= 0)
  }

  get div_class() {
    if (!(!(this.props.objects <= 0 && this.props.bytes <= 0))) return undefined as never
    return `rounded-lg border border-dashed border-border px-3 py-2.5 ${this.props.className ?? ''}`
  }

  get sto_deleg_objects_n() {
    if (!(!(this.props.objects <= 0 && this.props.bytes <= 0))) return undefined as never
    return formatCount(this.props.objects)
  }

  get p_text() {
    if (!(!(this.props.objects <= 0 && this.props.bytes <= 0))) return undefined as never
    return this.scope === 'module' ? this.tr('admin.sto_deleg_desc_module') : this.tr('admin.sto_deleg_desc')
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type DelegatedNoteStores = ReturnType<DelegatedNote['useStores']>

export default DelegatedNote.component()
