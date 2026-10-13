/**
 * The parts of `CampaignWizard.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input, Stepper } from "@ui"
import type { CampaignWizard } from './CampaignWizard'

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-text-secondary" style={{ fontSize: 'var(--kb-text-meta)' }}>
      {children}
    </span>
  )
}
export { FieldLabel }

export function Part1({ steps, step, setStep, t }: { steps: NonNullable<CampaignWizard['steps']>; step: NonNullable<CampaignWizard['step']>; setStep: NonNullable<CampaignWizard['setStep']>; t: NonNullable<CampaignWizard['tr']> }) {
  return (
    <Stepper steps={steps} current={step} onStepChange={id => setStep(id)} t={t} />
  )
}

export function Part2({ service, s, setService }: { service: NonNullable<CampaignWizard['service']>; s: NonNullable<CampaignWizard['rows_services']>[number]['s']; setService: NonNullable<CampaignWizard['setService']> }) {
  return (
    <input
                        type="radio"
                        name="migration-service"
                        className="mt-1 accent-[var(--color-primary)]"
                        checked={service === s.id}
                        disabled={!s.available}
                        onChange={() => setService(s.id)}
                      />
  )
}

export function Part3({ t, name, setName }: { t: NonNullable<CampaignWizard['tr']>; name: NonNullable<CampaignWizard['name']>; setName: NonNullable<CampaignWizard['setName']> }) {
  return (
    <Input
                    label={t('admin.migr_field_name')}
                    value={name}
                    autoFocus
                    maxLength={200}
                    placeholder={t('admin.migr_field_name_ph')}
                    onChange={e => setName(e.target.value)}
                    hint={t('admin.migr_field_name_hint')}
                  />
  )
}

export function Part4({ t, port, setPort }: { t: NonNullable<CampaignWizard['tr']>; port: NonNullable<CampaignWizard['port']>; setPort: NonNullable<CampaignWizard['setPort']> }) {
  return (
    <Input
                        label={t('admin.migr_field_port')}
                        value={port}
                        inputMode="numeric"
                        onChange={e => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                      />
  )
}

export function Part5({ t }: { t: NonNullable<CampaignWizard['tr']> }) {
  return (
    <FieldLabel>{t('admin.migr_field_security')}</FieldLabel>
  )
}

export function Part6({ t }: { t: NonNullable<CampaignWizard['tr']> }) {
  return (
    <FieldLabel>{t('admin.migr_bulk_label')}</FieldLabel>
  )
}

export function Part7({ bulk, setBulk }: { bulk: NonNullable<CampaignWizard['bulk']>; setBulk: NonNullable<CampaignWizard['setBulk']> }) {
  return (
    <textarea
                      value={bulk}
                      rows={4}
                      spellCheck={false}
                      placeholder={'jean@ancien.fr, motdepasse, jean@exemple.fr'}
                      className="w-full resize-y rounded border border-border bg-surface-0 px-2 py-1.5 font-mono text-text-primary outline-none focus:border-primary"
                      style={{ fontSize: 'var(--kb-text-meta)' }}
                      onChange={e => setBulk(e.target.value)}
                    />
  )
}

export function Part8({ t }: { t: NonNullable<CampaignWizard['tr']> }) {
  return (
    <FieldLabel>{t('admin.migr_col_target')}</FieldLabel>
  )
}

export function Part9({ t, since, setSince }: { t: NonNullable<CampaignWizard['tr']>; since: NonNullable<CampaignWizard['since']>; setSince: NonNullable<CampaignWizard['setSince']> }) {
  return (
    <Input
                        label={t('admin.migr_field_since')}
                        type="date"
                        value={since}
                        onChange={e => setSince(e.target.value)}
                        hint={t('admin.migr_field_since_hint')}
                      />
  )
}

export function Part10({ t }: { t: NonNullable<CampaignWizard['tr']> }) {
  return (
    <FieldLabel>{t('admin.migr_exclude_label')}</FieldLabel>
  )
}
