/**
 * Code-behind of `MockFolderCard.kbcontrol` (converted from `MockFolderCard.tsx` by @kubuno/views-migrate).
 */

import { ViewBase } from './MockFolderCard.kbcontrol'

export type MockFolderCardProps = { name?: string | undefined; selected?: boolean | undefined; }

export class MockFolderCard extends ViewBase {
  get name() {
    return this.props.name ?? 'Documents'
  }

  get selected() {
    return this.props.selected ?? false
  }

  get div_class() {
    return `group relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all select-none w-44
        ${this.selected
          ? 'border-primary ring-2 ring-primary/20 bg-[#c9defa]'
          : 'border-[#e8eaed] bg-[#f3f4f5] hover:border-border hover:bg-[#e4ecf7]'}`
  }

}

export default MockFolderCard.component()
