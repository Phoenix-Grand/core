import { formatDate } from '../core/intl/datetime'
import { useMemo, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { FileText, ExternalLink, Trash2 } from 'lucide-react'
import { StartPage } from '@ui'
import type { StartPageRecentItem, StartPageTab, MenuItem } from '@ui'
import ModuleFileBrowser, { type FileContextAction } from './ModuleFileBrowser'
import { recentApi, type FileItem } from './api'
import { usePendingDeletionStore } from '@kubuno/sdk'
// StartPage « complète » : lanceur (récents) + onglet « Parcourir » alimenté PAR
// DÉFAUT par le ModuleFileBrowser (navigation des répertoires du module dans
// `files`).
//
// Les RÉCENTS sont dérivés des MÊMES fichiers que le navigateur (clé de requête
// partagée `['mbf-files', rootId, prefix]`) : ainsi, supprimer ou renommer un
// fichier se reflète automatiquement dans les récents.

export interface ModuleStartPageBrowse {
  folderPathPrefix:    string
  title:               string
  onOpenFile?:         (file: FileItem) => boolean | void
  fileTypeModuleId?:   string
  toolbarContent?:     ReactNode
  fileContextActions?: FileContextAction[]
  emptyState?:         ReactNode
  hideImport?:         boolean
  importMenuItems?:    MenuItem[]
}

export interface ModuleStartPageProps {
  recentTitle?: string
  recentIcon?:  ReactNode
  /** Récents de repli (avant résolution du dossier) - sinon dérivés des fichiers. */
  recentItems?: StartPageRecentItem[]
  recentEmpty?: ReactNode
  browse:       ModuleStartPageBrowse
  browseLabel?: string
  extraTabs?:   StartPageTab[]
  defaultTab?:  string
}

export default function ModuleStartPage({
  recentTitle, recentIcon, recentItems, recentEmpty,
  browse, browseLabel, extraTabs = [], defaultTab = 'browse',
}: ModuleStartPageProps) {
  const { t, i18n } = useTranslation('drive')
  const qc = useQueryClient()
  const pendingDel = usePendingDeletionStore(s => s.pending)

  // RÉCENTS CENTRALISÉS : journal des ouvertures tenu par le drive (recentApi),
  // filtré sur cette application - au lieu d'un tri local par date de modification.
  const { data: recentData } = useQuery({
    queryKey: ['recent-opens', browse.fileTypeModuleId ?? ''],
    queryFn:  () => recentApi.list({ module: browse.fileTypeModuleId, limit: 12 }),
    refetchOnWindowFocus: true,
  })

  // Ouverture depuis le module → enregistre l'ouverture (centralise les récents).
  const openAndRecord = (f: FileItem) => {
    recentApi.record(f.id, browse.fileTypeModuleId)
    qc.invalidateQueries({ queryKey: ['recent-opens'] })
    browse.onOpenFile?.(f)
  }

  const fileRecents: StartPageRecentItem[] = useMemo(() => {
    return (recentData ?? []).map(f => ({
      id:          f.id,
      name:        f.name.replace(/\.[^.]+$/, ''),
      subtitle:    formatDate(f.opened_at, 'date'),
      icon:        <FileText size={18} className="text-text-tertiary" strokeWidth={1.5} />,
      pendingTone: pendingDel[f.id],
      onClick:  () => { openAndRecord(f) },
      actions: [
        { id: 'open',   label: t('common.open'),  icon: <ExternalLink size={15} />, onClick: () => { openAndRecord(f) } },
        { id: 'remove', label: t('app.clear_search', { defaultValue: "Remove from recent" }), icon: <Trash2 size={15} />, onClick: () => { recentApi.remove(f.id).then(() => qc.invalidateQueries({ queryKey: ['recent-opens'] })) } },
      ],
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentData, i18n.language, pendingDel])

  // Récents centralisés ; repli sur la prop fournie par l'app tant qu'il n'y en a pas.
  const recents = fileRecents.length ? fileRecents : (recentItems ?? [])

  const tabs: StartPageTab[] = [
    {
      id: 'browse',
      label: browseLabel ?? t('mfb.browse'),
      content: (
        <ModuleFileBrowser
          folderPathPrefix={browse.folderPathPrefix}
          title={browse.title}
          onOpenFile={openAndRecord}
          fileTypeModuleId={browse.fileTypeModuleId}
          toolbarContent={browse.toolbarContent}
          fileContextActions={browse.fileContextActions}
          emptyState={browse.emptyState}
          hideImport={browse.hideImport}
          importMenuItems={browse.importMenuItems}
        />
      ),
    },
    ...extraTabs,
  ]

  return (
    <StartPage
      recentTitle={recentTitle ?? t('nav.recent')}
      recentIcon={recentIcon}
      recentItems={recents}
      recentEmpty={recentEmpty}
      tabs={tabs}
      defaultTab={defaultTab}
    />
  )
}
