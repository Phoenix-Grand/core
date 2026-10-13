/**
 * The parts of `DetectorEditor.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Input } from "@ui"
import { asPercent } from "./labels"
import type { DetectorEditor } from './DetectorEditor'

export function Part1({ t }: { t: NonNullable<DetectorEditor['tr']> }) {
  return (
    <label
                      htmlFor="detector-terms"
                      className="block text-text-secondary"
                      style={{ fontSize: 'var(--kb-text-meta)' }}
                    >
                      {t('admin.det_field_terms')}
                    </label>
  )
}

export function Part2({ form, canManage, setForm }: { form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <textarea
                      id="detector-terms"
                      value={form.terms}
                      rows={5}
                      disabled={!canManage}
                      spellCheck={false}
                      onChange={e => setForm(f => ({ ...f, terms: e.target.value }))}
                      className="mt-1 w-full resize-y rounded-md border border-border bg-surface-0 px-3 py-2 text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                      style={{ fontSize: 'var(--kb-text-body)' }}
                    />
  )
}

export function Part3({ t }: { t: NonNullable<DetectorEditor['tr']> }) {
  return (
    <label
                      htmlFor="detector-pattern"
                      className="block text-text-secondary"
                      style={{ fontSize: 'var(--kb-text-meta)' }}
                    >
                      {t('admin.det_field_pattern')}
                    </label>
  )
}

export function Part4({ form, canManage, setForm }: { form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <textarea
                      id="detector-pattern"
                      value={form.pattern}
                      rows={3}
                      disabled={!canManage}
                      spellCheck={false}
                      autoCorrect="off"
                      autoCapitalize="off"
                      onChange={e => setForm(f => ({ ...f, pattern: e.target.value }))}
                      className="mt-1 w-full resize-y rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                      style={{ fontSize: 'var(--kb-text-body)' }}
                    />
  )
}

export function Part5({ t }: { t: NonNullable<DetectorEditor['tr']> }) {
  return (
    <label
                htmlFor="detector-proximity"
                className="block text-text-secondary"
                style={{ fontSize: 'var(--kb-text-meta)' }}
              >
                {t('admin.det_field_proximity_terms')}
              </label>
  )
}

export function Part6({ form, canManage, setForm }: { form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <textarea
                id="detector-proximity"
                value={form.proximity_terms}
                rows={4}
                disabled={!canManage}
                spellCheck={false}
                onChange={e => setForm(f => ({ ...f, proximity_terms: e.target.value }))}
                className="mt-1 w-full resize-y rounded-md border border-border bg-surface-0 px-3 py-2 text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                style={{ fontSize: 'var(--kb-text-body)' }}
              />
  )
}

export function Part7({ t, form, canManage, setForm }: { t: NonNullable<DetectorEditor['tr']>; form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <Input
                  label={t('admin.det_field_proximity_window')}
                  type="number"
                  min={0}
                  max={4000}
                  value={String(form.proximity_window)}
                  disabled={!canManage}
                  onChange={e => setForm(f => ({ ...f, proximity_window: Number(e.target.value) || 0 }))}
                />
  )
}

export function Part8({ t, form, canManage, setForm }: { t: NonNullable<DetectorEditor['tr']>; form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <Input
                  label={t('admin.det_field_base_confidence')}
                  type="number" min={0} max={1} step={0.05}
                  value={String(form.base_confidence)}
                  disabled={!canManage}
                  onChange={e => setForm(f => ({ ...f, base_confidence: Number(e.target.value) }))}
                />
  )
}

export function Part9({ t, form, canManage, setForm }: { t: NonNullable<DetectorEditor['tr']>; form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <Input
                  label={t('admin.det_field_checksum_bonus')}
                  type="number" min={0} max={1} step={0.05}
                  value={String(form.checksum_bonus)}
                  disabled={!canManage}
                  onChange={e => setForm(f => ({ ...f, checksum_bonus: Number(e.target.value) }))}
                />
  )
}

export function Part10({ t, form, canManage, setForm }: { t: NonNullable<DetectorEditor['tr']>; form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <Input
                  label={t('admin.det_field_proximity_bonus')}
                  type="number" min={0} max={1} step={0.05}
                  value={String(form.proximity_bonus)}
                  disabled={!canManage}
                  onChange={e => setForm(f => ({ ...f, proximity_bonus: Number(e.target.value) }))}
                />
  )
}

export function Part11({ t, form, canManage, setForm }: { t: NonNullable<DetectorEditor['tr']>; form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <Input
                  label={t('admin.det_field_min_confidence')}
                  type="number" min={0} max={1} step={0.05}
                  value={String(form.min_confidence)}
                  hint={asPercent(form.min_confidence)}
                  disabled={!canManage}
                  onChange={e => setForm(f => ({ ...f, min_confidence: Number(e.target.value) }))}
                />
  )
}

export function Part12({ t, form, canManage, setForm }: { t: NonNullable<DetectorEditor['tr']>; form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <Input
                  label={t('admin.det_field_min_matches')}
                  type="number" min={1} max={10000}
                  value={String(form.min_matches)}
                  disabled={!canManage}
                  onChange={e => setForm(f => ({ ...f, min_matches: Number(e.target.value) || 1 }))}
                />
  )
}

export function Part13({ t, form, canManage, setForm }: { t: NonNullable<DetectorEditor['tr']>; form: NonNullable<DetectorEditor['form']>; canManage: NonNullable<DetectorEditor['canManage']>; setForm: NonNullable<DetectorEditor['setForm']> }) {
  return (
    <Input
                  label={t('admin.det_field_min_unique')}
                  type="number" min={1} max={10000}
                  value={String(form.min_unique_matches)}
                  hint={t('admin.det_field_min_unique_hint')}
                  error={form.min_unique_matches > form.min_matches
                    ? t('admin.det_unreachable_threshold')
                    : undefined}
                  disabled={!canManage}
                  onChange={e => setForm(f => ({ ...f, min_unique_matches: Number(e.target.value) || 1 }))}
                />
  )
}
