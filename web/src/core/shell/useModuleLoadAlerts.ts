import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { PRIV } from '../authz/types'
import { usePrivileges } from '../authz/usePrivileges'
import { useModuleLoadStore } from '../modules/moduleLoadStore'
import { useNotificationStore } from '../store/notificationStore'
import { adminUrl } from '../../admin/adminAction'

/**
 * Turns a module whose UI bundle failed to load into a bell notification.
 *
 * ── Why this hook exists ─────────────────────────────────────────────────────
 * The runtime loader isolates a broken module so it never takes down the shell,
 * but that isolation used to be *total silence*: the module simply vanished from
 * the sidebar and the waffle, and the only trace was a `console.error` nobody
 * reads. A module built against a newer SDK surface than the host serves — a
 * removed re-export, say — would disappear with no visible cause. This hook is
 * the visible cause: it feeds the same header bell the alert centre uses, so an
 * operator learns a module is down without opening the devtools.
 *
 * ── The rules it respects (same as `useAlertFeed`) ───────────────────────────
 * * **Only holders of `core.modules.read` are told.** A failed UI bundle is an
 *   operator's problem; an ordinary user can do nothing with the news.
 * * **Announced once per module.** `pushKeyed` is keyed on the module id, so a
 *   list re-fetched on every WebSocket module event does not re-cry the same
 *   failure — including after the reader dismissed it.
 * * **Recovery is silent.** When a later attempt loads the module, the loader
 *   clears its failure; the already-shown notification simply stops being
 *   re-announced. (An acknowledged bell row is the reader's to dismiss.)
 */
export function useModuleLoadAlerts(): void {
  const { t } = useTranslation()
  const { can } = usePrivileges()
  const pushKeyed = useNotificationStore((s) => s.pushKeyed)
  const failures = useModuleLoadStore((s) => s.failures)

  const enabled = can(PRIV.MODULES_READ)

  useEffect(() => {
    if (!enabled) return
    // Oldest first, so the newest failure ends up on top of the list.
    for (const f of [...failures].reverse()) {
      pushKeyed(`moduleload:${f.moduleId}`, {
        title: t('modules.load_failed.title', { module: f.moduleId }),
        // `defaultValue`: a reason newer than the translations (views-mismatch) still says what happened.
        body: t(`modules.load_failed.reason.${f.reason}`, { detail: f.detail, defaultValue: f.detail }),
        moduleId: 'core',
        icon: 'PlugZap',
        link: adminUrl({ tab: 'modules' }),
      })
    }
  }, [enabled, failures, pushKeyed, t])
}
