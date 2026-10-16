import { bind } from '@kubuno/views'

import { ViewBase } from './Splitter.kbview'

/** Gallery page: Splitter. */
export class Splitter extends ViewBase {
  @bind accessor distance = 180

  get caption(): string {
    return `Second pane - the first is ${this.distance} px wide`
  }
}

export default Splitter.component()
