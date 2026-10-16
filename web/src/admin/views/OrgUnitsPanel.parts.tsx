/**
 * The parts of `OrgUnitsPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../core/api/client"
import { Plus, FolderInput, MoreVertical, Pencil, Building2 } from "lucide-react"
import { Input, MenuDropdown } from "@ui"
import { FloatingWindow } from "@ui/FloatingWindow"
import OrgUnitPicker from "../dialogs/OrgUnitPicker"
import { PRIV } from "../../core/authz/types"
import type { OrgUnit } from "../../core/types"
import type { OrgUnitsPanel } from './OrgUnitsPanel'
function errMessage(err: unknown): string | undefined {
  const e = err as { message?: string; response?: { data?: { message?: string } } }
  return e?.response?.data?.message ?? e?.message
}

function OrgUnitDialog({
  mode, unit, parentId, units, onClose,
}: {
  mode: 'create' | 'edit'; unit?: OrgUnit; parentId?: string; units: OrgUnit[]; onClose: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [name, setName]         = useState(unit?.name ?? '')
  const [desc, setDesc]         = useState(unit?.description ?? '')
  const [parent, setParent]     = useState<string | null>(mode === 'edit' ? (unit?.parent_id ?? null) : (parentId ?? null))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError]       = useState('')

  const parentName = units.find(u => u.id === parent)?.name ?? '-'
  const isRootEdit = mode === 'edit' && unit?.parent_id === null

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-org-units'] })
    qc.invalidateQueries({ queryKey: ['admin-org-unit-counts'] })
  }
  const save = useMutation({
    mutationFn: () => mode === 'create'
      ? api.post('/admin/org-units', { name: name.trim(), description: desc.trim() || null, parent_id: parent })
      // The parent was offered by this dialog and then dropped on the way out:
      // one could pick a new one, save, and watch nothing happen. Sent only when
      // it changed, and never for the root - which has no parent to move to.
      : api.patch(`/admin/org-units/${unit!.id}`, {
          name: name.trim(),
          description: desc.trim() || null,
          ...(!isRootEdit && parent && parent !== unit?.parent_id ? { parent_id: parent } : {}),
        }),
    onSuccess: () => { invalidate(); onClose() },
    onError: err => setError(errMessage(err) ?? t('admin.update_error')),
  })

  return (
    <FloatingWindow
      title={mode === 'create' ? t('admin.ou_create_title') : t('admin.ou_edit_title')}
      onClose={onClose}
      defaultWidth={480}
      backdrop
      t={t}
      actions={{
        confirm: {
          label:    mode === 'create' ? t('admin.ou_create') : t('admin.ou_save'),
          onClick:  () => save.mutate(),
          disabled: !name.trim() || (mode === 'create' && !parent) || save.isPending,
          loading:  save.isPending,
        },
        cancel: { label: t('admin.ou_cancel') },
      }}
    >
      <div className="p-5 space-y-5">
        <div>
          <label className="block text-sm text-primary mb-1">{t('admin.ou_field_name')} *</label>
          <Input value={name} onChange={e => setName(e.target.value)} placeholder={t('admin.ou_name_ph')} />
        </div>
        <div>
          <label className="block text-sm text-text-secondary mb-1">{t('admin.ou_col_desc')}</label>
          <Input value={desc} onChange={e => setDesc(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm text-text-secondary mb-1">{t('admin.ou_field_parent')}{mode === 'create' && ' *'}</label>
          <div className="flex items-center justify-between border-b border-border pb-1">
            <span className="text-sm text-text-primary">{parentName}</span>
            {!isRootEdit && (
              <button type="button" onClick={() => setPickerOpen(true)} className="p-1 text-text-tertiary hover:text-primary" title={t('admin.ou_change_parent')}><Pencil size={15} /></button>
            )}
          </div>
        </div>
        {error && <p className="text-sm text-danger bg-danger-light px-3 py-2 rounded-md">{error}</p>}
      </div>
      {pickerOpen && (
        <OrgUnitPicker
          title={t('admin.ou_select_parent')}
          currentId={parent}
          excludeId={unit?.id}
          onSelect={(id) => setParent(id)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </FloatingWindow>
  )
}
export { OrgUnitDialog }

export function Part1({ t, can, rows, own, subtreeCount, setDialog, setMoveUnit, openMenu }: { t: NonNullable<OrgUnitsPanel['tr']>; can: NonNullable<OrgUnitsPanel['can']>; rows: NonNullable<OrgUnitsPanel['rows']>; own: NonNullable<OrgUnitsPanel['own']>; subtreeCount: OrgUnitsPanel['subtreeCount']; setDialog: NonNullable<OrgUnitsPanel['setDialog']>; setMoveUnit: NonNullable<OrgUnitsPanel['setMoveUnit']>; openMenu: OrgUnitsPanel['openMenu'] }) {
  return (
    <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-text-tertiary border-b border-border">
                    <th className="px-5 py-2.5 font-medium">{t('admin.ou_col_name')}</th>
                    <th className="px-5 py-2.5 font-medium">{t('admin.ou_col_desc')}</th>
                    {can(PRIV.USERS_READ) && (
                      <th className="px-5 py-2.5 font-medium whitespace-nowrap">{t('admin.ou_col_users')}</th>
                    )}
                    <th className="w-32" />
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-text-tertiary">{t('admin.ou_no_results')}</td></tr>
                  )}
                  {rows.map(({ u, depth }) => {
                    const isRoot = u.parent_id === null
                    return (
                      <tr key={u.id} className="group border-b border-border last:border-0 hover:bg-surface-1 transition-colors">
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-2" style={{ paddingLeft: depth * 20 }}>
                            <Building2 size={16} className="text-text-tertiary shrink-0" />
                            <span className="text-text-primary">{u.name}</span>
                            {isRoot && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-2 text-text-tertiary">{t('admin.ou_root')}</span>}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-text-secondary">{u.description || '-'}</td>
                        {can(PRIV.USERS_READ) && (
                          <td className="px-5 py-3 whitespace-nowrap">
                            {/* Own count first - it is the one an operator acts on. The
                                subtree total only shows when it says something more. */}
                            <span className="text-text-primary">{own.get(u.id) ?? 0}</span>
                            {subtreeCount(u.id) !== (own.get(u.id) ?? 0) && (
                              <span className="text-text-tertiary ml-2">
                                {t('admin.ou_users_subtree', { count: subtreeCount(u.id) })}
                              </span>
                            )}
                          </td>
                        )}
                        <td className="px-3 py-3">
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button type="button" onClick={() => setDialog({ mode: 'create', parentId: u.id })} title={t('admin.ou_add')} className="p-1.5 rounded text-text-tertiary hover:text-primary hover:bg-surface-2"><Plus size={16} /></button>
                            {!isRoot && <button type="button" onClick={() => setMoveUnit(u)} title={t('admin.ou_move')} className="p-1.5 rounded text-text-tertiary hover:text-primary hover:bg-surface-2"><FolderInput size={16} /></button>}
                            <button type="button" onClick={e => openMenu(u, e.currentTarget)} title={t('admin.ou_more')} className="p-1.5 rounded text-text-tertiary hover:text-primary hover:bg-surface-2"><MoreVertical size={16} /></button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
  )
}

export function Part2({ menuItems, menu, setMenu }: { menuItems: OrgUnitsPanel['menuItems']; menu: NonNullable<OrgUnitsPanel['menu']>; setMenu: NonNullable<OrgUnitsPanel['setMenu']> }) {
  return (
    <MenuDropdown items={menuItems(menu.unit)} pos={menu.pos} onClose={() => setMenu(null)} />
  )
}
