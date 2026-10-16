import { useState, useEffect, createContext } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  FileText, Image, Film, Music,
  Package, File, UserCircle2, Users, ShieldCheck, ShieldX,
  Type, Box,
} from 'lucide-react'
import { formatSize, filesApi, type FileItem, type Folder, type ActivityEntry, type AccessEntry } from './api'
import { FolderGlyph } from './FolderGlyph'
import { FloatingWindow } from '@ui'
import { Tabs, Dropdown, type DropdownOption } from '@ui'
import { useModulesStore } from '@kubuno/sdk'
import { SlotRegistry, Slot } from '@kubuno/sdk'
export type InfoTarget =
  | { type: 'file';   item: FileItem }
  | { type: 'folder'; item: Folder }

/** Cible courante de la fenêtre d'informations, exposée aux contributeurs de slot.
 *  Le module Drive injecte par ex. une section « Étiquettes » via le slot
 *  'files-info-extra' en lisant ce contexte. */
export interface FileInfoExtraTarget { kind: 'file' | 'folder'; id: string; name: string }
export const FileInfoExtraContext = createContext<FileInfoExtraTarget | null>(null)

type TF = (key: string, opts?: Record<string, unknown>) => string

// ── Helpers ────────────────────────────────────────────────────────────────────

function fileIcon(mimeType: string, name?: string) {
  const ext = (name ?? '').split('.').pop()?.toLowerCase()
  if (mimeType.startsWith('image/'))  return <Image   size={48} className="text-blue-400" />
  if (mimeType.startsWith('video/'))  return <Film    size={48} className="text-purple-400" />
  if (mimeType.startsWith('audio/'))  return <Music   size={48} className="text-green-400" />
  if (mimeType === 'application/pdf') return <FileText size={48} className="text-red-400" />
  if (mimeType.includes('word') || mimeType.includes('opendocument.text'))
    return <FileText size={48} className="text-blue-500" />
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet'))
    return <FileText size={48} className="text-green-500" />
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation'))
    return <FileText size={48} className="text-orange-400" />
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar'))
    return <Package size={48} className="text-text-tertiary" />
  if (mimeType.startsWith('model/') || (ext && ['glb', 'gltf', 'obj', 'stl', 'ply'].includes(ext)))
    return <Box  size={48} className="text-cyan-500" />
  if (
    mimeType.startsWith('font/') ||
    mimeType === 'application/x-font-ttf' || mimeType === 'application/x-font-otf' ||
    mimeType === 'application/font-woff'  || mimeType === 'application/font-woff2'  ||
    mimeType === 'application/vnd.ms-fontobject' ||
    (ext && ['ttf', 'otf', 'woff', 'woff2', 'eot'].includes(ext))
  )
    return <Type size={48} className="text-violet-500" />
  return <File size={48} className="text-text-tertiary" />
}

export function mimeLabel(mimeType: string, name: string | undefined, t: TF): string {
  const ext = (name ?? '').split('.').pop()?.toLowerCase()
  if (mimeType.startsWith('image/'))  return t('info.mime_image')
  if (mimeType.startsWith('video/'))  return t('info.mime_video')
  if (mimeType.startsWith('audio/'))  return t('info.mime_audio')
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'text/plain')      return t('info.mime_text')
  if (mimeType.includes('word'))      return t('info.mime_word')
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return t('info.mime_spreadsheet')
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return t('info.mime_presentation')
  if (mimeType.includes('zip'))       return t('info.mime_zip')
  if (mimeType.includes('tar'))       return t('info.mime_tar')
  if (mimeType.startsWith('model/') || (ext && ['glb', 'gltf', 'obj', 'stl', 'ply'].includes(ext)))
    return t('info.mime_3d')
  if (
    mimeType.startsWith('font/') ||
    mimeType.includes('font-ttf') || mimeType.includes('font-otf') ||
    mimeType.includes('font-woff') || mimeType.includes('ms-fontobject') ||
    (ext && ['ttf', 'otf', 'woff', 'woff2', 'eot'].includes(ext))
  )
    return t('info.mime_font', { ext: ext?.toUpperCase() ?? 'FONT' })
  return mimeType
}

