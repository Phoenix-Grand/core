/**
 * The parts of `DomainDetail.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { CheckCircle2, Copy, RefreshCw, ShieldCheck, Trash2, Star } from "lucide-react"
import { Button, Callout, Card, useToast } from "@ui"
import type { DomainDetail } from './DomainDetail'

function RecordField({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation()
  const toast = useToast()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-small)' }}>{label}</span>
      <div className="flex min-w-0 items-center gap-2 rounded border border-border bg-surface-1 px-2 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {value}
        </code>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-text-tertiary transition-colors hover:bg-surface-2 hover:text-text-primary"
          title={t('admin.dom_copy')}
          aria-label={t('admin.dom_copy')}
          onClick={() => {
            void navigator.clipboard?.writeText(value)
            toast.success(t('admin.dom_copied'))
          }}
        >
          <Copy size={14} />
        </button>
      </div>
    </div>
  )
}
export { RecordField }

export function Part1({ t, domain, domain_last_error, canManage, verify, setError, toast, fail, domain_last_checked_at }: { t: NonNullable<DomainDetail['tr']>; domain: NonNullable<DomainDetail['domain']>; domain_last_error: string; canManage: NonNullable<DomainDetail['props']['canManage']>; verify: NonNullable<DomainDetail['verify']>; setError: NonNullable<DomainDetail['setError']>; toast: NonNullable<DomainDetail['toast']>; fail: DomainDetail['fail']; domain_last_checked_at: string }) {
  return (
    <Card title={<span className="flex items-center gap-2"><ShieldCheck size={16} /> {t('admin.dom_proof_title')}</span>}>
            <div className="flex flex-col gap-3 p-1">
              {domain.verified ? (
                <p className="flex items-center gap-2 text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                  <CheckCircle2 size={16} className="text-success" />
                  {t('admin.dom_proof_done')}
                </p>
              ) : (
                <p className="text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
                  {t('admin.dom_proof_intro', { name: domain.name })}
                </p>
              )}
    
              <div className="grid gap-3 sm:grid-cols-[8rem_1fr_2fr]">
                <RecordField label={t('admin.dom_record_type')}  value={domain.record_type} />
                <RecordField label={t('admin.dom_record_name')}  value={domain.record_name} />
                <RecordField label={t('admin.dom_record_value')} value={domain.expected_record} />
              </div>
              <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
                {t('admin.dom_record_hint')}
              </p>
    
              {domain.last_error && !domain.verified && (
                <Callout variant="warning" t={t}>{domain_last_error}</Callout>
              )}
    
              {canManage && (
                <div className="flex items-center gap-3">
                  <Button
                    variant={domain.verified ? 'secondary' : 'primary'}
                    disabled={verify.isPending}
                    onClick={() => {
                      setError(null)
                      verify.mutate(domain.id, {
                        onSuccess: d => d.verified
                          ? toast.success(t('admin.dom_verify_ok', { name: d.name }))
                          : toast.error(t('admin.dom_verify_ko')),
                        onError: fail,
                      })
                    }}
                  >
                    <RefreshCw size={16} /> {domain.verified ? t('admin.dom_verify_again') : t('admin.dom_verify')}
                  </Button>
                  {domain.last_checked_at && (
                    <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
                      {t('admin.dom_last_checked', { when: new Date(domain_last_checked_at).toLocaleString() })}
                    </span>
                  )}
                </div>
              )}
            </div>
          </Card>
  )
}

export function Part2({ domain, promote, t, confirm, setError, toast, fail }: { domain: NonNullable<DomainDetail['domain']>; promote: NonNullable<DomainDetail['promote']>; t: NonNullable<DomainDetail['tr']>; confirm: NonNullable<DomainDetail['confirm']>; setError: NonNullable<DomainDetail['setError']>; toast: NonNullable<DomainDetail['toast']>; fail: DomainDetail['fail'] }) {
  return (
    <Button
                      variant="secondary"
                      disabled={!domain.verified || promote.isPending}
                      title={domain.verified ? undefined : t('admin.dom_promote_needs_verify')}
                      onClick={async () => {
                        const ok = await confirm({
                          title: t('admin.dom_promote_title'),
                          message: t('admin.dom_promote_confirm', { name: domain.name }),
                          confirmLabel: t('admin.dom_promote'),
                        })
                        if (!ok) return
                        setError(null)
                        promote.mutate(domain.id, {
                          onSuccess: () => toast.success(t('admin.dom_promote_ok', { name: domain.name })),
                          onError: fail,
                        })
                      }}
                    >
                      <Star size={16} /> {t('admin.dom_promote')}
                    </Button>
  )
}

export function Part3({ blockers, remove, confirm, t, domain, setError, onGone, fail }: { blockers: NonNullable<DomainDetail['blockers']>; remove: NonNullable<DomainDetail['remove']>; confirm: NonNullable<DomainDetail['confirm']>; t: NonNullable<DomainDetail['tr']>; domain: NonNullable<DomainDetail['domain']>; setError: NonNullable<DomainDetail['setError']>; onGone: NonNullable<DomainDetail['props']['onGone']>; fail: DomainDetail['fail'] }) {
  return (
    <Button
                    variant="danger"
                    disabled={blockers.length > 0 || remove.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: t('admin.dom_remove_title'),
                        message: t('admin.dom_remove_confirm', { name: domain.name }),
                        confirmLabel: t('admin.dom_remove'),
                        variant: 'danger',
                      })
                      if (!ok) return
                      setError(null)
                      remove.mutate(domain.id, { onSuccess: onGone, onError: fail })
                    }}
                  >
                    <Trash2 size={16} /> {t('admin.dom_remove')}
                  </Button>
  )
}
