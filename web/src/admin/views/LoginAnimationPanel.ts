/**
 * Code-behind of `LoginAnimationPanel.kbview` (converted from `LoginAnimationPanel.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import LoginAnimationGL from "../../core/auth/LoginAnimationGL"
import { animTuning, parseAnimParams, ANIM_DEFAULTS, ANIM_SLIDERS, type AnimParams } from "../../core/auth/animTuning"

import { ViewBase } from './LoginAnimationPanel.kbview'
import * as __parts from './LoginAnimationPanel.parts.tsx'

const SETTING_KEY = 'appearance.login_animation'

export class LoginAnimationPanel extends ViewBase {
  @bind accessor dirty = false
  qc!: LoginAnimationPanelStores['qc']
  params!: AnimParams
  saved!: LoginAnimationPanelStores['saved']
  saveM!: LoginAnimationPanelHooks['saveM']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const qc = useQueryClient()
    const [params, setParams] = useState<AnimParams>(animTuning.get())
    const { data: saved } = useQuery({
      queryKey: ['admin', 'login-animation'],
      queryFn: () =>
        api.get<{ config: Record<string, unknown> }>('/config')
          .then((r) => parseAnimParams(r.data.config[SETTING_KEY])),
    })
    useEffect(() => animTuning.subscribe(() => setParams({ ...animTuning.get() })), [])
    return { qc, params, setParams, saved }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const qc = this.qc
    const saved = this.saved
    useEffect(() => {
      if (saved) { animTuning.set(saved); this.dirty = false }
    }, [saved])
    const saveM = useMutation({
      mutationFn: () => api.patch('/admin/settings', { [SETTING_KEY]: animTuning.get() }),
      onSuccess: () => {
        this.dirty = false
        qc.invalidateQueries({ queryKey: ['public-config'] })
        qc.invalidateQueries({ queryKey: ['admin', 'login-animation'] })
      },
    })
    this.publish({ saveM })
    return { saveM }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ qc: s.qc, params: s.params, saved: s.saved })
    const h = this.useHooks()
    this.publish({ saveM: h.saveM })
  }

  /** `<LoginAnimationGL>`, rendered by a ReactHost. */
  get LoginAnimationGL() {
    return LoginAnimationGL
  }

  /** A part of the screen still written in React (<input> has no .kbview element yet). */
  get Part1() {
    return __parts.Part1
  }

  /** The rows of the Repeater over `ANIM_SLIDERS`. */
  get rows_anim_sliders() {
    return this.memo('rows_anim_sliders', [this.params, this.memo, this.dirty], () => ANIM_SLIDERS.map((s) => {
      return { s, text: this.params[s.key].toFixed(s.step < 0.01 ? 4 : 2), show_params_s_key: this.params[s.key] !== ANIM_DEFAULTS[s.key], part1_props: { s: s, params: this.params, onSlide: this.memo("onSlide:bound", [], () => this.onSlide.bind(this)) }, key: s.key }
    }))
  }

  get enabled_unless_dirty() {
    return !(!this.dirty)
  }

  get show_save_m_is_success_dirty() {
    return this.saveM.isSuccess && !this.dirty
  }

  onSlide(key: keyof AnimParams, value: number) {
    animTuning.set({ [key]: value })
    this.dirty = true
  }

  button_click(_sender: unknown, _args: MouseEventArgs) {
    this.saveM.mutate()
  }

  button_click2(_sender: unknown, _args: MouseEventArgs) {
 animTuning.reset(); this.dirty = true }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type LoginAnimationPanelStores = ReturnType<LoginAnimationPanel['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type LoginAnimationPanelHooks = ReturnType<LoginAnimationPanel['useHooks']>

export default LoginAnimationPanel.component()
