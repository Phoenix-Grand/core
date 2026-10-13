/**
 * Code-behind of `MockFileRow.kbcontrol` (converted from `MockFileRow.tsx` by @kubuno/views-migrate).
 */

import { ViewBase } from './MockFileRow.kbcontrol'

export type MockFileRowProps = { name?: string | undefined; size?: string | undefined; selected?: boolean | undefined; }

export class MockFileRow extends ViewBase {
  get name() {
    return this.props.name ?? 'Photo-2026.jpg'
  }

  get size() {
    return this.props.size ?? '2,4 Mo'
  }

  get selected() {
    return this.props.selected ?? false
  }

  get div_class() {
    return `group relative flex items-center gap-3 px-3 py-2 transition-colors select-none border-l-[3px]
        ${this.selected ? 'bg-[#e8f0fe] border-primary' : 'bg-white border-transparent hover:bg-surface-1'}`
  }

}

export default MockFileRow.component()
