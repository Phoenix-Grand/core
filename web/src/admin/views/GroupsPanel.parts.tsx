/**
 * The parts of `GroupsPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { formatDate } from "../../core/intl/datetime"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import type { UserGroup } from "../../core/types"
import { Users, Trash2, Edit2, X, Check, Shield, ChevronDown, ChevronRight } from "lucide-react"
import { Checkbox, Button, Input } from "@ui"
import { useConfirm } from "../../core/hooks/useConfirm"
import ConfirmDialog from "@ui/ConfirmDialog"
const KNOWN_PERMISSIONS: { key: string; labelKey: string; descKey: string }[] = [
  {
    key:      'api_tokens.create',
    labelKey: 'admin.perm_tokens_label',
    descKey:  'admin.perm_tokens_desc',
  },
  // D'autres permissions peuvent être ajoutées par les modules
]

function PermBadge({ perm }: { perm: string }) {
  const { t } = useTranslation()
  const known = KNOWN_PERMISSIONS.find((p) => p.key === perm)
  return (
    <span title={known ? t(known.descKey) : perm}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-light text-primary text-xs font-mono">
      <Shield size={10} />
      {known ? t(known.labelKey) : perm}
    </span>
  )
}
export { PermBadge }

function GroupForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Partial<UserGroup>
  onSave: (data: { name: string; description: string; permissions: string[]; is_default: boolean; release_exempt: boolean }) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [name, setName]             = useState(initial?.name ?? '')
  const [description, setDesc]      = useState(initial?.description ?? '')
  const [permissions, setPerms]     = useState<string[]>(initial?.permissions ?? [])
  const [isDefault, setIsDefault]   = useState(initial?.is_default ?? false)
  const [relExempt, setRelExempt]   = useState(initial?.release_exempt ?? false)
  const [customPerm, setCustomPerm] = useState('')

  const togglePerm = (key: string) => {
    setPerms((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]
    )
  }

  const addCustomPerm = () => {
    const k = customPerm.trim()
    if (k && !permissions.includes(k)) {
      setPerms((prev) => [...prev, k])
      setCustomPerm('')
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">{t('admin.g_name')} *</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('admin.g_name_ph')}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-1">{t('admin.g_description')}</label>
        <Input
          value={description}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t('admin.g_optional')}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-text-secondary mb-2">{t('admin.g_permissions')}</label>
        <div className="space-y-2 mb-3">
          {KNOWN_PERMISSIONS.map((p) => (
            <Checkbox
              key={p.key}
              label={t(p.labelKey)}
              description={t(p.descKey)}
              checked={permissions.includes(p.key)}
              onChange={() => togglePerm(p.key)}
            />
          ))}
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              value={customPerm}
              onChange={(e) => setCustomPerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addCustomPerm())}
              placeholder={t('admin.g_custom_perm_ph')}
              className="text-xs font-mono"
            />
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={addCustomPerm}>
            {t('admin.g_add')}
          </Button>
        </div>
        {permissions.filter((p) => !KNOWN_PERMISSIONS.some((kp) => kp.key === p)).length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {permissions
              .filter((p) => !KNOWN_PERMISSIONS.some((kp) => kp.key === p))
              .map((p) => (
                <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-2 text-text-secondary text-xs font-mono">
                  {p}
                  <button onClick={() => setPerms((prev) => prev.filter((x) => x !== p))}>
                    <X size={10} />
                  </button>
                </span>
              ))}
          </div>
        )}
      </div>

      <Checkbox
        label={t('admin.g_default')}
        description={t('admin.g_default_desc')}
        checked={isDefault}
        onChange={v => setIsDefault(v)}
      />

      {/* Protects a POPULATION, where the room's own flag protects a PLACE. */}
      <Checkbox
        label={t('admin.g_release_exempt')}
        description={t('admin.g_release_exempt_desc')}
        checked={relExempt}
        onChange={v => setRelExempt(v)}
      />

      <div className="flex gap-2 pt-1">
        <Button
          icon={<Check size={14} />}
          onClick={() => onSave({ name, description, permissions, is_default: isDefault, release_exempt: relExempt })}
          disabled={!name.trim()}
        >
          {t('settings.save')}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
export { GroupForm }

