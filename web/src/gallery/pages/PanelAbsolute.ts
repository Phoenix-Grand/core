import { bind } from '@kubuno/views'

import { ViewBase } from './PanelAbsolute.kbview'

/** Gallery page: Panel Layout="Absolute" and Anchor - the board is laid out at 320 × 160, then resized. */
export class PanelAbsolute extends ViewBase {
  @bind accessor boardWidth = 320
  @bind accessor boardHeight = 160

  get caption(): string {
    return `Designed at 320 × 160, shown at ${this.boardWidth} × ${this.boardHeight}`
  }

  page_shown(): void {
    // After the first layout (the reference), as a resize would.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.boardWidth = Math.max(320, Math.min(720, window.innerWidth - 32))
      this.boardHeight = 200
    }))
  }
}

export default PanelAbsolute.component()
