/**
 * The parts of `OrgUnitPicker.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Search } from "lucide-react"
import { Input } from "@ui"
import type { OrgUnitPicker } from './OrgUnitPicker'

export function Part1({ needle, setNeedle, t }: { needle: NonNullable<OrgUnitPicker['needle']>; setNeedle: NonNullable<OrgUnitPicker['setNeedle']>; t: NonNullable<OrgUnitPicker['tr']> }) {
  return (
    <Input
                type="search"
                value={needle}
                onChange={e => setNeedle(e.target.value)}
                placeholder={t('admin.ou_search_ph')}
                leftIcon={<Search size={15} />}
              />
  )
}

export function Part2({ treeRef, title, onTreeKey, visible, renderRow }: { treeRef: NonNullable<OrgUnitPicker['treeRef']>; title: NonNullable<OrgUnitPicker['props']['title']>; onTreeKey: OrgUnitPicker['onTreeKey']; visible: NonNullable<OrgUnitPicker['visible']>; renderRow: OrgUnitPicker['renderRow'] }) {
  return (
    <div
                    ref={treeRef}
                    role="tree"
                    aria-label={title}
                    onKeyDown={onTreeKey}
                  >
                    {visible.map(renderRow)}
                  </div>
  )
}
