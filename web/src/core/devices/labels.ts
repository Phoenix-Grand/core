import type { TFunction } from 'i18next'
import type { Approval, Device, DeviceEvent, DeviceSession, DeviceType, SignalLevel, Tri } from './types'

/**
 * Wording of the inventory, in one place.
 *
 * The rule enforced here, and the reason this file is not a handful of inline
 * ternaries: **a declared signal is never presented as verified**. Every helper
 * that renders one of them either carries the "declared by the device" wording
 * or returns a state the caller must label. A value the platform cannot check
 * must never look like one it can.
 */

export const deviceTypeLabel = (t: TFunction, type: DeviceType | string): string =>
  t(`devices.type_${type}`, { defaultValue: t('devices.type_unknown') })

export const approvalLabel = (t: TFunction, approval: Approval | string): string =>
  t(`devices.approval_${approval}`, { defaultValue: approval })

export const signalLevelLabel = (t: TFunction, level: SignalLevel | string): string =>
  t(`devices.signal_${level}`, { defaultValue: level })

/**
 * Tri-state wording. `unknown` reads as "unknown", never as "no" - the two are
 * different statements and only one of them is a measurement.
 */
export const triLabel = (t: TFunction, tri: Tri): string =>
  t(`devices.tri_${tri}`, { defaultValue: t('devices.tri_unknown') })

export const authStrengthLabel = (t: TFunction, strength: string | null): string =>
  strength ? t(`devices.auth_${strength}`, { defaultValue: t('devices.auth_unknown') })
           : t('devices.auth_unknown')

export const clientKindLabel = (t: TFunction, kind: string | null): string =>
  kind ? t(`devices.client_${kind}`, { defaultValue: kind }) : t('devices.client_unknown')

export const eventKindLabel = (t: TFunction, kind: DeviceEvent['kind'] | string): string =>
  t(`devices.event_${kind}`, { defaultValue: kind })

/** Name to show for a device: what the user called it, else what was observed. */
export function deviceName(t: TFunction, device: Device): string {
  if (device.label) return device.label
  const platform = [device.platform, device.platform_version].filter(Boolean).join(' ')
  if (device.browser && platform) return t('devices.described', { browser: device.browser, platform })
  return device.browser || platform || t('devices.unnamed')
}

/** Same, for a session row whose device may have been forgotten. */
export function sessionName(t: TFunction, session: DeviceSession): string {
  return session.device_label || session.device_name || t('devices.unnamed')
}

export const countryLabel = (t: TFunction, code: string | null): string =>
  code || t('devices.country_unknown')

/**
 * Visual skin of an approval state.
 *
 * Theme tokens only, and never an opacity modifier over one: `bg-danger/10`
 * renders as a washed-out smear in dark mode because the token is already
 * near-black there. The `-light` surfaces exist for exactly this.
 */
export function approvalSkin(approval: Approval | string): { chip: string; dot: string } {
  switch (approval) {
    case 'approved':
      return { chip: 'bg-success-light text-success', dot: 'bg-success' }
    case 'blocked':
      return { chip: 'bg-danger-light text-danger', dot: 'bg-danger' }
    default:
      return { chip: 'bg-surface-2 text-text-secondary', dot: 'bg-border-strong' }
  }
}

/**
 * Skin of a tri-state chip.
 *
 * `unknown` is deliberately NEUTRAL, not a warning colour: the platform has not
 * asked, which is not a finding. Only an explicit `no` is a finding.
 */
export function triSkin(tri: Tri): string {
  switch (tri) {
    case 'yes': return 'bg-success-light text-success'
    case 'no':  return 'bg-warning-light text-warning'
    default:    return 'bg-surface-2 text-text-tertiary'
  }
}