function fmtDate(iso: string, lng: string) {
  return new Date(iso).toLocaleString(lng, {
    day: '2-digit', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function actionLabel(action: string, details: Record<string, unknown>, t: TF): string {
  switch (action) {
    case 'uploaded':  return t('info.act_uploaded')
    case 'renamed':   return t('info.act_renamed', { old: details.old_name, new: details.new_name })
    case 'moved':     return t('info.act_moved')
    case 'trashed':   return t('info.act_trashed')
    case 'restored':  return t('info.act_restored')
    case 'created':   return t('info.act_created')
    case 'deleted':   return t('info.act_deleted')
    default:          return action
  }
}

// Clé i18n pour un module_id
const MODULE_KEYS: Record<string, string> = {
  office: 'info.mod_office', code: 'info.mod_code', media: 'info.mod_media',
  photos: 'info.mod_photos', notes: 'info.mod_notes', paintsharp: 'info.mod_paintsharp',
}

function moduleLabel(moduleId: string, t: TF): string {
  return MODULE_KEYS[moduleId] ? t(MODULE_KEYS[moduleId]) : moduleId
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Row({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start py-2.5 border-b border-[#f1f3f4] last:border-0">
      <span className="text-sm text-text-tertiary w-36 flex-shrink-0">{label}</span>
      {children ?? <span className="text-sm text-text-primary break-all">{value}</span>}
    </div>
  )
}

function Avatar({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={name} className="w-8 h-8 rounded-full object-cover" />
  }
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
      {initials || <UserCircle2 size={16} />}
    </div>
  )
}

function PermBadge({ ok, label }: { ok: boolean; label: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-0.5 text-xs text-green-700 bg-green-50 rounded px-1.5 py-0.5">
      <ShieldCheck size={11} /> {label}
    </span>
  ) : null
}

function AccessRow({ entry, onRevoke }: { entry: AccessEntry; onRevoke: () => void }) {
  const { t } = useTranslation('drive')
  const displayName = entry.display_name || entry.email
  return (
    <div className="flex items-center gap-2.5 py-2.5 border-b border-[#f1f3f4] last:border-0">
      <Avatar name={displayName} avatarUrl={entry.avatar_url} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate">{displayName}</p>
        {entry.display_name && (
          <p className="text-xs text-text-tertiary truncate">{entry.email}</p>
        )}
        <div className="flex flex-wrap gap-1 mt-1">
          <PermBadge ok={entry.can_download} label={t('common.download')} />
          <PermBadge ok={entry.can_upload}   label={t('info.perm_edit')} />
          <PermBadge ok={entry.can_delete}   label={t('common.delete')} />
        </div>
      </div>
      <button
        onClick={onRevoke}
        title={t('info.revoke_access')}
        className="text-text-tertiary hover:text-danger p-1 rounded hover:bg-danger/5 flex-shrink-0"
      >
        <ShieldX size={15} />
      </button>
    </div>
  )
}

function groupActivities(activities: ActivityEntry[], lng: string) {
  const now = new Date()
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1)
  const groups: Map<string, ActivityEntry[]> = new Map()

  for (const a of activities) {
    const d = new Date(a.created_at)
    let label: string
    if (d >= sixMonthsAgo) {
      label = d.toLocaleString(lng, { month: 'long', year: 'numeric' })
      label = label.charAt(0).toUpperCase() + label.slice(1)
    } else {
      label = String(d.getFullYear())
    }
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(a)
  }
  return groups
}

function ActivityGroup({ label, entries }: { label: string; entries: ActivityEntry[] }) {
  const { t, i18n } = useTranslation('drive')
  return (
    <div className="mb-4">
      <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">{label}</p>
      <div className="space-y-0">
        {entries.map(e => (
          <div key={e.id} className="flex gap-2.5 py-2 border-b border-[#f1f3f4] last:border-0">
            <div className="w-7 h-7 rounded-full bg-surface-2 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-xs font-bold text-text-tertiary">
                {(e.user_display || '?')[0].toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary">
                <span className="font-medium">{e.user_display || t('info.user')}</span>
                {' · '}
                <span>{actionLabel(e.action, e.details, t)}</span>
              </p>
              <p className="text-xs text-text-tertiary mt-0.5">{fmtDate(e.created_at, i18n.language)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── OpenWith selector ──────────────────────────────────────────────────────────

function OpenWithSelect({
  fileId,
  currentModuleId,
  onSaved,
}: {
  fileId:          string
  currentModuleId: string | null
  onSaved:         (moduleId: string | null) => void
}) {
  const { t } = useTranslation('drive')
  const activeModules = useModulesStore(s => s.activeModules)
  const activeIds     = new Set(activeModules.map(m => m.module_id))

  // Modules enregistrés dans le slot 'files-open-with' et actifs
  const openers = SlotRegistry.getSlot('files-open-with').filter(e => activeIds.has(e.moduleId))

  const [selected, setSelected] = useState<string>(currentModuleId ?? '')
  const [saving,   setSaving]   = useState(false)

  useEffect(() => { setSelected(currentModuleId ?? '') }, [currentModuleId])

  async function save(value: string) {
    setSelected(value)
    setSaving(true)
    try {
      await filesApi.setOpenWith(fileId, value === '' ? null : value)
      onSaved(value === '' ? null : value)
    } finally {
      setSaving(false)
    }
  }

  const options: DropdownOption[] = [
    { value: '', label: t('info.default_auto') },
    ...openers.map(({ moduleId }) => ({ value: moduleId, label: moduleLabel(moduleId, t) })),
    ...(currentModuleId && !openers.find(e => e.moduleId === currentModuleId)
      ? [{ value: currentModuleId, label: t('info.mod_inactive', { name: moduleLabel(currentModuleId, t) }) }]
      : []),
  ]

  return (
    <Dropdown
      value={selected}
      onChange={save}
      options={options}
      width="100%"
      disabled={saving}
      height={32}
      fontSize={14}
    />
  )
}

// ── MetaField - champ éditable avec auto-save ──────────────────────────────────

function MetaField({
  label, value, placeholder, onSave,
}: {
  label:       string
  value:       string
  placeholder: string
  onSave:      (v: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [local,   setLocal]   = useState(value)

  useEffect(() => { setLocal(value) }, [value])

  function commit() {
    setEditing(false)
    if (local !== value) onSave(local)
  }

  return (
    <div className="py-2.5 border-b border-[#f1f3f4] last:border-0">
      <span className="text-xs text-text-tertiary block mb-1">{label}</span>
      {editing ? (
        <input
          autoFocus
          className="w-full text-sm text-text-primary bg-surface-1 border border-primary rounded px-2 py-1
                     focus:outline-none"
          value={local}
          onChange={e => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setLocal(value); setEditing(false) } }}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="w-full text-left text-sm text-text-primary hover:bg-surface-1 rounded px-1 py-0.5
                     min-h-[26px] transition-colors"
        >
          {local || <span className="text-text-tertiary italic">{placeholder}</span>}
        </button>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

interface Props {
  target:  InfoTarget | null
  onClose: () => void
}

type TabId = 'general' | 'details' | 'activity'

export function FileInfoContent({ target }: { target: NonNullable<Props['target']> }) {
  const { t, i18n } = useTranslation('drive')
  const [tab, setTab] = useState<TabId>('general')
  const qc = useQueryClient()

  const targetId   = target ? target.item.id : null
  const targetType = target?.type === 'folder' ? 'folder' : 'file'

  const { data: extra } = useQuery({
    queryKey: ['info-extra', targetType, targetId],
    queryFn: () =>
      targetType === 'folder'
        ? filesApi.getFolderInfoExtra(targetId!)
        : filesApi.getFileInfoExtra(targetId!),
    enabled: !!targetId && (tab === 'general'),
    staleTime: 30_000,
  })

  const { data: actData, isLoading: actLoading } = useQuery({
    queryKey: ['activity', targetType, targetId],
    queryFn: () =>
      targetType === 'folder'
        ? filesApi.getFolderActivity(targetId!)
        : filesApi.getFileActivity(targetId!),
    enabled: !!targetId && tab === 'activity',
    staleTime: 30_000,
  })

  const revokeMut = useMutation({
    mutationFn: (shareId: string) => filesApi.revokeAccess(shareId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['info-extra', targetType, targetId] })
    },
  })

  const metaMut = useMutation({
    mutationFn: (data: Parameters<typeof filesApi.updateUserMetadata>[1]) =>
      filesApi.updateUserMetadata(targetId!, data),
    onSuccess: (result) => {
      qc.setQueryData(['file', targetId], result.file)
    },
  })

  if (!target) return null

  const isFile = target.type === 'file'

  let icon: React.ReactNode
  let name: string

  if (isFile) {
    const f = target.item as FileItem
    icon = fileIcon(f.mime_type, f.name)
    name = f.name
  } else {
    icon = <FolderGlyph folder={target.item as Folder} size={48} />
    name = target.item.name
  }

  const activities = actData?.activities ?? []
  const actGroups  = groupActivities(activities, i18n.language)
  const owner      = extra?.owner ?? null
  const accessList = extra?.access ?? []

  // Onglet "Détails" (métadonnées éditables) uniquement pour les fichiers
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'general',  label: t('info.tab_general') },
    ...(isFile ? [{ id: 'details' as TabId, label: t('info.tab_details') }] : []),
    { id: 'activity', label: t('info.tab_activity') },
  ]

  // Infos pour l'onglet Général
  const generalRows: Array<{ label: string; value: string }> = isFile
    ? [
        { label: t('info.field_type'),     value: mimeLabel((target.item as FileItem).mime_type, target.item.name, t) },
        { label: t('common.size'),         value: formatSize((target.item as FileItem).size_bytes) },
        { label: t('info.field_location'), value: (target.item as FileItem).folder_id ? t('info.loc_in_folder') : t('info.loc_root') },
        { label: t('info.field_created'),  value: fmtDate(target.item.created_at, i18n.language) },
        { label: t('info.field_modified'), value: fmtDate(target.item.updated_at, i18n.language) },
        ...((target.item as FileItem).is_starred ? [{ label: t('info.field_status'), value: t('info.status_starred') }] : []),
        ...((target.item as FileItem).is_trashed ? [{ label: t('info.field_status'), value: t('info.status_trashed') }] : []),
      ]
    : [
        { label: t('info.field_type'),     value: t('info.type_folder') },
        { label: t('info.field_location'), value: (target.item as Folder).path || '/' },
        { label: t('info.field_created'),  value: fmtDate(target.item.created_at, i18n.language) },
        { label: t('info.field_modified'), value: fmtDate(target.item.updated_at, i18n.language) },
        ...((target.item as Folder).is_starred ? [{ label: t('info.field_status'), value: t('info.status_starred') }] : []),
      ]

  const fileMeta = isFile ? ((target.item as FileItem).metadata ?? {}) : {}
  const openWith = typeof fileMeta['open_with'] === 'string' ? fileMeta['open_with'] : null

  return (
    <div className="flex flex-col min-h-0 flex-1">
        {/* Icon + name */}
        <div className="flex flex-col items-center gap-2 pt-4 pb-4 px-6 flex-shrink-0">
          {icon}
          <p className="text-sm font-medium text-text-primary text-center max-w-full break-words px-2">
            {name}
          </p>
        </div>

        {/* Tabs */}
        <Tabs
          tabs={tabs}
          value={tab}
          onChange={setTab}
          className="px-6 flex-shrink-0"
        />

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">

          {/* ── Onglet Général ── */}
          {tab === 'general' && (
            <>
              <div className="mb-4">
                {generalRows.map((r, i) => <Row key={i} label={r.label} value={r.value} />)}
                {/* S'ouvre avec - uniquement pour les fichiers */}
                {isFile && (
                  <Row label={t('info.opens_with')}>
                    <OpenWithSelect
                      fileId={target.item.id}
                      currentModuleId={openWith}
                      onSaved={() => {
                        qc.invalidateQueries({ queryKey: ['files'] })
                      }}
                    />
                  </Row>
                )}
              </div>

              {/* Sections injectées par les modules (ex. Étiquettes du Drive). */}
              <FileInfoExtraContext.Provider
                value={target ? { kind: targetType, id: target.item.id, name: target.item.name } : null}
              >
                <Slot name="files-info-extra" />
              </FileInfoExtraContext.Provider>

              {targetId && (
                <div className="mb-4">
                  <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-2">
                    {t('info.owner')}
                  </p>
                  {owner ? (
                    <div className="flex items-center gap-2.5 py-1">
                      <Avatar name={owner.display_name || owner.email} avatarUrl={owner.avatar_url} />
                      <div>
                        <p className="text-sm font-medium text-text-primary">
                          {owner.display_name || owner.email}
                        </p>
                        {owner.display_name && (
                          <p className="text-xs text-text-tertiary">{owner.email}</p>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-text-tertiary italic">{t('info.not_available')}</p>
                  )}
                </div>
              )}

              {targetId && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Users size={13} className="text-text-tertiary" />
                    <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
                      {t('info.shared_access')}
                    </p>
                  </div>
                  {accessList.length === 0 ? (
                    <p className="text-sm text-text-tertiary italic">{t('info.no_active_share')}</p>
                  ) : (
                    accessList.map(a => (
                      <AccessRow key={a.share_id} entry={a} onRevoke={() => revokeMut.mutate(a.share_id)} />
                    ))
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Onglet Détails (métadonnées éditables, fichiers uniquement) ── */}
          {tab === 'details' && isFile && (
            <div>
              <p className="text-xs text-text-tertiary mb-3">
                {t('info.details_hint')}
              </p>
              <MetaField
                label={t('info.meta_title')}
                value={typeof fileMeta['title'] === 'string' ? fileMeta['title'] : ''}
                placeholder={t('info.meta_title_ph')}
                onSave={v => metaMut.mutate({ title: v })}
              />
              <MetaField
                label={t('info.meta_desc')}
                value={typeof fileMeta['description'] === 'string' ? fileMeta['description'] : ''}
                placeholder={t('info.meta_desc_ph')}
                onSave={v => metaMut.mutate({ description: v })}
              />
              <MetaField
                label={t('info.meta_author')}
                value={typeof fileMeta['author'] === 'string' ? fileMeta['author'] : ''}
                placeholder={t('info.meta_author_ph')}
                onSave={v => metaMut.mutate({ author: v })}
              />
              <MetaField
                label={t('info.meta_keywords')}
                value={
                  Array.isArray(fileMeta['keywords'])
                    ? (fileMeta['keywords'] as string[]).join(', ')
                    : typeof fileMeta['keywords'] === 'string'
                    ? fileMeta['keywords'] as string
                    : ''
                }
                placeholder={t('info.meta_keywords_ph')}
                onSave={v => metaMut.mutate({ keywords: v.split(',').map(s => s.trim()).filter(Boolean) })}
              />
            </div>
          )}

          {/* ── Onglet Activité ── */}
          {tab === 'activity' && (
            <>
              {actLoading && (
                <p className="text-sm text-text-tertiary py-4 text-center">{t('common.loading')}</p>
              )}
              {!actLoading && activities.length === 0 && (
                <p className="text-sm text-text-tertiary py-4 text-center italic">
                  {t('info.no_activity')}
                </p>
              )}
              {!actLoading && actGroups.size > 0 && (
                Array.from(actGroups.entries()).map(([label, entries]) => (
                  <ActivityGroup key={label} label={label} entries={entries} />
                ))
              )}
            </>
          )}
      </div>
    </div>
  )
}

/** The details window. Kept for the search view until `@kubuno/drive` is
 *  republished with `FileInfoContent`; the explorer uses the side panel. */
export default function FileInfoModal({ target, onClose }: Props) {
  const { t } = useTranslation('drive')
  if (!target) return null
  return (
    <FloatingWindow title={t('info.title')} onClose={onClose} defaultWidth={440} defaultHeight={560} resizable backdrop>
      <FileInfoContent target={target} />
    </FloatingWindow>
  )
}
