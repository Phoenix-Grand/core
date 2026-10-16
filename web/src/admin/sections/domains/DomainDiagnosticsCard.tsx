// What this domain's DNS says about mail - read by whoever knows best.
//
// The instance keeps a small reading of its own (MX hosts, SPF present, DMARC
// present) because a Kubuno that runs no mail service still has to say
// something. But when a module registers a provider under `DOMAIN_DIAGNOSTICS`
// (see `core/registry/domainDiagnostics.ts`), that provider replaces the
// reading: a real mail server knows the MX it expects, what an SPF record costs
// in lookups, whether the key it actually signs with is published, its PTR and
// its certificate. The core names no module - it renders whatever registered,
// says who produced it, and falls back to its own reading whenever the provider
// is absent, fails, or does not handle this domain.

import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  FileText, KeyRound, Lock, Mail, Network, RefreshCw, ShieldCheck, Globe,
} from 'lucide-react'
import { Button, Callout, Card } from '@ui'
import { ExtensionRegistry } from '../../../core/registry/ExtensionRegistry'
import {
  DOMAIN_DIAGNOSTICS,
  type DomainDiagnosticCheck,
  type DomainDiagnosticVerdict,
  type DomainDiagnosticsProvider,
} from '../../../core/registry/domainDiagnostics'
import { useMailCheck, type Domain } from './api'

/** Icon per kind, with a neutral globe for anything a provider invents. */
const KIND_ICON: Record<string, typeof Globe> = {
  mx: Network, spf: FileText, dkim: KeyRound, dmarc: ShieldCheck, ptr: Globe, tls: Lock,
}

/**
 * `info` and `unknown` stay neutral on purpose: they are the two verdicts this
 * page refuses to turn green, and a coloured dot beside "could not be checked"
 * is exactly the false reassurance to avoid.
 */
const VERDICT_SKIN: Record<DomainDiagnosticVerdict, { dot: string; text: string; bg: string }> = {
  ok:      { dot: 'bg-success',      text: 'text-success',       bg: 'bg-success-light' },
  warn:    { dot: 'bg-warning',      text: 'text-warning',       bg: 'bg-warning-light' },
  fail:    { dot: 'bg-danger',       text: 'text-danger',        bg: 'bg-danger-light'  },
  info:    { dot: 'bg-text-tertiary', text: 'text-text-secondary', bg: 'bg-surface-2' },
  unknown: { dot: 'bg-border-strong', text: 'text-text-tertiary',  bg: 'bg-surface-2' },
}

function verdictSkin(v: DomainDiagnosticVerdict) {
  return VERDICT_SKIN[v] ?? VERDICT_SKIN.unknown
}

export default function DomainDiagnosticsCard({ domain, canManage }: {
  domain:    Domain
  canManage: boolean
}) {
  const { t } = useTranslation()

  // Read at render: a module bundle registers during boot, before the console is
  // ever opened, and re-reading a Map is cheaper than a subscription.
  const provider = ExtensionRegistry.getAll<DomainDiagnosticsProvider>(DOMAIN_DIAGNOSTICS)[0] ?? null

  const report = useQuery({
    queryKey: ['admin-domain-diagnostics', domain.name],
    enabled:  !!provider,
    // Nothing here is ours to cache: this is read right after editing a zone,
    // and a cached answer would say the edit did not take.
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => (provider as DomainDiagnosticsProvider).fetch(domain.name),
  })

  const data = report.data ?? null
  // The provider replaces the reading only when it actually covers this domain.
  // Anything else - no provider, a rejected call, a domain it does not serve -
  // leaves the instance's own reading in place. Never an empty section.
  const covered = !!data?.covered
  const showOwnReading = !covered

  return (
    <Card title={<span className="flex items-center gap-2"><Mail size={16} /> {t('admin.dom_mail_title')}</span>}>
      <div className="flex flex-col gap-3 p-1">
        {provider && report.isLoading && (
          <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-body)' }}>
            {t('admin.dom_diag_loading', { defaultValue: 'Lecture du diagnostic…' })}
          </p>
        )}

        {/* The provider handles this domain: its lines, and who signed them. */}
        {covered && data && (
          <>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-text-tertiary"
              style={{ fontSize: 'var(--kb-text-small)' }}>
              <span>{t('admin.dom_diag_by', {
                defaultValue: 'Diagnostic fourni par {{source}} - il remplace la lecture de l’instance.',
                source: data.source,
              })}</span>
              {data.href && (
                <a href={data.href} className="text-primary underline underline-offset-2">
                  {t('admin.dom_diag_open', { defaultValue: 'Rapport complet' })}
                </a>
              )}
            </p>

            {data.note && <Callout variant="info" t={t}>{data.note}</Callout>}

            {data.checks.length === 0 ? (
              <p className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-body)' }}>
                {t('admin.dom_diag_none', { defaultValue: 'Aucune vérification à afficher pour ce domaine.' })}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.checks.map(check => <CheckLine key={check.id} check={check} />)}
              </ul>
            )}

            <div className="flex items-center gap-3">
              <Button variant="secondary" disabled={report.isFetching} onClick={() => void report.refetch()}>
                <RefreshCw size={16} /> {t('admin.dom_mail_check')}
              </Button>
            </div>
          </>
        )}

        {/* Fallback: the reading this page has always done. */}
        {showOwnReading && (
          <>
            {provider && !report.isLoading && (
              <Callout variant="info" t={t}>
                {data?.note ?? t('admin.dom_diag_fallback', {
                  defaultValue:
                    'Le module de messagerie n’a pas répondu : c’est la lecture de l’instance qui est affichée.',
                })}
              </Callout>
            )}
            <InstanceReading domain={domain} canManage={canManage} />
          </>
        )}
      </div>
    </Card>
  )
}

