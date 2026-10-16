/**
 * Accepted differences of the WV-5b navigation elements (`Toolbar`, `Sidebar`, `StatusBar`, `Splitter`,
 * `SearchField`, `MaskedField`, `PaintBox`) - spread into `KBVIEW_ALLOWLIST`. Every entry says why the web differs.
 */
import type { AllowEntry } from './conformance.ts'

export const NAV_ALLOWLIST: readonly AllowEntry[] = [
  { kind: 'property-web-only', element: 'ToolbarItem', member: 'ToolTip', reason: 'Web: the tooltip and accessible name of an icon-only command (a desktop toolbar item has no tooltip yet). Proposed for the desktop ToolbarItem.' },
  { kind: 'property-web-only', element: 'ToolbarItem', member: 'Enabled', reason: 'Web: a command can be disabled (greyed, skipped by the arrow keys). Proposed for the desktop ToolbarItem.' },
  { kind: 'event-web-only', element: 'SearchField', member: 'OnSearch', reason: 'Web: Enter asks for the search now (the shell search bar submits on Enter). Proposed for the desktop SearchField (its WorkspaceShell has OnSearch).' },
  { kind: 'property-web-only', element: 'PaintBox', member: 'PaintData', reason: 'Web: a canvas is repainted when its data changes; the binding says what the drawing depends on (the desktop repaints on Invalidate()).' },
]
