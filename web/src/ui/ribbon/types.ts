// Ribbon data model (MS Office style) - shared by ALL the modules' sub-editors.
// Each sub-editor declares its tabs; the <Ribbon> component does all the
// rendering, styling and responsive behaviour. Data-driven: extending the ribbon = extending
// these structures + <Ribbon>, never duplicating per editor.
import type { ReactNode } from 'react'

export type RibbonItemKind =
  | 'button'      // action button (large = stacked icon+label; small = compact)
  | 'toggle'      // toggle button (active state highlighted)
  | 'dropdown'    // dropdown list (font, size…) - rendered via @ui Dropdown
  | 'split'       // main action + small chevron opening an options menu
  | 'menu'        // button with NO action of its own: its whole surface opens a menu, the
                  //   chevron being BELOW the label (big Word-style "Table" button).
                  //   Content = `menuRender` (free palette), otherwise `splitItems`.
  | 'gallery'     // row of options/thumbnails (styles, colours…)
  | 'separator'   // vertical separator within a group
  | 'custom'      // escape hatch: ReactNode supplied by the editor (colour picker, gauge…)

export interface RibbonOption {
  value: string
  label: string
  icon?: ReactNode
}

export interface RibbonItem {
  id: string
  kind: RibbonItemKind
  label?: string                 // large button: visible; otherwise = fallback tooltip
  icon?: ReactNode
  size?: 'large' | 'small'       // default 'small'
  active?: boolean               // toggle / highlight
  disabled?: boolean
  tooltip?: string
  shortcut?: string              // shown in the tooltip
  onClick?: () => void
  /** Double-click (Word-style "Format Painter": single = once,
   *  double = sticky mode). Does not replace `onClick`, which fires too. */
  onDoubleClick?: () => void
  /** MOBILE palette: force the LABELLED TILE even for a toggle with an icon -
   for toggles whose icon alone is not self-explanatory (view selectors…). */
  paletteTile?: boolean
  // dropdown / gallery / split
  options?: RibbonOption[]
  value?: string
  onChange?: (value: string) => void
  width?: number                 // dropdown width (px)
  splitItems?: RibbonItem[]      // split / menu: entries of the dropdown menu
  // menu: free content of the menu (palette, selection grid…). Receives `close`
  // so it can close itself after a choice. Takes precedence over `splitItems`.
  menuRender?: (close: () => void) => ReactNode
  // custom
  render?: ReactNode
}

export interface RibbonGroup {
  id: string
  label: string
  items: RibbonItem[]
  // MOBILE quick bar (row above the keyboard): replaces the automatic selection
  // (button/toggle/split with an icon) for this group. `[]` = the group does not
  // appear in the bar (it stays whole in the palette). Useful when the
  // desktop rendering is a `custom` (e.g. the Font group of the documents) whose
  // B/I/U… commands must still be one tap away on mobile, Word style.
  mobileQuick?: RibbonItem[]
}

export interface RibbonTab {
  id: string
  label: string
  groups: RibbonGroup[]
  // CONTEXTUAL tab (Office style): shown on the right with a coloured edge, and
  // only appears when `visible` is true (image selection, table…).
  contextual?: { accent: string; groupLabel?: string }
  visible?: boolean
  // "File" tab (Office-style backstage): placed first, styled with
  // the app accent. When active, `backstage` is rendered as a full-screen OVERLAY (the
  // `groups` are ignored). A back arrow closes the backstage (unless
  // `backstageLocked` = no file open → it cannot be closed).
  backstage?: ReactNode
  backstageLocked?: boolean
}

/**
 * The colours the ribbon draws with. Structurally the workspace shell's theme (`WorkspaceTheme` of `@kubuno/sdk`), so a
 * module hands its workspace theme over as is; `fileAccent` is the background of the File tab and of the backstage
 * rail (the accent itself when absent; a module may pass a lighter tone of it). Every colour may be a `var(...)`.
 */
export type RibbonTheme = {
  bg: string
  panel: string
  toolbar: string
  header: string
  active: string
  border: string
  accent: string
  text: string
  textDim: string
  topbarBg?: string
  topbarText?: string
  statusBg?: string
  dark?: boolean
  fileAccent?: string
}
