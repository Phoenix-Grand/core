import { bind, type ElementHandle, type ItemActivateEventArgs } from '@kubuno/views'

import { ViewBase } from './TreeView.kbview'

const ROWS = Array.from({ length: 10_000 }, (_, k) => ({
  Text: `Dossier ${k + 1}`,
  Items: k % 10 === 0 ? [{ Text: `Sous-dossier ${k + 1}.1` }, { Text: `Sous-dossier ${k + 1}.2` }] : undefined,
  Expanded: k === 0,
}))

/** Gallery page: TreeView. */
export class TreeView extends ViewBase {
  @bind accessor path = '0.0.1'
  @bind accessor opened = ''

  get rows() {
    return ROWS
  }

  get pathText(): string {
    return `SelectedPath = ${this.path || '-'}${this.opened ? ` · activated: ${this.opened}` : ''}`
  }

  item_activate(_sender: ElementHandle, e: ItemActivateEventArgs<{ text?: string }>): void {
    this.opened = e.item?.text ?? ''
  }
}

export default TreeView.component()
