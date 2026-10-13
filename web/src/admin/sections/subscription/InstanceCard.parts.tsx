/**
 * The parts of `InstanceCard.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Check, Copy } from "lucide-react"
import { Button } from "@ui"
import { formatDay } from "../format"
import Field from "./SubscriptionField"
import type { InstanceCard } from './InstanceCard'

export function Part1({ t, instance }: { t: NonNullable<InstanceCard['tr']>; instance: NonNullable<InstanceCard['props']['instance']> }) {
  return (
    <Field label={t('admin.sub_instance_name')}>
              {instance.name ?? '—'}
            </Field>
  )
}

export function Part2({ t, instance }: { t: NonNullable<InstanceCard['tr']>; instance: NonNullable<InstanceCard['props']['instance']> }) {
  return (
    <Field label={t('admin.sub_instance_version')}>
              {t('admin.sub_instance_version_value', { version: instance.core_version })}
            </Field>
  )
}

export function Part3({ t, instance, i18n }: { t: NonNullable<InstanceCard['tr']>; instance: NonNullable<InstanceCard['props']['instance']>; i18n: NonNullable<InstanceCard['i18n']> }) {
  return (
    <Field label={t('admin.sub_instance_installed')}>
              {formatDay(instance.installed_at, i18n.language)}
            </Field>
  )
}

export function Part4({ t, accounts }: { t: NonNullable<InstanceCard['tr']>; accounts: NonNullable<InstanceCard['props']['accounts']> }) {
  return (
    <Field label={t('admin.sub_instance_accounts')}>
                {t('admin.sub_instance_accounts_value', {
                  active: accounts.active, total: accounts.total,
                })}
              </Field>
  )
}

export function Part5({ t, instance, canCopy, copied, copy }: { t: NonNullable<InstanceCard['tr']>; instance: NonNullable<InstanceCard['props']['instance']>; canCopy: NonNullable<InstanceCard['canCopy']>; copied: NonNullable<InstanceCard['copied']>; copy: InstanceCard['copy'] }) {
  return (
    <Field label={t('admin.sub_instance_id')}>
              <span className="flex flex-wrap items-center gap-2">
                {/* The face is on the value alone: a monospaced "Copier" beside it
                    would read as part of the identifier. */}
                <span className="break-all font-mono">{instance.instance_id}</span>
                {canCopy && (
                  <Button
                    variant="text"
                    size="sm"
                    icon={copied ? <Check size={14} /> : <Copy size={14} />}
                    onClick={copy}
                  >
                    {copied ? t('admin.sub_copied') : t('admin.sub_copy')}
                  </Button>
                )}
              </span>
            </Field>
  )
}
