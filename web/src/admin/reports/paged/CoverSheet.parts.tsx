/**
 * The parts of `CoverSheet.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import type { CoverSheet } from './CoverSheet'

export function Part1({ t, model, generatedAt, generatedBy }: { t: NonNullable<CoverSheet['tr']>; model: NonNullable<CoverSheet['props']['model']>; generatedAt: NonNullable<CoverSheet['props']['generatedAt']>; generatedBy: NonNullable<CoverSheet['props']['generatedBy']> }) {
  return (
    <dl className="grid grid-cols-3 gap-x-6 border-t border-border pt-3">
            <div>
              <dt className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {t('admin.rep_timezone')}
              </dt>
              <dd style={{ fontSize: 'var(--kb-text-body)' }}>{model.timezone}</dd>
            </div>
            <div>
              <dt className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {t('admin.rep_generated')}
              </dt>
              <dd style={{ fontSize: 'var(--kb-text-body)' }}>{generatedAt}</dd>
            </div>
            <div>
              <dt className="text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
                {t('admin.rep_generated_by')}
              </dt>
              <dd style={{ fontSize: 'var(--kb-text-body)' }}>{generatedBy}</dd>
            </div>
          </dl>
  )
}
