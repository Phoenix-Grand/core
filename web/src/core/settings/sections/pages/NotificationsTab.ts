/**
 * Code-behind of `NotificationsTab.kbcontrol` (converted from `NotificationsTab.tsx` by @kubuno/views-migrate).
 */
import { bind, type ValueChangedEventArgs } from '@kubuno/views'
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useSaveShortcut } from "@ui"
import { useAuthStore } from "../../../store/authStore"
import { useModulesStore } from "../../../store/modulesStore"
import { NotificationRegistry } from "../../../slots/SlotRegistry"
import { api } from "../../../api/client"

import { ViewBase } from './NotificationsTab.kbcontrol'
import * as __parts from './NotificationsTab.parts.tsx'

export class NotificationsTab extends ViewBase {
  @bind accessor saved = false
  @bind accessor busy = false
  tr!: NotificationsTabStores['t']
  user!: NotificationsTabStores['user']
  updateUser!: NotificationsTabStores['updateUser']
  activeModules!: NotificationsTabStores['activeModules']
  n!: NotificationsTabHooks['n']
  setN!: NotificationsTabHooks['setN']
  matrix!: NotificationsTabHooks['matrix']
  setMatrix!: NotificationsTabHooks['setMatrix']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { user, updateUser } = useAuthStore()
    const { activeModules } = useModulesStore()
    return { t, user, updateUser, activeModules }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [n, setN] = useState<{ emailReminder: string; soundOnNotif: boolean; soundOnCall: boolean; emailFrequency: string; dailyDigest: boolean; }>({
    emailReminder:  this.str(this.stored.emailReminder, 'never'),
    soundOnNotif:   !!this.stored.soundOnNotif,
    soundOnCall:    !!this.stored.soundOnCall,
    emailFrequency: this.str(this.stored.emailFrequency, 'hourly'),
    dailyDigest:    !!this.stored.dailyDigest,
    })
    const [matrix, setMatrix] = useState<Record<string, { email: boolean; push: boolean }>>(() => {
    const m: Record<string, { email: boolean; push: boolean }> = {}
    for (const g of this.groups) for (const a of g.activities) {
    const k = `${g.moduleId}:${a.id}`
    m[k] = { email: this.sa[k]?.email ?? !!a.emailDefault, push: this.sa[k]?.push ?? !!a.pushDefault }
    }
    return m
    })
    useSaveShortcut(() => { void this.save() }, !this.busy)
    return { n, setN, matrix, setMatrix }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, user: s.user, updateUser: s.updateUser, activeModules: s.activeModules })
    const h = this.useHooks()
    this.publish({ n: h.n, setN: h.setN, matrix: h.matrix, setMatrix: h.setMatrix })
  }

  get activeIds() {
    return this.memo('activeIds', [this.activeModules], () => new Set(this.activeModules.map(m => m.module_id)))
  }

  get groups() {
    return this.memo('groups', [this.activeIds, this.tr], () => NotificationRegistry.getGroups(this.activeIds).map(group =>
      group.moduleId === 'core' ? {
        ...group,
        title: this.tr('settings.notif_core_title'),
        activities: group.activities.map(activity => ({
          ...activity,
          label: this.tr(`settings.notif_core_${activity.id}`, { defaultValue: activity.label }),
        })),
      } : group))
  }

  get stored() {
    return this.memo('stored', [this.user], () => (this.user?.preferences?.notifications ?? {}) as Record<string, unknown>)
  }

  get sa() {
    return this.memo('sa', [this.stored], () => (this.stored.activity ?? {}) as Record<string, { email?: boolean; push?: boolean }>)
  }

  get items_source() {
    return this.memo('items_source', [this.tr], () => [
            { value: 'never', label: this.tr('settings.notif_never', { defaultValue: 'Jamais' }) },
            { value: '1h', label: this.tr('settings.notif_after_1h', { defaultValue: 'Après 1 heure' }) },
            { value: '3h', label: this.tr('settings.notif_after_3h', { defaultValue: 'Après 3 heures' }) },
            { value: '1d', label: this.tr('settings.notif_after_1d', { defaultValue: 'Après 1 jour' }) },
          ])
  }

  /** `<NotifCheck>`, rendered by a ReactHost. */
  get NotifCheck() {
    return __parts.NotifCheck
  }

  get notif_check_props() {
    return this.memo('notif_check_props', [this.n, this.setN], () => ({ checked: this.n.soundOnNotif, onChange: () => this.setN(p => ({ ...p, soundOnNotif: !p.soundOnNotif })) }))
  }

  get notif_check_props2() {
    return this.memo('notif_check_props2', [this.n, this.setN], () => ({ checked: this.n.soundOnCall, onChange: () => this.setN(p => ({ ...p, soundOnCall: !p.soundOnCall })) }))
  }

  /** A part of the screen still written in React (a list inside a list (nested Repeater)). */
  get Part1() {
    return __parts.Part1
  }

  /** The rows of the Repeater over `groups`. */
  get rows_groups() {
    return this.memo('rows_groups', [this.groups], () => this.groups.map((g) => {
      return { g, part1_props: { g: g, cell: this.cell.bind(this), toggle: this.toggle.bind(this) }, key: `${g.moduleId}:${g.title}` }
    }))
  }

  get items_source2() {
    return this.memo('items_source2', [this.tr], () => [
              { value: 'asap', label: this.tr('settings.notif_freq_asap', { defaultValue: 'Dès que possible' }) },
              { value: 'hourly', label: this.tr('settings.notif_freq_hourly', { defaultValue: 'Toutes les heures' }) },
              { value: 'daily', label: this.tr('settings.notif_freq_daily', { defaultValue: 'Une fois par jour' }) },
              { value: 'weekly', label: this.tr('settings.notif_freq_weekly', { defaultValue: 'Une fois par semaine' }) },
            ])
  }

  get notif_check_props3() {
    return this.memo('notif_check_props3', [this.n, this.setN], () => ({ checked: this.n.dailyDigest, onChange: () => this.setN(p => ({ ...p, dailyDigest: !p.dailyDigest })) }))
  }

  get button_text() {
    return this.saved ? this.tr('settings.profile_saved') : this.tr('settings.save')
  }

  str(v: unknown, d: string) {
    return (typeof v === 'string' ? v : d)
  }

  cell(k: string, a: { emailDefault?: boolean; pushDefault?: boolean }) {
    return this.matrix[k] ?? { email: !!a.emailDefault, push: !!a.pushDefault }
  }

  toggle(k: string, a: { emailDefault?: boolean; pushDefault?: boolean }, ch: 'email' | 'push') {
    return this.setMatrix(m => { const c = m[k] ?? { email: !!a.emailDefault, push: !!a.pushDefault }; return { ...m, [k]: { ...c, [ch]: !c[ch] } } })
  }

  async save() {
    this.busy = true
    try {
      const notifications = { ...this.n, activity: this.matrix }
      const { data } = await api.patch<{ user: NotificationsTab['user'] }>('/me', { preferences: { notifications } })
      if (data.user) this.updateUser(data.user as Parameters<NotificationsTab['updateUser']>[0])
      this.saved = true; setTimeout(() => this.saved = false, 2200)
    } finally { this.busy = false }
  }

  dropdown_selected_value_changed(_sender: unknown, args: ValueChangedEventArgs) {
    const v = args.value as string
    this.setN(p => ({ ...p, emailReminder: v }))
  }

  dropdown_selected_value_changed2(_sender: unknown, args: ValueChangedEventArgs) {
    const v = args.value as string
    this.setN(p => ({ ...p, emailFrequency: v }))
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type NotificationsTabStores = ReturnType<NotificationsTab['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type NotificationsTabHooks = ReturnType<NotificationsTab['useHooks']>

export default NotificationsTab.component()

NotificationRegistry.register({
  moduleId: 'core', title: "Account and security", order: 90,
  activities: [
    { id: 'group_membership', label: "Your group memberships have changed", emailDefault: true },
    { id: 'password_email',   label: "Your password or email address has changed", emailDefault: true },
    { id: 'security',         label: "Sign-in from a new device or browser", emailDefault: true, pushDefault: true },
    { id: 'totp',             label: "TOTP (authenticator app)", emailDefault: true, pushDefault: true },
  ],
})
