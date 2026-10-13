/**
 * Code-behind of `ThemeDevicePreview.kbcontrol` (converted from `ThemeDevicePreview.tsx` by @kubuno/views-migrate).
 */
import { bind, type MouseEventArgs } from '@kubuno/views'
import { useTranslation } from "react-i18next"
import { Smartphone, Tablet, Monitor } from "lucide-react"
import ThemePreviewGallery from "./ThemePreviewGallery"
import type { ThemeDef } from "../../core/store/themeStore"

import { ViewBase } from './ThemeDevicePreview.kbcontrol'
import * as __parts from './ThemeDevicePreview.parts.tsx'

type Device = 'mobile' | 'tablet' | 'desktop'

const DEVICES: { id: Device; Icon: typeof Monitor; w: number | null; labelKey: string; def: string }[] = [
  { id: 'mobile',  Icon: Smartphone, w: 390,  labelKey: 'admin.t_dev_mobile',  def: 'Mobile' },
  { id: 'tablet',  Icon: Tablet,     w: 820,  labelKey: 'admin.t_dev_tablet',  def: 'Tablette' },
  { id: 'desktop', Icon: Monitor,    w: null,  labelKey: 'admin.t_dev_desktop', def: 'PC' },
]

export type ThemeDevicePreviewProps = { theme: ThemeDef }

export class ThemeDevicePreview extends ViewBase {
  @bind accessor device: Device = 'desktop'
  tr!: ThemeDevicePreviewStores['t']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    return { t }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t })
  }

  get cur(): { id: Device; Icon: typeof Monitor; w: number | null; labelKey: string; def: string; } {
    return this.memo('cur', [this.device], () => DEVICES.find((d) => d.id === this.device) ?? DEVICES[2])
  }

  /** The rows of the Repeater over `DEVICES`. */
  get rows_devices() {
    return this.memo('rows_devices', [this.device, this.tr], () => DEVICES.map((d) => {
      return { d, button_class: `flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors
              ${this.device === d.id ? 'bg-white text-primary shadow-sm' : 'text-text-secondary hover:text-text-primary'}`, icon: { c: d.Icon } as unknown as string, text: this.tr(d.labelKey, { defaultValue: d.def }), show_d_w: !!(d.w), span_text: ((d.w)) ? (String(d.w) + "px") : undefined, key: d.id }
    }))
  }

  get show_cur_w() {
    return !!(this.cur.w)
  }

  get show_not_cur_w() {
    return !(this.cur.w)
  }

  get part1_props() {
    return this.memo('part1_props', [this.cur, this.props], () => {
      if (!(this.cur.w)) return undefined as never
      return ({ cur_w: this.cur?.w, theme: this.props.theme })
    })
  }

  /** A part of the screen still written in React (<div> with a computed style). */
  get Part1() {
    if (!(this.cur.w)) return undefined as never
    return __parts.Part1
  }

  /** `<ThemePreviewGallery>`, rendered by a ReactHost. */
  get ThemePreviewGallery() {
    if (!(!(this.cur.w))) return undefined as never
    return ThemePreviewGallery
  }

  get theme_preview_gallery_props() {
    return this.memo('theme_preview_gallery_props', [this.props, this.cur], () => {
      if (!(!(this.cur.w))) return undefined as never
      return ({ theme: this.props.theme })
    })
  }

  panel_click(_sender: unknown, args: MouseEventArgs) {
    const { d } = args.row as RowOf_rows_devices
    this.device = d.id
  }

}

type RowOf_rows_devices = ThemeDevicePreview['rows_devices'][number]

/** What `useStores()` gives (the types of the fields it fills). */
export type ThemeDevicePreviewStores = ReturnType<ThemeDevicePreview['useStores']>

export default ThemeDevicePreview.component()
