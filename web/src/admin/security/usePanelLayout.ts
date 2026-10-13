import { useMemo } from 'react'
import { usePanelLayout as useSharedLayout } from '../panels/usePanelLayout'
import { DEFAULT_ORDER } from './panels'

/**
 * The security dashboard's arrangement, on the shared panel-layout contract.
 *
 * The rules — one atomic write of the whole object to the account's
 * `preferences`, a localStorage mirror for the cold start, `{ order, hidden }`
 * rather than a list of visible ids — live in `../panels/usePanelLayout` and are
 * shared with every other panelled page. Only the three names are local: the
 * preference key, the mirror key, and this page's factory order.
 */

export type { PanelLayout } from '../panels/usePanelLayout'
export { applyLayout } from '../panels/usePanelLayout'

const LS_KEY = 'kubuno-security-dashboard'
const PREF_KEY = 'security_dashboard'

export function usePanelLayout() {
  const keys = useMemo(
    () => ({ pref: PREF_KEY, cache: LS_KEY, defaultOrder: DEFAULT_ORDER }),
    [],
  )
  return useSharedLayout(keys)
}
