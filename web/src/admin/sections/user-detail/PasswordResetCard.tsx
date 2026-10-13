import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { Button, Card } from '@ui'
import type { User } from '../../../core/types'
import ResetPasswordDialog from '../../dialogs/ResetPasswordDialog'
import { useAdminAction } from '../../adminAction'

/**
 * Administrator-driven password reset, inside the account's Security tab.
 *
 * The card owns nothing but the open/closed state: `ResetPasswordDialog` runs
 * its own request and its own two-step flow (form → outcome). `onDone` is not a
 * close signal — it fires once the reset succeeded, which is when the account's
 * `must_change_password` flag and its session list have both changed server-side
 * and must be refetched here.
 */
export default function PasswordResetCard({ user }: { user: User }) {
  const { t } = useTranslation('core')
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  // `/admin/users?user=<id>&pane=security&action=reset-password` opens the dialog
  // itself — the end of the chain the admin search starts (adminAction.ts).
  useAdminAction('reset-password', () => setOpen(true))

  return (
    <>
      <Card
        title={t('admin.ud_pw_title', { defaultValue: 'Mot de passe' })}
        icon={<KeyRound className="w-4 h-4" />}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <p className="text-sm text-text-secondary max-w-prose">
            {t('admin.ud_pw_hint', {
              defaultValue:
                "Définit un nouveau mot de passe et ferme toutes les sessions ouvertes de ce compte.",
            })}
          </p>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {t('pwreset.open', { defaultValue: 'Réinitialiser le mot de passe' })}
          </Button>
        </div>
      </Card>

      {open && (
        <ResetPasswordDialog
          userId={user.id}
          userLabel={user.display_name || user.username}
          userEmail={user.email}
          onClose={() => setOpen(false)}
          onDone={() => {
            // The reset flips must_change_password and revokes every session.
            qc.invalidateQueries({ queryKey: ['admin-user', user.id] })
            qc.invalidateQueries({ queryKey: ['admin-user-sessions', user.id] })
            qc.invalidateQueries({ queryKey: ['admin', 'users'] })
          }}
        />
      )}
    </>
  )
}
