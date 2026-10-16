import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cloud, HardDrive } from 'lucide-react'
import { Callout, ProgressBar } from '@ui'
import { PRIV } from '../../../../core/authz/types'
import { usePrivileges } from '../../../../core/authz/usePrivileges'
import type { User } from '../../../../core/types'
import { useAdminAction } from '../../../adminAction'
import EditableCard from '../../../inline-edit/EditableCard'
import QuotaField, { splitQuota, toBytes, type QuotaUnit } from '../../../storage/QuotaField'
import { useAccountStorageUsage } from '../../../storage/api'
import { formatBytes } from '../../format'
import { accountError, useUpdateAccount } from '../useAccountEdit'

/**
 * The account's ceiling, edited where it is read.
 *
 * `QuotaField` is the storage page's own control, borrowed rather than
 * re-implemented: a byte count is the thing an operator gets wrong -
 * `53687091200` and `5368709120` differ by one character and by a factor of ten
 * - and the two screens that set a quota must not disagree about how it is
 * typed. It also replaces the 0–200 Go slider the edit window used, which could
 * not express the ceiling of an account already above 200 Go.
 *
 * Lowering below current usage is allowed - it is a legitimate way to stop
 * growth - and warned about rather than refused, exactly as on the storage page.
 */
export default function StorageCard({ user }: { user: User }) {
  const { t } = useTranslation()
  const { can } = usePrivileges()

  const [editing, setEditing] = useState(false)
  const initial = splitQuota(user.quota_bytes)
  const [amount, setAmount] = useState(initial.amount)
  const [unit, setUnit]     = useState<QuotaUnit>(initial.unit)

  // The breakdown the storage page already computes - reused, not recounted.
  const usage = useAccountStorageUsage(user.id)

  const canEdit = can(PRIV.USERS_UPDATE, user.org_unit_id)
  const save = useUpdateAccount(user.id)

  const bytes = toBytes(amount, unit)
  const dirty = bytes != null && bytes !== user.quota_bytes
  const below = bytes != null && bytes < user.used_bytes

  const reset = () => {
    const fresh = splitQuota(user.quota_bytes)
    setAmount(fresh.amount)
    setUnit(fresh.unit)
  }
  const stop = () => { setEditing(false); save.reset(); reset() }

  // `…?action=set-quota` - the verb a full-account alert points at, and the one
  // the storage page forwards here now that the ceiling is edited on the sheet.
  // It opens the card already in edit mode rather than dropping the operator on
  // a page and leaving them to find the pencil.
  useAdminAction('set-quota', () => { if (canEdit) { reset(); setEditing(true) } })

  const submit = () => {
    if (bytes == null) return
    save.mutate({ quota_bytes: bytes }, {
      onSuccess: () => { setEditing(false); save.reset() },
    })
  }

  const shown = editing && bytes != null ? bytes : user.quota_bytes
  const pct = shown > 0 ? (user.used_bytes / shown) * 100 : 0

  return (
    <EditableCard
      title={t('admin.ud_card_storage')}
      icon={<HardDrive size={16} />}
      // Full width: the total and the per-module figures are a row of readings,
      // and squeezing them into half the sheet wraps each one onto three lines.
      className="lg:col-span-2"
      canEdit={canEdit}
      editing={editing}
      onEdit={() => { reset(); save.reset(); setEditing(true) }}
      onCancel={stop}
      onSave={submit}
      dirty={dirty}
      saving={save.isPending}
      error={save.isError ? (accountError(save.error) ?? t('admin.sto_quota_failed')) : undefined}
    >
      {/* What is actually stored, before what is allowed. The total is the
          number enforcement reads; the modules beside it say where it comes
          from - the question an operator asks the moment the total surprises
          them. Read from the storage page's own endpoint rather than a second
          count of our own, so the sheet and that page can never disagree. */}
      <div className="mb-4 flex flex-wrap items-start gap-x-10 gap-y-4">
        <div className="flex items-center gap-3">
          <Cloud size={28} className="shrink-0 text-text-tertiary" />
          <div>
            <div className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {t('admin.sto_col_used')}
            </div>
            <div className="font-medium text-text-primary" style={{ fontSize: 'var(--kb-text-page)' }}>
              {formatBytes(user.used_bytes)}
            </div>
          </div>
        </div>

        {usage.data && (
          usage.data.modules.length > 0 ? (
            <div className="flex flex-wrap items-start gap-x-8 gap-y-3 border-border sm:border-l sm:pl-10">
              {usage.data.modules.map(m => (
                <div key={m.module_id} className="min-w-[86px]">
                  <div className="truncate text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                    {m.display_name}
                  </div>
                  {/* `billable`, not `held`: the total beside it is the quota
                      counter, and a module's physical holdings include what it
                      charges to nobody. Mixing the two made the parts add up to
                      MORE than the whole, which reads as an arithmetic bug. */}
                  <div className="text-text-primary" style={{ fontSize: 'var(--kb-text-body)' }}>
                    {formatBytes(m.billable_bytes)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="max-w-sm text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
              {t('admin.sto_acct_mods_empty')}
            </p>
          )
        )}
      </div>

      {/* The bar keeps following the value being typed, so what a new ceiling
          does to this account is visible before it is written. */}
      <ProgressBar
        t={t}
        value={user.used_bytes}
        max={Math.max(shown, 1)}
        label={t('admin.ud_quota_used', {
          used:  formatBytes(user.used_bytes),
          quota: formatBytes(shown),
        })}
        showValue
        formatValue={() => `${pct.toFixed(pct < 10 ? 1 : 0)} %`}
      />

      {editing && (
        <div className="mt-4 flex flex-col gap-3">
          <QuotaField
            label={t('admin.sto_quota_field')}
            amount={amount}
            unit={unit}
            onAmount={setAmount}
            onUnit={setUnit}
            autoFocus
            error={bytes == null ? t('admin.sto_quota_invalid') : undefined}
          />
          {below && (
            <Callout variant="warning" t={t} title={t('admin.sto_quota_below_title')}>
              {t('admin.sto_quota_below_desc', { used: formatBytes(user.used_bytes) })}
            </Callout>
          )}
        </div>
      )}
    </EditableCard>
  )
}
