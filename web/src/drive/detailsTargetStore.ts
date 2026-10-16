/**
 * What the details panel is currently describing.
 *
 * The shell's right panel mounts a component with NO props (see `RailEntry`), so
 * the explorer cannot hand it the selection directly - it publishes it here
 * instead. That indirection is the price of reusing the shell panel, and it is
 * cheaper than a second panel implementation: the shell one already brings the
 * resize handle, the per-application width memory, the overlay behaviour on
 * narrow windows and the user-customisable rail.
 */
import { create } from 'zustand'
import type { Folder, FileItem } from './api'

export type DetailsTarget =
  | { type: 'folder'; item: Folder }
  | { type: 'file';   item: FileItem }
  | null

interface DetailsTargetState {
  target: DetailsTarget
  /** Where the explorer stands, shown when the selection is empty. */
  folderName: string
  setDetails: (target: DetailsTarget, folderName: string) => void
}

export const useDetailsTargetStore = create<DetailsTargetState>((set) => ({
  target:     null,
  folderName: '',
  setDetails: (target, folderName) => set({ target, folderName }),
}))
