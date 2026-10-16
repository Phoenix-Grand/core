import { bind, type ElementHandle, type ItemEventArgs } from '@kubuno/views'

import { ViewBase } from './Breadcrumb.kbview'

/** Gallery page: Breadcrumb (OnClick of a segment through the parent's adapter). */
export class Breadcrumb extends ViewBase {
  @bind accessor clicked = '-'

  get status(): string {
    return `Last segment clicked: ${this.clicked}`
  }

  crumb_click(_sender: ElementHandle, e: ItemEventArgs): void {
    this.clicked = String(e.index)
  }
}

export default Breadcrumb.component()
