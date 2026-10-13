import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Accordion, DEFAULT_GRADIENT, DEFAULT_PICKER_THEME, LIGHT_PICKER_THEME, ThemePreviewContext,
  type Gradient,
} from '@ui'
import { CloudUpload } from 'lucide-react'
import type { ThemeDef } from '../../core/store/themeStore'
import MockRibbon from './mocks/RibbonMock'
import ColorsGroup from './groups/ColorsGroup'
import PrimitivesGroup from './groups/PrimitivesGroup'
import FieldsGroup from './groups/FieldsGroup'
import TabsTextGroup from './groups/TabsTextGroup'
import PickersGroup from './groups/PickersGroup'
import MenusGroup from './groups/MenusGroup'
import OverlaysGroup from './groups/OverlaysGroup'
import DataGroup from './groups/DataGroup'
import ResizeHandleDemo from './ResizeHandleDemo'
import StartPageDemo from './StartPageDemo'
import MockBreadcrumb from './mocks/MockBreadcrumb'
import MockFileCard from './mocks/MockFileCard'
import MockFileRow from './mocks/MockFileRow'
import MockFolderCard from './mocks/MockFolderCard'
import MockUploadPanel from './mocks/MockUploadPanel'
import MockSidebar from './mocks/MockSidebar'
import MockTopbar from './mocks/MockTopbar'

/**
 * The gallery body: one accordion group per family of objects. It is rendered by
 * PreviewFrame's nested React root (inside the shadow DOM), so its hooks and
 * event handlers all live in that root — clicks, toggles, slider/resize drags
 * resolve correctly. Accordion panels stay mounted, so each group owns its own
 * demo state; only the gradient is shared (fields ↔ pickers) and therefore lifted
 * here.
 *
 * To add a group: write a component under `groups/` and push an entry below.
 */
export default function GalleryBody({ theme }: { theme: ThemeDef }) {
  const { t } = useTranslation()
  const [grad, setGrad] = useState<Gradient>(DEFAULT_GRADIENT)

  // Colour pickers follow the previewed theme's light/dark scheme.
  const pickerTheme = theme.color_scheme === 'dark' ? DEFAULT_PICKER_THEME : LIGHT_PICKER_THEME

  return (
    <ThemePreviewContext.Provider value={true}>
      <div data-theme-preview={theme.id}>
        <Accordion className="mt-1" items={[
        { id: 'colors', title: t('admin.t_prev_colors', { defaultValue: 'Couleurs' }), content: <ColorsGroup /> },

        { id: 'primitives', title: t('admin.t_prev_primitives', { defaultValue: 'Composants primaires' }), content: <PrimitivesGroup /> },

        { id: 'data', title: t('admin.t_prev_data', { defaultValue: 'Données & administration' }), content: <DataGroup /> },

        { id: 'fields', title: t('admin.t_prev_fields', { defaultValue: 'Champs & saisie' }),
          content: <FieldsGroup pickerTheme={pickerTheme} grad={grad} setGrad={setGrad} /> },

        { id: 'tabs', title: t('admin.t_prev_tabs_text', { defaultValue: 'Onglets & texte riche' }), content: <TabsTextGroup /> },

        { id: 'pickers', title: t('admin.t_prev_color_pickers', { defaultValue: 'Sélecteurs de couleur' }),
          content: <PickersGroup pickerTheme={pickerTheme} grad={grad} setGrad={setGrad} /> },

        { id: 'menus', title: t('admin.t_prev_menus', { defaultValue: 'Menus déroulants' }), content: <MenusGroup /> },

        { id: 'shell', title: t('admin.t_prev_shell', { defaultValue: 'Coquille (core)' }), content: (
          <div className="space-y-3">
            <MockTopbar />
            <MockSidebar />
          </div>
        ) },

        { id: 'ribbon', title: t('admin.t_prev_ribbon', { defaultValue: 'Ruban (Office)' }), content: (<>
          <p className="text-[11px] text-text-tertiary mb-2.5">
            {t('admin.t_prev_ribbon_hint', {
              defaultValue: 'Chrome des éditeurs (bande d’onglets, groupes, barre de statut) — re-skinnée par le thème via les variables workspace.',
            })}
          </p>
          <div className="max-w-xl"><MockRibbon /></div>
        </>) },

        { id: 'drive', title: t('admin.t_prev_drive', { defaultValue: 'Objets du Drive' }), content: (<>
          <MockBreadcrumb />
          {/* `items-start` so the short folder cards keep their natural height
              instead of stretching to the tall file cards (flex default). */}
          <div className="flex flex-wrap items-start gap-3 mt-3">
            <MockFolderCard selected />
            <MockFolderCard name="Images" />
            <MockFileCard selected />
            <MockFileCard name="Budget.xlsx" ext="XLSX" />
          </div>
          <div className="mt-3 rounded-lg border border-border overflow-hidden bg-white">
            <MockFileRow selected />
            <MockFileRow name="Archive.zip" size="18 Mo" />
          </div>
          <div className="flex flex-wrap items-start gap-4 mt-3">
            <MockUploadPanel />
            <div className="flex flex-col items-center justify-center py-8 px-10 text-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/5">
              <CloudUpload size={40} className="text-primary opacity-80" />
              <p className="text-primary font-medium text-sm">Déposez vos fichiers ici</p>
            </div>
          </div>
        </>) },

        { id: 'overlays', title: t('admin.t_prev_overlays', { defaultValue: 'Fenêtres & dialogues' }), content: <OverlaysGroup /> },

        { id: 'layout', title: t('admin.t_prev_layout', { defaultValue: 'Mise en page' }), content: (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-text-tertiary">{t('admin.t_prev_resize', { defaultValue: 'Poignée de redimensionnement' })}</span>
              <ResizeHandleDemo />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-text-tertiary">{t('admin.t_prev_startpage', { defaultValue: 'Page de démarrage' })}</span>
              <StartPageDemo />
            </div>
          </div>
        ) },
        ]} />
      </div>
    </ThemePreviewContext.Provider>
  )
}
