/**
 * The chrome of the header's panels (the launcher's menu, the account panel): their ground and their shadow.
 *
 * The ground is the theme token `PanelBackground` - the host's `--color-panel-bg`, which defaults to the header
 * search field's ground (`#e9eef6` in the light themes, `#303134` in Kubuno Dark; Numix, whose search field sits
 * on its dark header band, sets its own) - the same token the desktop's `header_popup::tint()` paints
 * (SHELL-CONTROLS.md §8). It used to be a literal `#E9EEF6`, which left the panels light under the dark theme's
 * light text.
 */
import type { CSSProperties } from 'react'
import { tokenColor } from '@kubuno/views'

/** The theme token of the panels' ground. */
export const HEADER_PANEL_GROUND = 'PanelBackground'

/** Ground and shadow of a header panel. */
export const headerPanelChrome: Readonly<CSSProperties> = {
  background: tokenColor(HEADER_PANEL_GROUND),
  boxShadow: '0 4px 8px 3px rgba(0,0,0,.15),0 1px 3px rgba(0,0,0,.3)',
}
