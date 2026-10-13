/**
 * Code-behind of `ReportBlock.kbcontrol` (converted from `ReportBlock.tsx` by @kubuno/views-migrate).
 */
import { Fragment } from 'react'
import type { ReactNode } from "react"

import { ViewBase } from './ReportBlock.kbcontrol'

export type ReportBlockProps = {
  title:    string
  children: ReactNode
  note?:    ReactNode
  /** This block contains a table that is allowed to run over several sheets. */
  table?:   boolean
}

export class ReportBlock extends ViewBase {
  /** `React.Fragment`: renders the elements an expression holds. */
  get Fragment() {
    return Fragment
  }

  get content_children() {
    return this.memo('content_children', [this.props], () => ({ children: this.props.children }))
  }

  get show_note() {
    return this.memo('show_note', [this.props], () => !!(this.props.note))
  }

  get content_note() {
    return this.memo('content_note', [this.props], () => {
      if (!(this.props.note)) return undefined as never
      return ({ children: this.props.note })
    })
  }

  get section_data() {
    return [((v: unknown) => (v === undefined || v === null ? '' : "report-card=" + String(v)))(this.props.table ? 'table' : '')].filter(Boolean).join('; ')
  }

}

export default ReportBlock.component()
