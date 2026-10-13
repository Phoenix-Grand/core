/**
 * The parts of `ModuleAdminPage.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { CircleSlash, Package, TriangleAlert } from "lucide-react"
import { Card, Toggle, useToast } from "@ui"
import { PRIV } from "../../core/authz/types"
import { usePrivileges } from "../../core/authz/usePrivileges"
import { findIcon } from "../../core/utils/iconMap"
import { LIVE_STATE_KEY, useToggleModule, type AdminModule, type ModuleLiveState, type ModuleSettingGroup } from "../adminModules"

function StateChip({ state }: { state: ModuleLiveState }) {
  const { t } = useTranslation()
  const skin: Record<ModuleLiveState, string> = {
    running:     'bg-success-light text-success',
    unknown:     'bg-surface-2 text-text-secondary',
    disabled:    'bg-surface-2 text-text-tertiary',
    unreachable: 'bg-warning-light text-warning',
  }
  const icon = state === 'disabled' ? <CircleSlash size={12} />
    : state === 'unreachable' ? <TriangleAlert size={12} />
      : null
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${skin[state]}`}
      style={{ fontSize: 'var(--kb-text-micro)' }}>
      {icon}
      {t(LIVE_STATE_KEY[state])}
    </span>
  )
}
export { StateChip }

function ModuleStateCard({ module, state }: { module: AdminModule; state: ModuleLiveState }) {
  const { t } = useTranslation()
  const { can } = usePrivileges()
  const toast = useToast()
  const toggle = useToggleModule()
  const canManage = can(PRIV.MODULES_MANAGE)

  const flip = () => toggle.mutate(
    { id: module.id, is_enabled: !module.is_enabled },
    {
      onSuccess: (data) => {
        if (!data.is_enabled && data.also_disabled.length > 0) {
          toast.info(t('admin.m_cascade', { list: data.also_disabled.join(', ') }))
        }
      },
      onError: () => toast.error(t('admin.m_toggle_failed')),
    },
  )

  return (
    <Card title={t('admin.m_state_title')} icon={<Package size={16} />} className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip state={state} />
            {state === 'unreachable' && (
              <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {t('admin.m_unreachable_hint')}
              </span>
            )}
          </div>
          {module.description && (
            <p className="mt-2 leading-relaxed text-text-secondary"
              style={{ fontSize: 'var(--kb-text-meta)' }}>{module.description}</p>
          )}
        </div>
        {canManage && (
          <Toggle
            checked={module.is_enabled}
            onChange={flip}
            label={t('admin.m_toggle_label')}
          />
        )}
      </div>
    </Card>
  )
}
export { ModuleStateCard }

function GroupHeading({ group }: { group: ModuleSettingGroup }) {
  const Icon = findIcon(group.icon)
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2">
        {Icon && <Icon size={16} className="shrink-0 text-text-secondary" />}
        {/* Section title: plain 14px bold, no small caps, no accent bar. */}
        <h2 className="text-sm font-bold text-text-primary">{group.label}</h2>
      </div>
      {group.description && (
        <p className="mt-1 max-w-3xl leading-relaxed text-text-secondary"
          style={{ fontSize: 'var(--kb-text-meta)' }}>
          {group.description}
        </p>
      )}
    </div>
  )
}
export { GroupHeading }