/** One diagnostic line: the light, the sentence, what is expected, what is published. */
function CheckLine({ check }: { check: DomainDiagnosticCheck }) {
  const { t } = useTranslation()
  const Icon = KIND_ICON[check.kind] ?? Globe
  const skin = verdictSkin(check.verdict)

  const label: Record<DomainDiagnosticVerdict, string> = {
    ok:      t('admin.dom_diag_v_ok',      { defaultValue: 'Conforme' }),
    warn:    t('admin.dom_diag_v_warn',    { defaultValue: 'À surveiller' }),
    fail:    t('admin.dom_diag_v_fail',    { defaultValue: 'À corriger' }),
    info:    t('admin.dom_diag_v_info',    { defaultValue: 'Publié - à votre appréciation' }),
    unknown: t('admin.dom_diag_v_unknown', { defaultValue: 'Non vérifiable' }),
  }

  return (
    <li className="rounded-lg border border-border p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Icon size={14} className={skin.text} />
        <span className="font-bold text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
          {check.kind.toUpperCase()}
        </span>
        <span className="font-mono text-text-secondary" style={{ fontSize: 'var(--kb-text-small)' }}>
          {check.scope}
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 ${skin.bg} ${skin.text}`}
          style={{ fontSize: 'var(--kb-text-micro, 11px)' }}>
          <span className={`h-1.5 w-1.5 rounded-full ${skin.dot}`} aria-hidden />
          {label[check.verdict] ?? label.unknown}
        </span>
        {check.instanceWide && (
          <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-micro, 11px)' }}>
            {t('admin.dom_diag_instance_wide', { defaultValue: 'Concerne l’instance, pas ce domaine' })}
          </span>
        )}
      </div>

      <p className="text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>{check.summary}</p>

      {check.expected && (
        <div className="mt-2">
          <div className="mb-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
            {t('admin.dom_diag_expected', { defaultValue: 'Attendu' })}
          </div>
          <RecordLine value={check.expected} />
        </div>
      )}

      {check.found && check.found.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
            {t('admin.dom_diag_found', { defaultValue: 'Publié / constaté' })}
          </div>
          <div className="flex flex-col gap-1">
            {check.found.map((line, i) => <RecordLine key={i} value={line} />)}
          </div>
        </div>
      )}
    </li>
  )
}

/** A record shown in full, never truncated: a `p=` tag cut in the middle cannot
 *  be published, and those exact characters are what the operator came for. */
function RecordLine({ value }: { value: string }) {
  return (
    <div className="overflow-x-auto rounded border border-border bg-surface-1 p-2">
      <code className="select-all whitespace-pre-wrap break-all font-mono text-text-primary"
        style={{ fontSize: 'var(--kb-text-small)' }}>
        {value}
      </code>
    </div>
  )
}

/** The instance's own reading - a reading, never a verdict: this instance does
 *  not run the mail service and cannot know what these records ought to be. */
function InstanceReading({ domain, canManage }: { domain: Domain; canManage: boolean }) {
  const { t } = useTranslation()
  const mail  = useMailCheck()

  return (
    <>
      <p className="text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>{t('admin.dom_mail_intro')}</p>

      <dl className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="w-28 shrink-0 text-text-secondary" style={{ fontSize: 'var(--kb-text-small)' }}>MX</dt>
          <dd className="min-w-0 flex-1">
            {domain.mx_hosts.length === 0
              ? <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-body)' }}>
                  {domain.mail_checked_at ? t('admin.dom_mail_none') : t('admin.dom_mail_unknown')}
                </span>
              : <ul className="flex flex-col">
                  {domain.mx_hosts.map(host => (
                    <li key={host} className="font-mono text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>{host}</li>
                  ))}
                </ul>}
          </dd>
        </div>
        {(['spf', 'dmarc'] as const).map(kind => (
          <div key={kind} className="flex flex-wrap items-baseline gap-2">
            <dt className="w-28 shrink-0 text-text-secondary" style={{ fontSize: 'var(--kb-text-small)' }}>{kind.toUpperCase()}</dt>
            <dd className="min-w-0 flex-1 text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
              {(kind === 'spf' ? domain.has_spf : domain.has_dmarc) === null
                ? t('admin.dom_mail_unknown')
                : (kind === 'spf' ? domain.has_spf : domain.has_dmarc)
                  ? t('admin.dom_mail_published')
                  : t('admin.dom_mail_absent')}
            </dd>
          </div>
        ))}
      </dl>

      {canManage && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" disabled={mail.isPending} onClick={() => mail.mutate(domain.id)}>
            <RefreshCw size={16} /> {t('admin.dom_mail_check')}
          </Button>
          {domain.mail_checked_at && (
            <span className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-small)' }}>
              {t('admin.dom_last_checked', { when: new Date(domain.mail_checked_at).toLocaleString() })}
            </span>
          )}
        </div>
      )}
    </>
  )
}
