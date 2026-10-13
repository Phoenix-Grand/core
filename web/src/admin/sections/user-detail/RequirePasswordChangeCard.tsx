import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { Callout, Card, ConfirmDialog, Toggle, useToast } from '@ui'
import { api } from '../../../core/api/client'
import { useConfirm } from '../../../core/hooks/useConfirm'
import type { User } from '../../../core/types'
import { formatWhen } from '../format'

/**
 * "This password is suspect" — deliberately not the same control as
 * `PasswordResetCard`, which says "this password is gone".
 *
 * Arming the flag alone leaves the account signed in and its password working
 * exactly once more; the next sign-in ends on the forced-change screen, and
 * every write stays closed until the person picks a new password. An
 * administrator who suspects a password was shared over a chat does not want to
 * invent one, phone the person and dictate it — which is what the reset makes
 * them do.
 *
 * The card also states when the current password was chosen. Without that date
 * the expiry policy is an abstraction: an operator looking at an account cannot
 * tell whether it is about to be renewed or was renewed yesterday.
 */
export default function RequirePasswordChangeCard({ user }: { user: User }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const toast = useToast()
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm()

  const required = user.must_change_password === true
  // An account whose credential is held elsewhere has nothing to change here,
  // and the server refuses the write: the switch says so rather than offering
  // an action that can only fail.
  const external = !!user.oauth_provider

  const setRequired = useMutation({
    mutationFn: (value: boolean) =>
      api.post(`/admin/users/${user.id}/require-password-change`, { required: value }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-user', user.id] })
      void qc.invalidateQueries({ queryKey: ['admin', 'users'] })
      toast.success(t('admin.ud_rpc_done', { defaultValue: 'Enregistré.' }))
    },
    onError: () =>
      toast.error(
        t('admin.ud_rpc_error', { defaultValue: 'Modification impossible.' }),
      ),
  })

  const onToggle = async (value: boolean) => {
    if (value) {
      // Stating the cost before the click, not after: the account keeps its
      // sessions but loses every write until somebody sits down at it.
      const ok = await confirm({
        title: t('admin.ud_rpc_confirm_title', {
          defaultValue: 'Imposer le changement de mot de passe ?',
        }),
        message: t('admin.ud_rpc_confirm_msg', {
          defaultValue:
            "À sa prochaine connexion, ce compte devra choisir un nouveau mot de passe avant toute autre action. Ses sessions ouvertes ne sont pas fermées : pour cela, réinitialisez le mot de passe.",
        }),
        confirmLabel: t('admin.ud_rpc_confirm_ok', { defaultValue: 'Imposer' }),
        variant: 'warning',
      })
      if (!ok) return
    }
    setRequired.mutate(value)
  }

  return (
    <>
      <Card
        title={t('admin.ud_rpc_title', { defaultValue: 'Changement imposé' })}
        icon={<ShieldAlert className="w-4 h-4" />}
      >
        <Toggle
          label={t('admin.ud_rpc_label', {
            defaultValue: 'Demander un nouveau mot de passe à la prochaine connexion',
          })}
          description={t('admin.ud_rpc_desc', {
            defaultValue:
              "Le mot de passe actuel reste valable pour cette connexion-là ; toute écriture est refusée tant qu'il n'a pas été changé.",
          })}
          checked={required}
          disabled={external || setRequired.isPending}
          onChange={(e) => void onToggle(e.currentTarget.checked)}
        />

        {external && (
          <Callout t={t} variant="info" className="mt-3">
            {t('admin.ud_rpc_external', {
              defaultValue:
                "Ce compte n'a pas de mot de passe local : son authentification est gouvernée par un fournisseur d'identité ou un annuaire.",
            })}
          </Callout>
        )}

        {!external && (
          <p className="mt-3 text-sm text-text-secondary">
            {user.password_changed_at
              ? t('admin.ud_pw_changed_at', {
                  defaultValue: 'Mot de passe choisi le {{when}}.',
                  when: formatWhen(user.password_changed_at, i18n.language),
                })
              : t('admin.ud_pw_changed_unknown', {
                  defaultValue: 'Date du dernier changement de mot de passe inconnue.',
                })}
          </p>
        )}
      </Card>

      {confirmState && (
        <ConfirmDialog {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />
      )}
    </>
  )
}
