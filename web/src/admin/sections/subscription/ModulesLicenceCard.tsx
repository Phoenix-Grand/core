/**
 * Code-behind of `ModulesLicenceCard.kbcontrol` (converted from `ModulesLicenceCard.tsx` by @kubuno/views-migrate).
 */
import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Badge, type DataTableColumn } from "@ui"
import { formatDay } from "../format"
import type { InstalledModule } from "./api"
import { ExternalLink } from "./ExternalLink"

import { ViewBase } from './ModulesLicenceCard.kbcontrol'
import * as __parts from './ModulesLicenceCard.parts'

export type ModulesLicenceCardProps = { modules: InstalledModule[] }

export class ModulesLicenceCard extends ViewBase {
  tr!: ModulesLicenceCardStores['t']
  columns!: DataTableColumn<InstalledModule>[]

  /** The screen's hooks that read nothing of the view (stores, translations…), as the TSX called them. React's rules apply: `use()` runs them on every render. */
  useStores() {
    const { t, i18n } = useTranslation()
    const columns = useMemo<DataTableColumn<InstalledModule>[]>(() => [
      {
        id: 'name',
        header: t('admin.sub_mod_col_name'),
        primary: true,
        required: true,
        sortValue: r => r.display_name,
        cell: r => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-text-primary">{r.display_name}</span>
            <span className="truncate font-mono text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {r.id}
            </span>
          </span>
        ),
      },
      {
        id: 'version',
        header: t('admin.sub_mod_col_version'),
        sortValue: r => r.version,
        cell: r => <span className="tabular-nums">{r.version}</span>,
      },
      {
        id: 'licence',
        header: t('admin.sub_mod_col_licence'),
        sortValue: r => r.license ?? '',
        // A module that declares nothing is shown as declaring nothing. Filling
        // the gap with the core's own licence would be the console asserting
        // something the module never said.
        cell: r => r.license
          ? <Badge variant="default">{r.license}</Badge>
          : <span className="text-text-tertiary">{t('admin.sub_mod_licence_unknown')}</span>,
      },
      {
        id: 'state',
        header: t('admin.sub_mod_col_state'),
        sortValue: r => r.is_enabled,
        cell: r => r.is_enabled
          ? <span className="text-text-secondary">{t('admin.sub_mod_enabled')}</span>
          : <span className="text-text-tertiary">{t('admin.sub_mod_disabled')}</span>,
      },
      {
        id: 'installed',
        header: t('admin.sub_mod_col_installed'),
        sortValue: r => r.installed_at,
        cell: r => (
          <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
            {formatDay(r.installed_at, i18n.language)}
          </span>
        ),
      },
      {
        id: 'source',
        header: t('admin.sub_mod_col_source'),
        cell: r => r.homepage_url
          ? <ExternalLink href={r.homepage_url}>{t('admin.sub_mod_source_link')}</ExternalLink>
          : <span className="text-text-tertiary">—</span>,
      },
    ], [t, i18n.language])
    return { t, i18n, columns }
  }

  /** Runs the hooks and publishes what they give as fields (the bindings, the getters and the methods read them). */
  use(): void {
    const s = this.useStores()
    this.publish({ tr: s.t, columns: s.columns })
  }

  get part1_props() {
    return this.memo('part1_props', [this.props, this.columns, this.tr], () => ({ modules: this.props.modules, columns: this.columns, t: this.tr }))
  }

  /** A part of the screen still written in React (<DataTable> columns, rowKey, defaultSort, t: no .kbview property). */
  get Part1() {
    return __parts.Part1
  }

}

/** What `useStores()` gives (the types of the fields it fills). */
export type ModulesLicenceCardStores = ReturnType<ModulesLicenceCard['useStores']>

export default ModulesLicenceCard.component()
