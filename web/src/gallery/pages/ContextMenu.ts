import { bind, type ElementHandle, type ValueChangedEventArgs } from '@kubuno/views'

import { ViewBase } from './ContextMenu.kbview'

/** Gallery page: ContextMenu (MenuItem children, check marks, ItemsSource commands). */
export class ContextMenu extends ViewBase {
  @bind accessor hidden = false
  @bind accessor last = '-'

  readonly extra = [
    { Kind: 'Separator' },
    { Text: 'Rename', Key: 'rename', Icon: 'Pencil', ShortcutKeys: 'F2' },
    { Text: 'Move to trash', Key: 'trash', Danger: true },
  ]

  get status(): string {
    return `Last: ${this.last} - hidden files: ${this.hidden}`
  }

  open_click(sender: ElementHandle): void {
    this.last = `OnClick ${String((sender as unknown as { text?: string }).text ?? '')}`
  }

  checked_changed(_sender: ElementHandle, e: ValueChangedEventArgs<boolean>): void {
    this.last = `OnCheckedChanged ${e.value}`
  }

  menu_item_clicked(_sender: ElementHandle, e: ValueChangedEventArgs<string>): void {
    this.last = `OnItemClicked ${e.value}`
  }
}

export default ContextMenu.component()
