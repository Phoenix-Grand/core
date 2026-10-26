/**
 * Code-behind of `ProfileTab.kbcontrol` (converted from `ProfileTab.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs } from '@kubuno/views'
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { setLanguage } from '../../../i18n'
import { Dropdown, useToast } from "@ui"
import { useAuthStore } from "../../../store/authStore"
import { api } from "../../../api/client"
import { type Vis } from "../profileFields"

import { ViewBase } from './ProfileTab.kbcontrol'
import * as __parts from './ProfileTab.parts.tsx'

const orNull = (value: string): string | null => (value.trim() ? value.trim() : null)

const PROFILE_LANGS: [string, string][] = [
  ['fr', 'Français'], ['en', 'English'], ['es', 'Español'], ['de', 'Deutsch'],
  ['it', 'Italiano'], ['pt', 'Português'], ['nl', 'Nederlands'], ['pl', 'Polski'],
  ['ru', 'Русский'], ['ar', 'العربية'], ['zh', '中文'], ['ja', '日本語'], ['ko', '한국어'],
]

function profileTimezones(): string[] {
  try {
    // Intl.supportedValuesOf is available in modern browsers.
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf
    if (fn) return fn('timeZone')
  } catch { /* fall through */ }
  return ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']
}

export class ProfileTab extends ViewBase {
  @bind accessor saved = false
  @bind accessor busy = false
  tr!: ProfileTabStores['t']
  i18n!: ProfileTabStores['i18n']
  toast!: ProfileTabStores['toast']
  user!: ProfileTabStores['user']
  updateUser!: ProfileTabStores['updateUser']
  f!: ProfileTabHooks['f']
  setF!: ProfileTabHooks['setF']
  vis!: ProfileTabHooks['vis']
  setVis!: ProfileTabHooks['setVis']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const toast = useToast()
    const { user, updateUser } = useAuthStore()
    return { t, i18n, toast, user, updateUser }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [f, setF] = useState<{ fullName: string; firstName: string; lastName: string; namePronunciation: string; pronouns: string; workLocation: string; gender: string; birthday: string; introduction: string; extraEmails: string[]; phone: string; location: string; language: string; locale: string; firstDayOfWeek: string; timezone: string; website: string; x: string; bluesky: string; fediverse: string; organization: string; jobFunction: string; title: string; }>({
    fullName:         this.user?.display_name ?? '',
    firstName:        this.user?.first_name ?? '',
    lastName:         this.user?.last_name ?? '',
    namePronunciation: this.user?.name_pronunciation ?? '',
    pronouns:         this.user?.pronouns ?? '',
    workLocation:     this.user?.work_location ?? '',
    gender:           this.user?.gender ?? '',
    birthday:         this.user?.birthday ?? '',
    introduction:     this.user?.introduction ?? '',
    extraEmails:    Array.isArray(this.prof.extraEmails) ? (this.prof.extraEmails as string[]) : [],
    phone:          this.s(this.prof.phone),
    location:       this.s(this.prof.location),
    language:       this.s(this.prefs.language) || this.i18n.resolvedLanguage || this.i18n.language || 'en',
    locale:         this.s(this.prefs.locale),
    firstDayOfWeek: this.s(this.prefs.firstDayOfWeek) || 'auto',
    timezone:       this.s(this.prefs.timezone),
    website:        this.s(this.prof.website),
    x:              this.s(this.prof.x),
    bluesky:        this.s(this.prof.bluesky),
    fediverse:      this.s(this.prof.fediverse),
    organization:   this.s(this.prof.organization),
    jobFunction:    this.s(this.prof.jobFunction),
    title:          this.s(this.prof.title),
    })
    const [vis, setVis] = useState<Record<string, Vis>>({
    fullName: 'public', firstName: 'public', lastName: 'public', namePronunciation: 'public', pronouns: 'public', emails: 'public',
    phone: 'private', location: 'private', workLocation: 'public',
    gender: 'private', birthday: 'private',
    website: 'private', x: 'private', bluesky: 'private', fediverse: 'private',
    organization: 'private', jobFunction: 'private', title: 'private',
    // The old `bio` box became `introduction`; whoever had already chosen a
    // visibility for it keeps that choice rather than being silently reset.
    introduction: this.storedVis.bio ?? 'private',
    ...this.storedVis,
    })
    return { f, setF, vis, setVis }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, i18n: s.i18n, toast: s.toast, user: s.user, updateUser: s.updateUser })
    const h = this.useHooks()
    this.publish({ f: h.f, setF: h.setF, vis: h.vis, setVis: h.setVis })
  }

  get prefs() {
    return this.memo('prefs', [this.user], () => (this.user?.preferences ?? {}) as Record<string, unknown>)
  }

  get prof() {
    return this.memo('prof', [this.prefs], () => (this.prefs.profile ?? {}) as Record<string, unknown>)
  }

  get storedVis() {
    return this.memo('storedVis', [this.prof], () => (this.prof.visibility as Record<string, Vis>) ?? {})
  }

  get tz() {
    return this.memo('tz', [], () => profileTimezones())
  }

  get localePreview() {
    return (() => {
    try { return new Intl.DateTimeFormat(this.f.locale || undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date()) } catch { return '' }
  })()
  }

  get weekStartLabel() {
    return this.f.firstDayOfWeek === '0'
    ? this.tr('settings.profile_week_sun', { defaultValue: 'Dimanche' })
    : this.f.firstDayOfWeek === '6'
      ? this.tr('settings.profile_week_sat', { defaultValue: 'Samedi' })
      : this.tr('settings.profile_week_mon', { defaultValue: 'Lundi' })
  }

  get labelSelect() {
    return this.memo('labelSelect', [this.f], () => (
    <Dropdown width="100%" value={this.f.language} onChange={v => this.set('language', v)}
      options={PROFILE_LANGS.map(([value, label]) => ({ value, label }))} />
  ))
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.vis, this.f, this.user], () => ({ t: this.tr, vis: this.vis, setV: this.setV.bind(this), f: this.f, set: this.set.bind(this), user: this.user }))
  }

  /** A part of the screen still written in React (<Section> is no .kbview element (./profileFields#Section)). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.vis, this.f], () => ({ t: this.tr, vis: this.vis, setV: this.setV.bind(this), f: this.f, set: this.set.bind(this) }))
  }

  /** A part of the screen still written in React (<Section> is no .kbview element (./profileFields#Section)). */
  get Part2() {
    return __parts.Part2
  }

  get part3_props() {
    return this.memo('part3_props', [this.tr, this.labelSelect, this.localePreview, this.weekStartLabel, this.f, this.tz], () => ({ t: this.tr, labelSelect: this.labelSelect, localePreview: this.localePreview, weekStartLabel: this.weekStartLabel, f: this.f, set: this.set.bind(this), tz: this.tz }))
  }

  /** A part of the screen still written in React (<Section> is no .kbview element (./profileFields#Section)). */
  get Part3() {
    return __parts.Part3
  }

  /** A part of the screen still written in React (<Section> is no .kbview element (./profileFields#Section)). */
  get Part4() {
    return __parts.Part4
  }

  get button_text() {
    return this.saved ? this.tr('settings.profile_saved') : this.tr('settings.save')
  }

  s(v: unknown) {
    return (typeof v === 'string' ? v : '')
  }

  set<K extends keyof ProfileTab['f']>(k: K, v: (ProfileTab['f'])[K]) {
    return this.setF(p => ({ ...p, [k]: v }))
  }

  setV(k: string) {
    return (v: Vis) => this.setVis(p => ({ ...p, [k]: v }))
  }

  async handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    this.busy = true
    try {
      const profile = {
        extraEmails: this.f.extraEmails.map(x => x.trim()).filter(Boolean),
        phone: this.f.phone, location: this.f.location, website: this.f.website,
        x: this.f.x, bluesky: this.f.bluesky, fediverse: this.f.fediverse, organization: this.f.organization,
        jobFunction: this.f.jobFunction, title: this.f.title, visibility: this.vis,
      }
      const preferences = {
        language: this.f.language, locale: this.f.locale, firstDayOfWeek: this.f.firstDayOfWeek, timezone: this.f.timezone, profile,
      }
      const { data } = await api.patch<{ user: ProfileTab['user'] }>('/me', {
        display_name: this.f.fullName,
        first_name: orNull(this.f.firstName),
        last_name:  orNull(this.f.lastName),
        preferences,
        // Sent on every save, unchanged values included: the server refuses a
        // governed field only when the value actually MOVES, so echoing back
        // what is already stored never trips a policy the person is subject to.
        name_pronunciation: orNull(this.f.namePronunciation),
        pronouns:           orNull(this.f.pronouns),
        work_location:      orNull(this.f.workLocation),
        introduction:       orNull(this.f.introduction),
        gender:             orNull(this.f.gender),
        birthday:           orNull(this.f.birthday),
      })
      if (data.user) this.updateUser(data.user as Parameters<ProfileTab['updateUser']>[0])
      if (this.f.language) setLanguage(this.f.language)
      this.saved = true; setTimeout(() => this.saved = false, 2200)
    } catch (err) {
      // A refusal by the organisation's policy arrives as a 403 carrying its own
      // sentence, which names the field. Swallowing it - what this form did
      // before - left somebody pressing Save forever on a field an administrator
      // had closed.
      const e2 = err as { message?: string; response?: { data?: { message?: string } } }
      this.toast.error(e2?.response?.data?.message ?? e2?.message ?? this.tr('settings.profile_save_failed', { defaultValue: 'Enregistrement impossible' }))
    } finally { this.busy = false }
  }

  panel_submit(_sender: unknown, args: EventArgs) {
    return this.handleSubmit(args.native as never)
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ProfileTabStores = ReturnType<ProfileTab['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ProfileTabHooks = ReturnType<ProfileTab['useHooks']>

export default ProfileTab.component()
