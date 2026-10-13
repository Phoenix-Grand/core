/**
 * The parts of `PrivilegeList.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Checkbox } from "@ui"
import { Globe2, Unplug } from "lucide-react"
import type { Privilege } from "../../core/authz/types"
import type { PrivilegeList } from './PrivilegeList'

function Flags({ priv }: { priv: Privilege }) {
  const { t } = useTranslation()
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      {priv.is_orphan && (
        <span
          title={t('admin.priv_orphan_hint')}
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-surface-2 text-text-tertiary whitespace-nowrap"
        >
          <Unplug size={11} />{t('admin.priv_orphan')}
        </span>
      )}
      {!priv.is_ou_scopable && !priv.is_orphan && (
        <span
          title={t('admin.priv_not_scopable_hint')}
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full bg-warning-light text-warning whitespace-nowrap"
        >
          <Globe2 size={11} />{t('admin.priv_instance_only')}
        </span>
      )}
    </span>
  )
}
export { Flags }

export function Part1({ g, privilegeLabel, editing, onToggle, pad, selected }: { g: NonNullable<PrivilegeList['rows_groups']>[number]['g']; privilegeLabel: NonNullable<PrivilegeList['privilegeLabel']>; editing: NonNullable<PrivilegeList['editing']>; onToggle: NonNullable<PrivilegeList['props']['onToggle']>; pad: NonNullable<PrivilegeList['pad']>; selected: NonNullable<PrivilegeList['props']['selected']> }) {
  return (
    <>{g.items.map(p => {
                const row = (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm ${p.is_orphan ? 'text-text-tertiary' : 'text-text-primary'}`}>
                        {privilegeLabel(p)}
                      </span>
                      <span className="block text-sm text-text-tertiary font-mono truncate">{p.key}</span>
                    </span>
                    <Flags priv={p} />
                  </>
                )
                return editing ? (
                  <div
                    key={p.key}
                    onClick={() => onToggle!(p.key)}
                    className={`${pad} py-2 flex items-center gap-3 border-b border-border last:border-0 cursor-pointer hover:bg-surface-1 transition-colors`}
                  >
                    {/* The checkbox owns its own click (it renders a <label>): stop
                        the bubble so the row handler does not undo it. */}
                    <span onClick={e => e.stopPropagation()}>
                      <Checkbox checked={selected!.has(p.key)} onChange={() => onToggle!(p.key)} />
                    </span>
                    {row}
                  </div>
                ) : (
                  <div
                    key={p.key}
                    className={`${pad} py-2.5 flex items-center gap-3 border-b border-border last:border-0`}
                  >
                    {row}
                  </div>
                )
              })}</>
  )
}
