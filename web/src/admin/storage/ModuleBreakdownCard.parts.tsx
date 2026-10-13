/**
 * The parts of `ModuleBreakdownCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ChevronDown, ChevronRight } from "lucide-react"
import { formatBytes } from "../sections/format"
import Figure from "./Figure"
import type { ModuleBreakdownCard } from './ModuleBreakdownCard'

export function Part1({ isOpen, setOpen, m, identity }: { isOpen: NonNullable<ModuleBreakdownCard['rows_declaring']>[number]['isOpen']; setOpen: NonNullable<ModuleBreakdownCard['setOpen']>; m: NonNullable<ModuleBreakdownCard['rows_declaring']>[number]['m']; identity: NonNullable<ModuleBreakdownCard['rows_declaring']>[number]['identity'] }) {
  return (
    <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : m.module_id)}
                          className="-mx-1.5 flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-1"
                        >
                          {isOpen
                            ? <ChevronDown size={14} className="shrink-0 text-text-tertiary" aria-hidden />
                            : <ChevronRight size={14} className="shrink-0 text-text-tertiary" aria-hidden />}
                          {identity}
                        </button>
  )
}

export function Part2({ t, data }: { t: NonNullable<ModuleBreakdownCard['tr']>; data: NonNullable<ModuleBreakdownCard['props']['data']> }) {
  return (
    <Figure label={t('admin.sto_held_fig_total')}>{formatBytes(data.held_bytes)}</Figure>
  )
}

export function Part3({ t, data }: { t: NonNullable<ModuleBreakdownCard['tr']>; data: NonNullable<ModuleBreakdownCard['props']['data']> }) {
  return (
    <Figure label={t('admin.sto_held_fig_billed')}>{formatBytes(data.declared_bytes)}</Figure>
  )
}

export function Part4({ t, data }: { t: NonNullable<ModuleBreakdownCard['tr']>; data: NonNullable<ModuleBreakdownCard['props']['data']> }) {
  return (
    <Figure label={t('admin.sto_held_fig_free_ride')}>
                {formatBytes(Math.max(data.held_bytes - data.declared_bytes, 0))}
              </Figure>
  )
}
