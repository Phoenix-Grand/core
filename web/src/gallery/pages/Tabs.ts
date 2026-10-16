import { bind, type ElementHandle, type ValueChangedEventArgs } from '@kubuno/views'

import { ViewBase } from './Tabs.kbview'

/** Gallery page: Tabs (bound SelectedIndex, OnSelectionChanged). */
export class Tabs extends ViewBase {
  @bind accessor tab = 1
  @bind accessor changes = 0

  get status(): string {
    return `SelectedIndex: ${this.tab} - changes: ${this.changes}`
  }

  tabs_selection_changed(_sender: ElementHandle, _e: ValueChangedEventArgs): void {
    this.changes = this.changes + 1
  }
}

export default Tabs.component()
