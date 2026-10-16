/**
 * Code-behind of `AboutPage.kbview` (converted from `AboutPage.tsx` by @kubuno/views-migrate).
 */
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { api } from "../api/client"

import { ViewBase } from './AboutPage.kbview'
import * as __parts from './AboutPage.parts.tsx'

export class AboutPage extends ViewBase {
  tr!: AboutPageStores['t']
  health!: AboutPageStores['health']
  modulesData!: AboutPageStores['modulesData']

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t } = useTranslation()
    const { data: health } = useQuery({
      queryKey: ['health'],
      queryFn: () => fetch('/health').then(r => r.json()),
      staleTime: 60_000,
    })
    const { data: modulesData } = useQuery({
      queryKey: ['modules'],
      queryFn: () => api.get<{ modules: { module_id: string; base_url: string }[] }>('/modules').then(r => r.data),
    })
    return { t, health, modulesData }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, health: s.health, modulesData: s.modulesData })
  }

  get version(): string {
    return this.memo('version', [this.health], () => this.health?.version ?? '-')
  }

  get modulesCount(): number {
    return this.modulesData?.modules.length ?? 0
  }

  /** A part of the screen still written in React (<Cloud strokeWidth>: an icon attribute without a property). */
  get Part1() {
    return __parts.Part1
  }

  get p_text() {
    return this.memo('p_text', [this.version], () => "v" + String(this.version))
  }

  get part2_props() {
    return this.memo('part2_props', [this.tr, this.modulesCount], () => ({ t: this.tr, modulesCount: this.modulesCount }))
  }

  /** A part of the screen still written in React (a list callback destructuring its item). */
  get Part2() {
    return __parts.Part2
  }

  /** `<GithubMark>`, rendered by a ReactHost. */
  get GithubMark() {
    return __parts.GithubMark
  }

  get github_mark_props() {
    return this.memo('github_mark_props', [], () => ({ size: 18, className: "text-text-secondary flex-shrink-0" }))
  }

  /** A part of the screen still written in React (<a target rel>: attribute(s) without a .kbview property). */
  get Part3() {
    return __parts.Part3
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type AboutPageStores = ReturnType<AboutPage['useStores']>

export default AboutPage.component()
