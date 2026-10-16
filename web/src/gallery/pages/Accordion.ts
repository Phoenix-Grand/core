import { bind, type ElementHandle, type ValueChangedEventArgs } from '@kubuno/views'

import { ViewBase } from './Accordion.kbview'

/** Gallery page: Accordion (Open two-way, OnToggled through the parent's adapter). */
export class Accordion extends ViewBase {
  @bind accessor first = true
  @bind accessor toggles = 0
  @bind accessor last = ''

  get status(): string {
    return `first: ${this.first} - toggles: ${this.toggles} ${this.last}`
  }

  section_toggled(_sender: ElementHandle, e: ValueChangedEventArgs<boolean>): void {
    this.toggles = this.toggles + 1
    this.last = e.value ? '(opened)' : '(closed)'
  }
}

export default Accordion.component()
