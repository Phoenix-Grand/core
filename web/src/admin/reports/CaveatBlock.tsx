import { useTranslation } from "react-i18next"
import type { PanelDef } from "../panels/types"
import ReportBlock from './ReportBlock'

/** The measurement's own reserves, as written for this panel. */
export function CaveatBlock({ def, caveat }: { def: PanelDef; caveat: string | null }) {
  const { t } = useTranslation()
  if (!caveat) return null

  // A caveat id this build has no wording for is not printed at all: an empty
  // section under a heading reads as a rendering fault, and on paper it cannot
  // be dismissed as one.
  const spell = def.caveatKey ?? ((id: string) => `admin.sec_caveat_${id}`)
  const text = t(spell(caveat), { defaultValue: '' })
  if (!text) return null

  return (
    <ReportBlock title={t('admin.rep_caveats')}>
      <p className="max-w-3xl text-text-secondary" style={{ fontSize: 'var(--kb-text-body)' }}>
        {text}
      </p>
    </ReportBlock>
  )
}
