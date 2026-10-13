/**
 * Code-behind of `RoleBadge.kbcontrol` (converted from `RoleBadge.tsx` by @kubuno/views-migrate).
 */

import { ViewBase } from './RoleBadge.kbcontrol'

const ROLE_VARIANT: Record<string, 'danger' | 'primary' | 'default'> = {
  admin: 'danger',
  user:  'primary',
  guest: 'default',
}

export type RoleBadgeProps = { role: string; label: string }

export class RoleBadge extends ViewBase {
  get variant() {
    return ROLE_VARIANT[this.props.role] ?? 'default'
  }

}

export default RoleBadge.component()
