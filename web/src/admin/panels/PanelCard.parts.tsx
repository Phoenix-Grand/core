/**
 * The parts of `PanelCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ChevronLeft, ChevronRight, EyeOff } from "lucide-react"
import { Tooltip } from "@ui"
import type { PanelCard } from './PanelCard'

export function Part1({ Icon }: { Icon: NonNullable<PanelCard['Icon']> }) {
  return (
    <Icon size={15} className="text-text-secondary" aria-hidden />
  )
}

export function Part2({ t, onMove, canMoveUp }: { t: NonNullable<PanelCard['tr']>; onMove: NonNullable<PanelCard['props']['onMove']>; canMoveUp: NonNullable<PanelCard['props']['canMoveUp']> }) {
  return (
    <Tooltip label={t('admin.sec_move_earlier')}>
                  <button
                    type="button" onClick={() => onMove(-1)} disabled={!canMoveUp}
                    aria-label={t('admin.sec_move_earlier')}
                    className="flex size-7 items-center justify-center rounded-md text-text-secondary
                               hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <ChevronLeft size={15} />
                  </button>
                </Tooltip>
  )
}

export function Part3({ t, onMove, canMoveDown }: { t: NonNullable<PanelCard['tr']>; onMove: NonNullable<PanelCard['props']['onMove']>; canMoveDown: NonNullable<PanelCard['props']['canMoveDown']> }) {
  return (
    <Tooltip label={t('admin.sec_move_later')}>
                  <button
                    type="button" onClick={() => onMove(1)} disabled={!canMoveDown}
                    aria-label={t('admin.sec_move_later')}
                    className="flex size-7 items-center justify-center rounded-md text-text-secondary
                               hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <ChevronRight size={15} />
                  </button>
                </Tooltip>
  )
}

export function Part4({ t, onHide }: { t: NonNullable<PanelCard['tr']>; onHide: NonNullable<PanelCard['props']['onHide']> }) {
  return (
    <Tooltip label={t('admin.sec_hide_panel')}>
                  <button
                    type="button" onClick={onHide} aria-label={t('admin.sec_hide_panel')}
                    className="flex size-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-2"
                  >
                    <EyeOff size={15} />
                  </button>
                </Tooltip>
  )
}

export function Part5({ DeltaIcon }: { DeltaIcon: NonNullable<PanelCard['DeltaIcon']> }) {
  return (
    <DeltaIcon size={13} aria-hidden />
  )
}
