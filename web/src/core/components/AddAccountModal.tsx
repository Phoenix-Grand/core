import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@radix-ui/react-dialog'
import { X, Cloud, AlertCircle, UserPlus } from 'lucide-react'
import { useLinkedAccountsStore } from '../store/linkedAccountsStore'
import { announceAccountSwitched } from '../store/authStore'
import { api } from '../api/client'
import { authApi } from '../api/auth'
import { Button, Input } from '@ui'
import { apiErrorDetail } from '../api/errorMessage'

export interface Props {
  open: boolean
  onClose: () => void
  /** Re-connecting a « Déconnecté » row: its email, locked in the form. */
  prefillEmail?: string
  /** Slot the re-connected session must land back into. */
  slot?: number
}

// Adding an account signs a SECOND session into this browser (Google-style
// multi-account: the server parks each account's refresh token in its own
// HttpOnly slot cookie). The instance's own sign-in is the default; an account
// living on ANOTHER Kubuno instance stays available behind the link at the
// bottom (opened in a new tab, as before).
export default function AddAccountModal({ open, onClose, prefillEmail, slot }: Props) {
  const { t } = useTranslation()
  const addRemote = useLinkedAccountsStore((s) => s.add)

  const [remoteMode, setRemoteMode] = useState(false)
  const [instanceUrl, setInstanceUrl] = useState('')
  const [email, setEmail]             = useState('')
  const [password, setPassword]       = useState('')
  // Second factor step of the same-instance sign-in.
  const [totpSession, setTotpSession] = useState<string | null>(null)
  const [totpCode, setTotpCode]       = useState('')
  const [error, setError]             = useState<string | null>(null)
  const [loading, setLoading]         = useState(false)

  useEffect(() => {
    if (open) setEmail(prefillEmail ?? '')
  }, [open, prefillEmail])

  const reset = () => {
    setRemoteMode(false)
    setInstanceUrl('')
    setEmail('')
    setPassword('')
    setTotpSession(null)
    setTotpCode('')
    setError(null)
    setLoading(false)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  /** The freshly signed-in account becomes the active one: hard reload, like a switch. */
  const enterNewAccount = () => {
    announceAccountSwitched() // the other tabs share the cookie - reload them too
    window.location.href = '/'
  }

  const submitLocal = async () => {
    if (!email.trim()) { setError(t('account.err_email')); return }
    if (!password) { setError(t('account.err_password')); return }
    setLoading(true)
    try {
      const { data } = await authApi.login({
        login: email.trim(),
        password,
        device_name: navigator.userAgent.slice(0, 255),
        slot,
      })
      if ('requires_totp' in data && data.requires_totp) {
        setTotpSession(data.totp_session)
        return
      }
      enterNewAccount()
    } catch (err: unknown) {
      const msg = apiErrorDetail(err)
      setError(msg ?? t('login.error_generic', { defaultValue: 'Connexion impossible' }))
    } finally {
      setLoading(false)
    }
  }

  const submitTotp = async () => {
    if (!totpCode.trim() || !totpSession) return
    setLoading(true)
    try {
      await authApi.totpVerify({ code: totpCode.trim(), totp_session: totpSession, slot })
      enterNewAccount()
    } catch {
      setError(t('login.totp_invalid', { defaultValue: 'Code invalide' }))
    } finally {
      setLoading(false)
    }
  }

  const submitRemote = async () => {
    const base = instanceUrl.trim().replace(/\/$/, '')
    if (!base) { setError(t('account.err_url')); return }
    if (!email.trim()) { setError(t('account.err_email')); return }
    if (!password) { setError(t('account.err_password')); return }
    setLoading(true)
    try {
      // Passe par le backend (proxy) pour éviter les erreurs CORS
      const res = await api.post('/linked-account/login', {
        instance_url: base,
        email: email.trim(),
        password,
      })
      const { access_token, user } = res.data as {
        access_token: string
        user: { id: string; email: string; display_name: string | null; avatar_url: string | null }
      }
      addRemote({
        id:           `${base}:${user.id}`,
        instance_url: base,
        user_id:      user.id,
        email:        user.email,
        display_name: user.display_name,
        avatar_url:   user.avatar_url,
        access_token,
        added_at:     new Date().toISOString(),
      })
      handleClose()
    } catch (err: unknown) {
      const msg = apiErrorDetail(err)
      setError(msg ?? t('account.err_unreachable'))
    } finally {
      setLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (totpSession) await submitTotp()
    else if (remoteMode) await submitRemote()
    else await submitLocal()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-[9995]" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                     w-full max-w-sm bg-white rounded-xl shadow-xl z-[9996] p-6"
        >
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              {remoteMode
                ? <Cloud size={20} className="text-primary" strokeWidth={1.5} />
                : <UserPlus size={20} className="text-primary" strokeWidth={1.5} />}
              <Dialog.Title className="text-base font-semibold text-text-primary">
                {prefillEmail
                  ? t('account.reconnect_title', { defaultValue: 'Se reconnecter' })
                  : t('account.add_title')}
              </Dialog.Title>
            </div>
            <button
              onClick={handleClose}
              className="w-7 h-7 flex items-center justify-center rounded-full text-text-tertiary
                         hover:bg-surface-2 transition-colors"
            >
              <X size={16} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {totpSession ? (
              // Second factor step (same-instance sign-in only).
              <Input
                label={t('login.totp_label', { defaultValue: 'Code de validation' })}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="123456"
                autoFocus
                className="bg-surface-1"
              />
            ) : (
              <>
                {remoteMode && (
                  <Input
                    label={t('account.instance_url')}
                    type="url"
                    value={instanceUrl}
                    onChange={(e) => setInstanceUrl(e.target.value)}
                    placeholder="https://cloud.exemple.com"
                    autoFocus
                    className="bg-surface-1"
                  />
                )}
                <Input
                  label={t('register.email_label')}
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoFocus={!remoteMode}
                  disabled={!!prefillEmail}
                  className="bg-surface-1"
                />
                <Input
                  label={t('login.password')}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="bg-surface-1"
                />
              </>
            )}

            {error && (
              <div className="flex items-start gap-2 text-xs text-danger bg-danger-light px-3 py-2 rounded">
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 mt-1">
              <Button type="button" variant="ghost" onClick={handleClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={loading}>
                {loading ? t('login.verifying') : t('login.submit')}
              </Button>
            </div>

            {/* An account on ANOTHER Kubuno instance (opened in a new tab). */}
            {!totpSession && !prefillEmail && (
              <button
                type="button"
                onClick={() => { setRemoteMode(v => !v); setError(null) }}
                className="text-xs text-primary hover:underline self-start"
              >
                {remoteMode
                  ? t('account.local_mode', { defaultValue: '← Compte de cette instance' })
                  : t('account.remote_mode', { defaultValue: 'Compte d’une autre instance Kubuno…' })}
              </button>
            )}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
