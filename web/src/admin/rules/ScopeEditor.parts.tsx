/**
 * The parts of `ScopeEditor.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useTranslation } from "react-i18next"
import { Building2, Minus, User, Users } from "lucide-react"
import { Badge, Button, Checkbox } from "@ui"
import type { ScopeRef } from "./types"
import type { Directory } from "./useDirectory"
import type { ScopeEditor } from './ScopeEditor'

function RefRow({ r, dir, onRemove, onToggleDescendants, disabled }: {
  r: ScopeRef
  dir: Directory
  onRemove: () => void
  onToggleDescendants?: (v: boolean) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const Glyph = r.type === 'org_unit' ? Building2 : r.type === 'group' ? Users : User
  const name = r.type === 'org_unit' ? dir.unitName(r.id)
    : r.type === 'group' ? dir.groupName(r.id)
    : dir.userName(r.id)

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border bg-surface-0 px-2.5 py-1.5">
      <Glyph size={14} className="shrink-0 text-text-tertiary" aria-hidden />
      <span className="min-w-0 truncate text-text-primary">{name ?? r.id}</span>
      <Badge variant="default" size="sm">{t(`admin.rl_ref_kind_${r.type}`)}</Badge>
      {r.type === 'org_unit' && onToggleDescendants && (
        <Checkbox
          checked={r.descendants !== false}
          onChange={v => onToggleDescendants(v)}
          disabled={disabled}
          label={t('admin.rl_scope_descendants')}
          // Same reason as in the detector leaf: the primitive's default label
          // colour is a literal, unreadable on a dark theme.
          labelClassName="text-text-primary"
        />
      )}
      {!disabled && (
        <Button variant="ghost" size="sm" className="ms-auto" aria-label={t('admin.rl_scope_remove')}
          icon={<Minus size={14} />} onClick={onRemove} />
      )}
    </div>
  )
}
export { RefRow }

export function Part1({ Bucket, includeMenu }: { Bucket: ScopeEditor['Bucket']; includeMenu: NonNullable<ScopeEditor['includeMenu']> }) {
  return (
    <Bucket bucket="include" menu={includeMenu} />
  )
}

export function Part2({ Bucket, excludeMenu }: { Bucket: ScopeEditor['Bucket']; excludeMenu: NonNullable<ScopeEditor['excludeMenu']> }) {
  return (
    <Bucket bucket="exclude" menu={excludeMenu} />
  )
}
