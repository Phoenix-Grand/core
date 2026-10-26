/**
 * Code-behind of `ArchiveOptions.kbcontrol` (converted from `ArchiveOptions.tsx` by @kubuno/views-migrate).
 */
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { MyExportPolicy } from "./api"
import { formatBytes } from "../../../../admin/sections/format"

import { ViewBase } from './ArchiveOptions.kbcontrol'
import * as __parts from './ArchiveOptions.parts'

export interface ArchiveOptionsProps {
  policy:  MyExportPolicy
  format:  string
  maxFileMb: number
  onMaxFileMb: (value: number) => void
}

const STEPS = [100, 250, 500, 1_024, 2_048, 5_120, 10_240]

export class ArchiveOptions extends ViewBase {
  tr!: ArchiveOptionsStores['t']
  language!: string
  options!: { value: string; label: string; description: string | undefined; }[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    return { t, language: i18n.resolvedLanguage || i18n.language }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const t = this.tr
    const options = useMemo(() => {
      const values = STEPS.filter(v => v < this.props.policy.max_file_mb).concat(this.props.policy.max_file_mb)
      return values.map(v => ({
        value: String(v),
        label: formatBytes(v * 1_024 ** 2, this.language),
        description: v === this.props.policy.max_file_mb
          ? t('settings.mde_size_max', { defaultValue: 'Maximum autorisé par l’instance' })
          : undefined,
      }))
    }, [this.props.policy.max_file_mb, t, this.language])
    this.publish({ options })
    return { options }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, language: s.language })
    const h = this.useHooks()
    this.publish({ options: h.options })
  }

  get mde_opt_format_desc_format() {
    return this.props.format.toUpperCase()
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr], () => ({ t: this.tr }))
  }

  /** A part of the screen still written in React (<label htmlFor>: attribute(s) without a .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.props, this.options, this.tr], () => ({ maxFileMb: this.props.maxFileMb, onMaxFileMb: this.props.onMaxFileMb, options: this.options, t: this.tr }))
  }

  /** A part of the screen still written in React (<ComboBox> id, width: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get p_text() {
    return this.props.policy.hold_hours > 0
            ? this.tr('settings.mde_opt_once_hold', {
                defaultValue:
                  'L’archive est produite une fois. Elle sera téléchargeable {{hold}} h après sa production, restera disponible {{days}} jours et pourra être récupérée {{max}} fois. Une nouvelle demande remplace la précédente.',
                hold: this.props.policy.hold_hours,
                days: this.props.policy.retention_days,
                max:  this.props.policy.max_downloads,
              })
            : this.tr('settings.mde_opt_once_desc', {
                defaultValue:
                  'L’archive est produite une fois. Elle reste disponible {{days}} jours et peut être récupérée {{max}} fois ; passé cela, il faut en redemander une. Une nouvelle demande remplace la précédente.',
                days: this.props.policy.retention_days,
                max:  this.props.policy.max_downloads,
              })
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ArchiveOptionsStores = ReturnType<ArchiveOptions['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type ArchiveOptionsHooks = ReturnType<ArchiveOptions['useHooks']>

export default ArchiveOptions.component()