function GroupRow({ group, onDeleted }: { group: UserGroup & { member_count: number }; onDeleted: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [expanded, setExpanded]   = useState(false)
  const [editing, setEditing]     = useState(false)
  const [showMembers, setShowMem] = useState(false)
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()

  const { data: detail } = useQuery({
    queryKey: ['admin-group', group.id],
    queryFn: () =>
      api.get<{ group: UserGroup; members: { id: string; username: string; email: string; display_name: string }[] }>(
        `/admin/groups/${group.id}`
      ).then((r) => r.data),
    enabled: showMembers,
  })

  const updateGroup = useMutation({
    mutationFn: (data: object) => api.patch(`/admin/groups/${group.id}`, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-groups'] }); setEditing(false) },
  })

  const deleteGroup = useMutation({
    mutationFn: () => api.delete(`/admin/groups/${group.id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-groups'] }); onDeleted() },
  })

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/admin/groups/${group.id}/members/${userId}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin-group', group.id] }) },
  })

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* En-tête */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white">
        <button onClick={() => setExpanded(!expanded)} className="text-text-tertiary hover:text-text-primary">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-text-primary">{group.name}</p>
            {group.is_default && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-primary-light text-primary">{t('admin.g_default_badge')}</span>
            )}
            {group.is_system && (
              <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface-2 text-text-secondary">{t('admin.g_system_badge')}</span>
            )}
          </div>
          {group.description && (
            <p className="text-sm text-text-tertiary truncate">{group.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-sm text-text-tertiary">
            <Users size={12} className="inline mr-1" />{group.member_count}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => { setEditing(!editing); setExpanded(true) }}
              className="p-1.5 rounded text-text-tertiary hover:text-primary hover:bg-primary-light transition-colors"
              title={t('admin.edit')}
            >
              <Edit2 size={14} />
            </button>
            {!group.is_system && (
              <button
                onClick={async () => {
                  const ok = await confirm({
                    title:        t('admin.g_delete_title', { name: group.name }),
                    message:      t('admin.g_delete_msg'),
                    confirmLabel: t('common.delete'),
                    variant:      'danger',
                  })
                  if (ok) deleteGroup.mutate()
                }}
                className="p-1.5 rounded text-text-tertiary hover:text-danger hover:bg-danger-light transition-colors"
                title={t('common.delete')}
              >
                <Trash2 size={14} />
              </button>
            )}
            {confirmState && (
              <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
            )}
          </div>
        </div>
      </div>

      {/* Contenu étendu */}
      {expanded && (
        <div className="border-t border-border px-4 py-3 bg-surface-1 space-y-4">
          {editing ? (
            <GroupForm
              initial={group}
              onSave={(data) => updateGroup.mutate(data)}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              {/* Permissions */}
              <div>
                <p className="text-sm font-medium text-text-secondary mb-1.5">{t('admin.g_permissions')}</p>
                {group.permissions.length === 0 ? (
                  <p className="text-sm text-text-tertiary">{t('admin.g_no_permission')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {group.permissions.map((p) => <PermBadge key={p} perm={p} />)}
                  </div>
                )}
              </div>

              {/* Membres */}
              <div>
                <button
                  onClick={() => setShowMem(!showMembers)}
                  className="text-sm font-medium text-text-secondary mb-1.5 flex items-center gap-1 hover:text-text-primary"
                >
                  {showMembers ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {t('admin.g_members')} ({group.member_count})
                </button>
                {showMembers && detail && (
                  <div className="space-y-1 mt-1">
                    {detail.members.length === 0 && (
                      <p className="text-sm text-text-tertiary">{t('admin.g_no_member')}</p>
                    )}
                    {detail.members.map((m) => (
                      <div key={m.id} className="flex items-center justify-between px-2 py-1 rounded bg-white border border-border">
                        <span className="text-sm text-text-primary">{m.display_name} <span className="text-text-tertiary">({m.email})</span></span>
                        <button
                          onClick={() => removeMember.mutate(m.id)}
                          className="text-text-tertiary hover:text-danger"
                          title={t('admin.g_remove_member')}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <p className="text-sm text-text-tertiary">
                {t('admin.g_created')} {formatDate(new Date(group.created_at), 'date')}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
export { GroupRow }
