/**
 * Code-behind of `CaptchaPreview.kbcontrol` (converted from `CaptchaPreview.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { authApi, type CaptchaChallenge } from "../../../core/api/auth"

import { ViewBase } from './CaptchaPreview.kbcontrol'
import * as __parts from './CaptchaPreview.parts.tsx'

export class CaptchaPreview extends ViewBase {
  @bind accessor nonce = 0
  tr!: CaptchaPreviewStores['t']
  data!: CaptchaPreviewHooks['data']
  isFetching!: boolean

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const { data, isFetching } = useQuery({
      // No setting value in the key: the endpoint reads the SAVED configuration,
      // so the preview is refreshed by the panel invalidating this query once a
      // save has actually landed (see `afterWrite`) — not on the optimistic edit,
      // which would race the write and fetch the previous type. `nonce` is the
      // manual "regenerate".
      queryKey: ['captcha-preview', this.nonce] as const,
      queryFn:  () => authApi.getCaptcha().then(r => r.data),
      staleTime: 0,
      gcTime:    0,
    })
    this.publish({ data, isFetching })
    return { data, isFetching }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
    const h = this.useHooks()
    this.publish({ data: h.data, isFetching: h.isFetching })
  }

  get c(): CaptchaChallenge | undefined {
    return this.memo('c', [this.data], () => this.data)
  }

  get enabled_unless_is_fetching() {
    return !(this.isFetching)
  }

  get part1_props() {
    return this.memo('part1_props', [this.isFetching], () => ({ isFetching: this.isFetching }))
  }

  /** A part of the screen still written in React (an icon with a computed className). */
  get Part1() {
    return __parts.Part1
  }

  get show_c() {
    return !this.c
  }

  get show_not_c() {
    return !(!this.c)
  }

  get show_c_type_text() {
    if (!(!(!this.c))) return undefined as never
    return this.c.type === 'text'
  }

  get show_not_c_type_text() {
    if (!(!(!this.c))) return undefined as never
    return !(this.c.type === 'text')
  }

  get part2_props() {
    return this.memo('part2_props', [this.c, this.tr], () => {
      if (!(!(!this.c)) || !(this.c.type === 'text')) return undefined as never
      return ({ c: this.c, t: this.tr })
    })
  }

  /** A part of the screen still written in React (<img> has no .kbview element yet). */
  get Part2() {
    if (!(!(!this.c)) || !(this.c.type === 'text')) return undefined as never
    return __parts.Part2
  }

  get show_c_type_math() {
    if (!(!(!this.c)) || !(!(this.c.type === 'text'))) return undefined as never
    return this.c.type === 'math'
  }

  get show_not_c_type_math() {
    if (!(!(!this.c)) || !(!(this.c.type === 'text'))) return undefined as never
    return !(this.c.type === 'math')
  }

  get text() {
    if (!(!(!this.c)) || !(!(this.c.type === 'text')) || !(this.c.type === 'math')) return undefined as never
    return this.c.prompt
  }

  get part3_props() {
    return this.memo('part3_props', [this.c], () => {
      if (!(!(!this.c)) || !(!(this.c.type === 'text')) || !(!(this.c.type === 'math'))) return undefined as never
      return ({ c: this.c })
    })
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part3() {
    if (!(!(!this.c)) || !(!(this.c.type === 'text')) || !(!(this.c.type === 'math'))) return undefined as never
    return __parts.Part3
  }

  get visible() {
    return this.memo('visible', [this.show_c_type_math, this.show_not_c_type_text, this.c], () => {
      if (!(!(!this.c))) return undefined as never
      return this.show_c_type_math && this.show_not_c_type_text
    })
  }

  get visible2() {
    return this.memo('visible2', [this.show_not_c_type_math, this.show_not_c_type_text, this.c], () => {
      if (!(!(!this.c))) return undefined as never
      return this.show_not_c_type_math && this.show_not_c_type_text
    })
  }

  get visible3() {
    return this.memo('visible3', [this.show_c_type_text, this.show_not_c], () => this.show_c_type_text && this.show_not_c)
  }

  get visible4() {
    return this.memo('visible4', [this.visible, this.show_not_c], () => this.visible && this.show_not_c)
  }

  get visible5() {
    return this.memo('visible5', [this.visible2, this.show_not_c], () => this.visible2 && this.show_not_c)
  }

  get div_data() {
    return [((v: unknown) => (v === undefined || v === null ? '' : "captcha-preview=" + String(v)))(this.c?.type ?? 'loading')].filter(Boolean).join('; ')
  }

  panel_click(_sender: unknown, _args: MouseEventArgs) {
    this.nonce = this.nonce + 1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type CaptchaPreviewStores = ReturnType<CaptchaPreview['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type CaptchaPreviewHooks = ReturnType<CaptchaPreview['useHooks']>

export default CaptchaPreview.component()
