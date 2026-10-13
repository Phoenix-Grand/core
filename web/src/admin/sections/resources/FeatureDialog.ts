/**
 * Code-behind of `FeatureDialog.kbview` (converted from `FeatureDialog.tsx` by @kubuno/views-migrate).
 */
import { bind, type EventArgs, type MouseEventArgs } from '@kubuno/views'
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { errorMessage, useCreateFeature, useUpdateFeature, type FeatureInput, type ResourceFeature } from "./api"

import { ViewBase } from './FeatureDialog.kbview'
import * as __parts from './FeatureDialog.parts'

export type FeatureDialogProps = {
  feature: ResourceFeature | null
  onClose: () => void
}

export class FeatureDialog extends ViewBase {
  @bind accessor error: string | null = null
  tr!: FeatureDialogStores['t']
  name!: FeatureDialogHooks['name']
  setName!: FeatureDialogHooks['setName']
  note!: FeatureDialogHooks['note']
  setNote!: FeatureDialogHooks['setNote']
  create!: FeatureDialogStores['create']
  update!: FeatureDialogStores['update']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const create = useCreateFeature()
    const update = useUpdateFeature()
    return { t, create, update }
  }

  /** The screen's hooks that read its members (run after the fields of `useStores()` are set). React's rules apply: `use()` runs them on every render. */
  useHooks() {
    const [name, setName] = useState<string>(this.props.feature?.name ?? '')
    this.publish({ name, setName })
    const [note, setNote] = useState<string>(this.props.feature?.description ?? '')
    this.publish({ note, setNote })
    return { name, setName, note, setNote }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, create: s.create, update: s.update })
    const h = this.useHooks()
    this.publish({ name: h.name, setName: h.setName, note: h.note, setNote: h.setNote })
  }

  get busy(): boolean {
    return this.create.isPending || this.update.isPending
  }

  get enabled_unless_busy() {
    return !(this.busy)
  }

  get title() {
    return this.props.feature ? this.tr('admin.res_feature_edit') : this.tr('admin.res_feature_new')
  }

  get part1_props() {
    return this.memo('part1_props', [this.tr, this.name, this.setName], () => ({ t: this.tr, name: this.name, setName: this.setName }))
  }

  /** A part of the screen still written in React (<TextField> autoFocus: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.note, this.setNote], () => ({ t: this.tr, note: this.note, setNote: this.setNote }))
  }

  /** A part of the screen still written in React (<TextArea> rows: no .kbview property). */
  get Part2() {
    return __parts.Part2
  }

  get show_feature_feature_resource() {
    return !!(this.props.feature && this.props.feature.resource_count > 0)
  }

  get res_feature_rename_warning_count() {
    if (!(this.props.feature && this.props.feature.resource_count > 0)) return undefined as never
    return this.props.feature.resource_count
  }

  get show_error() {
    return !!(this.error)
  }

  async submit() {
    this.error = null
    const input: FeatureInput = {
      name: this.name.trim(),
      description: this.note.trim() === '' ? null : this.note.trim(),
    }
    try {
      if (this.props.feature) await this.update.mutateAsync({ id: this.props.feature.id, input })
      else         await this.create.mutateAsync(input)
      this.props.onClose()
    } catch (e) {
      this.error = errorMessage(e, this.tr('admin.res_save_failed'))
    }
  }

  panel_mouse_down(_sender: unknown, args: MouseEventArgs) {
    const e = args.native as React.MouseEvent<HTMLDivElement, MouseEvent>
    e.stopPropagation()
  }

  floating_window_confirm(_sender: unknown, _args: EventArgs) {
    void this.submit()
  }

  floating_window_close(_sender: unknown, _args: EventArgs) {
    this.props.onClose?.()
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type FeatureDialogStores = ReturnType<FeatureDialog['useStores']>

/** What `useHooks()` gives (the types of the fields it fills). */
export type FeatureDialogHooks = ReturnType<FeatureDialog['useHooks']>

export default FeatureDialog.component()
