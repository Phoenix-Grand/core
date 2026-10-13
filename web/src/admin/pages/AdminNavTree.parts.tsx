/**
 * The parts of `AdminNavTree.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Link } from "react-router-dom"
import { CircleSlash, Pin, PinOff, TriangleAlert } from "lucide-react"
import { firstLeafOf } from "../adminNav"
import { adminPath } from "../adminRoute"
import { type ModuleLiveState } from "../adminModules"
import type { AdminNavTree } from './AdminNavTree'

function StateGlyph({ state, title }: { state: ModuleLiveState; title: string }) {
  if (state === 'disabled') {
    return <CircleSlash size={13} className="shrink-0 text-text-tertiary" aria-label={title} />
  }
  if (state === 'unreachable') {
    return <TriangleAlert size={13} className="shrink-0 text-warning" aria-label={title} />
  }
  return null
}
export { StateGlyph }

function PinButton(
  { pinned, offered, label, onToggle }:
  { pinned: boolean; offered: boolean; label: string; onToggle: () => void },
) {
  return (
    // The SLOT is always there, even when the control is not: a button that
    // appears on hover and pushes the label as it does turns every pass of the
    // mouse down the menu into a ripple of moving text.
    <span className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center">
      {/* The list is full and this page is not in it: nothing to offer. */}
      {(pinned || offered) && (
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          title={label}
          className="flex h-6 w-6 items-center justify-center rounded-full opacity-0
                     transition-opacity hover:text-text-primary
                     focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          {pinned ? <PinOff size={14} strokeWidth={1.5} /> : <Pin size={14} strokeWidth={1.5} />}
        </button>
      )}
    </span>
  )
}
export { PinButton }

export function Part1({ it, t, activeMeta, It_Icon }: { it: NonNullable<AdminNavTree['rows_nav']>[number]['it']; t: NonNullable<AdminNavTree['tr']>; activeMeta: AdminNavTree['activeMeta']; It_Icon: NonNullable<NonNullable<NonNullable<AdminNavTree['rows_nav']>[number]['it']>['Icon']> }) {
  return (
    <Link
                key={it.id} to={adminPath(firstLeafOf(it))} title={t(it.labelKey)}
                aria-current={it.id === activeMeta?.topId ? 'page' : undefined}
                className={`w-full h-10 flex items-center justify-center rounded-full transition-colors ${
              it.id === activeMeta?.topId ? 'bg-primary-light text-primary' : 'text-text-secondary hover:bg-surface-2'}`}
              >
                {it.Icon && <It_Icon size={20} strokeWidth={1.5} className="shrink-0" />}
              </Link>
  )
}

export function Part2({ meta, indent, rowClass, isActive, caretSpacer, label, LINK_CLASS, TopIcon, t, pins }: { meta: NonNullable<AdminNavTree['rows_pinned']>[number]['meta']; indent: AdminNavTree['indent']; rowClass: AdminNavTree['rowClass']; isActive: NonNullable<AdminNavTree['rows_pinned']>[number]['isActive']; caretSpacer: NonNullable<AdminNavTree['caretSpacer']>; label: NonNullable<AdminNavTree['rows_pinned']>[number]['label']; LINK_CLASS: NonNullable<AdminNavTree['LINK_CLASS']>; TopIcon: NonNullable<AdminNavTree['rows_pinned']>[number]['TopIcon']; t: NonNullable<AdminNavTree['tr']>; pins: NonNullable<AdminNavTree['pins']> }) {
  return (
    <div
                    key={`pin:${meta.item.id}`} style={{ paddingLeft: indent(0) }}
                    className={rowClass(isActive, false)}
                  >
                    {caretSpacer}
                    <Link
                      to={adminPath(meta.item.id)} title={label}
                      aria-current={isActive ? 'page' : undefined}
                      className={LINK_CLASS}
                    >
                      <span className="flex w-5 shrink-0 items-center justify-center">
                        {TopIcon && <TopIcon size={20} strokeWidth={1.5} />}
                      </span>
                      <span className="truncate flex-1">{label}</span>
                    </Link>
                    <PinButton
                      pinned offered
                      label={t('admin.nav_unpin', { section: label })}
                      onToggle={() => pins.toggle(meta.item.id)}
                    />
                  </div>
  )
}

export function Part3({ showMore, setShowMore, indent, rowClass, CARET_SLOT, caretIcon, t }: { showMore: NonNullable<AdminNavTree['showMore']>; setShowMore: NonNullable<AdminNavTree['setShowMore']>; indent: AdminNavTree['indent']; rowClass: AdminNavTree['rowClass']; CARET_SLOT: NonNullable<AdminNavTree['CARET_SLOT']>; caretIcon: AdminNavTree['caretIcon']; t: NonNullable<AdminNavTree['tr']> }) {
  return (
    <a
              href="#" role="button" aria-expanded={showMore}
              onClick={e => { e.preventDefault(); setShowMore(v => !v) }}
              style={{ paddingLeft: indent(0) }}
              className={rowClass(false, false)}
            >
              {/* The caret sits where every other foldable row in this panel puts
                  it — at the head of the line. A menu whose chevrons swap sides row
                  to row is a menu the eye has to re-learn on each one. */}
              <span className={CARET_SLOT} aria-hidden>{caretIcon(showMore)}</span>
              <span className="flex min-w-0 flex-1 items-center gap-3">
                {/* The icon column every top-level row has, kept empty so this row
                    lines its label up with the sections it folds away. */}
                <span className="w-5 shrink-0" aria-hidden />
                <span className="truncate flex-1">
                  {t(showMore ? 'admin.nav_show_less' : 'admin.nav_show_more')}
                </span>
              </span>
            </a>
  )
}

export function Part4({ indent, t }: { indent: AdminNavTree['indent']; t: NonNullable<AdminNavTree['tr']> }) {
  return (
    <Link
              to="/about"
              style={{ paddingLeft: indent(0), fontSize: 'var(--kb-text-meta)' }}
              className="flex items-center rounded-full py-1.5 text-text-tertiary hover:text-primary"
            >
              {t('user.about', { defaultValue: 'À propos de Kubuno' })}
            </Link>
  )
}
