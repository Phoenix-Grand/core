import { bind } from '@kubuno/views'

import { ViewBase } from './ListBox.kbview'

const ROWS = Array.from({ length: 10_000 }, (_, k) => ({ Text: `Ligne ${k + 1}`, Value: `row-${k + 1}` }))

/** Gallery page: ListBox. */
export class ListBox extends ViewBase {
  @bind accessor fruit = 2
  @bind accessor picked = ''

  get rows() {
    return ROWS
  }

  get fruitText(): string {
    return `SelectedIndex = ${this.fruit}`
  }

  get pickedText(): string {
    return `SelectedValue = ${this.picked || '-'}`
  }
}

export default ListBox.component()
