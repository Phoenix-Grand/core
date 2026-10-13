/**
 * The parts of `SupportCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { BadgeCheck, ShieldQuestion, Users } from "lucide-react"
import { Badge, Callout, Textarea } from "@ui"
import { formatDay } from "../format"
import Field from "./SubscriptionField"
import { type SupportInfo } from "./api"
import { ExternalLink } from "./ExternalLink"
import type { SupportCard } from './SupportCard'

function CommunitySupport({ support }: { support: SupportInfo }) {
  const { t } = useTranslation()
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="neutral"><span className="inline-flex items-center gap-1"><Users size={12} />{t('admin.sub_community_badge')}</span></Badge>
      </div>
      <p className="mt-3 text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
        {t('admin.sub_community_desc')}
      </p>
      <div
        className="mt-3 flex flex-wrap gap-x-5 gap-y-1"
        style={{ fontSize: 'var(--kb-text-body)' }}
      >
        <ExternalLink href={support.community.issues_url}>
          {t('admin.sub_community_issues')}
        </ExternalLink>
        <ExternalLink href={support.community.source_url}>
          {t('admin.sub_community_repo')}
        </ExternalLink>
        <ExternalLink href={support.community.organisation_url}>
          {t('admin.sub_community_org')}
        </ExternalLink>
      </div>
    </div>
  )
}
export { CommunitySupport }

function ContractDetails({
  contract, locale, verificationAvailable,
}: {
  contract: NonNullable<SupportInfo['contract']>
  locale:   string
  /** Whether this build carries any trusted signing key at all — the two
   *  reasons a contract can be declarative call for opposite explanations. */
  verificationAvailable: boolean
}) {
  const { t } = useTranslation()
  // Amber, then red: an operator has to be able to renew before the day it ends.
  const ending = contract.days_left != null && contract.days_left <= 30

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {contract.verified ? (
          <Badge variant="success">
            <span className="inline-flex items-center gap-1">
              <BadgeCheck size={12} />{t('admin.sub_contract_verified')}
            </span>
          </Badge>
        ) : (
          <Badge variant="neutral">
            <span className="inline-flex items-center gap-1">
              <ShieldQuestion size={12} />{t('admin.sub_contract_declarative')}
            </span>
          </Badge>
        )}
        {contract.expired && <Badge variant="danger">{t('admin.sub_contract_expired')}</Badge>}
        {!contract.expired && ending && (
          <Badge variant="warning">
            {t('admin.sub_contract_ending', { days: contract.days_left })}
          </Badge>
        )}
      </div>

      {!contract.verified && (
        <Callout variant="info" className="mt-3" t={t}>
          {verificationAvailable
            ? t('admin.sub_contract_declarative_desc')
            : t('admin.sub_contract_no_verifier_desc')}
        </Callout>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('admin.sub_contract_subject')}>{contract.subject}</Field>
        <Field label={t('admin.sub_contract_plan')}>{contract.plan ?? '—'}</Field>
        <Field label={t('admin.sub_contract_expires')}>
          {contract.expires_at ? formatDay(contract.expires_at, locale) : '—'}
        </Field>
        <Field label={t('admin.sub_contract_registered')}>
          {formatDay(contract.registered_at, locale)}
        </Field>
        <Field label={t('admin.sub_contract_contact')}>
          {contract.contact
            ? <ContactLink contact={contract.contact} />
            : '—'}
        </Field>
      </div>

      {contract.perimeter && (
        <div className="mt-4 border-t border-border pt-3">
          <Field label={t('admin.sub_contract_perimeter')}>
            <span className="whitespace-pre-line">{contract.perimeter}</span>
          </Field>
        </div>
      )}
    </div>
  )
}
export { ContractDetails }

function ContactLink({ contact }: { contact: string }) {
  if (contact.startsWith('https://')) return <ExternalLink href={contact}>{contact}</ExternalLink>
  return (
    <a
      href={`mailto:${contact}`}
      className="text-primary underline underline-offset-2 hover:text-primary-hover"
    >
      {contact}
    </a>
  )
}
export { ContactLink }

export function Part1({ t, draft, setDraft }: { t: NonNullable<SupportCard['tr']>; draft: NonNullable<SupportCard['draft']>; setDraft: NonNullable<SupportCard['setDraft']> }) {
  return (
    <Textarea
                    label={t('admin.sub_key_label')}
                    hint={t('admin.sub_key_hint')}
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    placeholder={t('admin.sub_key_placeholder')}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-28 font-mono"
                  />
  )
}
