/**
 * Code-behind of `SettingSectionCard.kbcontrol` (converted from `SettingSectionCard.tsx` by @kubuno/views-migrate).
 */
import type { ReactNode } from "react"
import { useId } from "react"

import { ViewBase } from './SettingSectionCard.kbcontrol'
import * as __parts from './SettingSectionCard.parts.tsx'

export interface SettingSectionCardProps {
  title:    ReactNode
  /**
   * What the section currently amounts to, right-aligned before the chevron:
   * how many knobs, how many of them no longer follow the level above. It is on
   * the RIGHT and not under the title because it is a state, not a subtitle —
   * a column of states down the right edge is what makes a folded page of eight
   * sections answer "where did we change something" without opening one.
   */
  status?:  ReactNode
  /** A real sentence about what the section governs, under the title. */
  description?: ReactNode
  /** Leading glyph, when the section carries one (a module's own page icon). */
  icon?:    ReactNode
  /**
   * The left gutter of the open body: what scope these settings apply to. Comes
   * in as a node rather than being derived here — only the panel knows which
   * scope is on screen, and re-deriving it per section is how two sections of
   * the same page end up claiming two different scopes.
   *
   * Absent, the settings simply take the whole width.
   */
  aside?:   ReactNode
  /** The section's own save bar, under both columns. */
  footer?:  ReactNode
  open:     boolean
  onToggle: () => void
  children: ReactNode
  className?: string
}

export class SettingSectionCard extends ViewBase {
  bodyId!: string

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const bodyId = useId()
    return { bodyId }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ bodyId: s.bodyId })
  }

  get className() {
    return this.props.className ?? ''
  }

  get section_class() {
    return `min-w-0 overflow-hidden rounded-xl border border-border bg-surface-0 ${this.className}`
  }

  get part1_props() {
    return this.memo('part1_props', [this.props, this.bodyId], () => ({ onToggle: this.props.onToggle, open: this.props.open, bodyId: this.bodyId, icon: this.props.icon, title: this.props.title, description: this.props.description, status: this.props.status }))
  }

  /** A part of the screen still written in React (<button aria-expanded aria-controls>: attribute(s) without a .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.bodyId, this.props], () => {
      if (!(this.props.open)) return undefined as never
      return ({ bodyId: this.bodyId, aside: this.props.aside, children: this.props.children, footer: this.props.footer })
    })
  }

  /** A part of the screen still written in React (<div id>: attribute(s) without a .kbview property). */
  get Part2() {
    if (!(this.props.open)) return undefined as never
    return __parts.Part2
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type SettingSectionCardStores = ReturnType<SettingSectionCard['useStores']>

export default SettingSectionCard.component()
