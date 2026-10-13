/**
 * Code-behind of `MockFileCard.kbcontrol` (converted from `MockFileCard.tsx` by @kubuno/views-migrate).
 */

import { ViewBase } from './MockFileCard.kbcontrol'

export type MockFileCardProps = { name?: string | undefined; ext?: string | undefined; selected?: boolean | undefined; }

export class MockFileCard extends ViewBase {
  get name() {
    return this.props.name ?? 'Rapport.pdf'
  }

  get ext() {
    return this.props.ext ?? 'PDF'
  }

  get selected() {
    return this.props.selected ?? false
  }

  get div_class() {
    return `group relative rounded-xl border min-w-0 select-none transition-all w-44
        ${this.selected
          ? 'border-primary ring-2 ring-primary/20 bg-[#ddeafc]'
          : 'border-[#e8eaed] bg-surface-1 hover:border-border hover:bg-[#e4ecf7]'}`
  }

}

export default MockFileCard.component()
