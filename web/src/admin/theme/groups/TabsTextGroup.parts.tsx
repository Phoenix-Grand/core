/**
 * The parts of `TabsTextGroup.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Tabs } from "@ui"
import type { TabsTextGroup } from './TabsTextGroup'

export function Part1({ t, tab, setTab }: { t: NonNullable<TabsTextGroup['tr']>; tab: NonNullable<TabsTextGroup['tab']>; setTab: NonNullable<TabsTextGroup['setTab']> }) {
  return (
    <Tabs
            tabs={[
              { id: 'apercu', label: t('admin.t_prev_tab_preview', { defaultValue: 'Aperçu' }) },
              { id: 'code', label: 'Code' },
              { id: 'reglages', label: t('admin.t_prev_tab_settings', { defaultValue: 'Réglages' }) },
            ]}
            value={tab}
            onChange={setTab}
          />
  )
}
