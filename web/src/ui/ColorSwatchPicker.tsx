import { useState } from 'react'
import type { TFunction } from 'i18next'
import { Plus, Pipette } from 'lucide-react'
import { ColorPicker, useAppPickerTheme, type PickerTheme } from './ColorPicker'

// Couleurs « Personnalisé » ajoutées par l'utilisateur - persistées localement
// pour qu'elles réapparaissent à la réouverture (comme dans Google Docs).
const CUSTOM_KEY = 'kubuno:picker:custom-swatches'
function loadCustom(): string[] {
  if (typeof localStorage === 'undefined') return []
  try { const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '[]'); return Array.isArray(v) ? v.slice(0, 20) : [] }
  catch { return [] }
}

// Palette de pastilles style Google Docs (10 colonnes) : gris, teintes pures,
// puis nuances claires → foncées.
const SWATCHES = [
  '#000000','#434343','#666666','#999999','#b7b7b7','#cccccc','#d9d9d9','#efefef','#f3f3f3','#ffffff',
  '#980000','#ff0000','#ff9900','#ffff00','#00ff00','#00ffff','#4a86e8','#0000ff','#9900ff','#ff00ff',
  '#e6b8af','#f4cccc','#fce5cd','#fff2cc','#d9ead3','#d0e0e3','#c9daf8','#cfe2f3','#d9d2e9','#ead1dc',
  '#dd7e6b','#ea9999','#f9cb9c','#ffe599','#b6d7a8','#a2c4c9','#a4c2f4','#9fc5e8','#b4a7d6','#d5a6bd',
  '#cc4125','#e06666','#f6b26b','#ffd966','#93c47d','#76a5af','#6d9eeb','#6fa8dc','#8e7cc3','#c27ba0',
  '#a61c00','#cc0000','#e69138','#f1c232','#6aa84f','#45818e','#3c78d8','#3d85c6','#674ea7','#a64d79',
  '#85200c','#990000','#b45f06','#bf9000','#38761d','#134f5c','#1155cc','#0b5394','#351c75','#741b47',
  '#5b0f00','#660000','#783f04','#7f6000','#274e13','#0c343d','#1c4587','#073763','#20124d','#4c1130',
]

// Sélecteur de couleur « rapide » : grille de pastilles + option « Personnalisé »
// qui ouvre le ColorPicker complet. Pensé pour la couleur de texte/surlignage.
export function ColorSwatchPicker({
  color, onChange, onClose, t, theme, customLabel = "Custom", confirmLabel, cancelLabel,
}: {
  color: string
  onChange: (hex: string) => void
  onClose?: () => void
  t?: TFunction
  theme?: PickerTheme
  customLabel?: string
  confirmLabel?: string
  cancelLabel?: string
}) {
  // Par défaut, le picker suit le thème de l'APPLICATION (clair/sombre) via les
  // variables CSS du thème actif ; un module peut forcer un thème en passant `theme`.
  const appTheme = useAppPickerTheme()
  const C = theme ?? appTheme
  const [customOpen, setCustomOpen] = useState(false)
  const [draft, setDraft] = useState(color)            // couleur en cours d'édition (pas encore appliquée)
  const [custom, setCustom] = useState<string[]>(loadCustom)

  const addCustom = (hex: string) => setCustom(prev => {
    const next = [hex, ...prev.filter(c => c.toLowerCase() !== hex.toLowerCase())].slice(0, 20)
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)) } catch { /* quota / SSR */ }
    return next
  })

  // Étiquettes sans fuite de clé i18n : on passe des libellés explicites au ColorPicker.
  const confirm = confirmLabel ?? (t ? t('color_add',    { defaultValue: "Add" }) : "Add")
  const cancel  = cancelLabel  ?? (t ? t('color_cancel', { defaultValue: "Cancel" }) : "Cancel")

  // Écran « Personnalisé » : le ColorPicker complet édite un BROUILLON ; rien n'est
  // appliqué tant qu'on n'a pas cliqué « Ajouter ». Les deux boutons reviennent à
  // la grille de pastilles (sans fermer le popup entier).
  if (customOpen) {
    return <ColorPicker t={t} C={C} color={draft}
      onChange={setDraft}
      onClose={() => setCustomOpen(false)}
      confirmLabel={confirm} cancelLabel={cancel}
      onConfirm={hex => { addCustom(hex); onChange(hex); setCustomOpen(false) }}
      onCancel={() => setCustomOpen(false)} />
  }

  const openCustom = () => { setDraft(color); setCustomOpen(true) }

  const pickEyedropper = async () => {
    const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!ED) return
    try { const r = await new ED().open(); addCustom(r.sRGBHex); onChange(r.sRGBHex); onClose?.() } catch { /* annulé */ }
  }

  const norm = color.toLowerCase()
  return (
    <div className="p-3 rounded-lg shadow-lg border" style={{ width: 232, background: C.toolbar, borderColor: C.border }}>
      <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(10, 1fr)' }}>
        {SWATCHES.map(c => {
          const active = c.toLowerCase() === norm
          return (
            <button key={c} title={c}
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(c); onClose?.() }}
              className="aspect-square rounded-full transition-transform hover:scale-110"
              style={{
                background: c,
                border: c.toLowerCase() === '#ffffff' ? '1px solid #dadce0' : '1px solid rgba(0,0,0,.08)',
                boxShadow: active ? '0 0 0 2px #1a73e8' : 'none',
              }} />
          )
        })}
      </div>

      <div className="mt-3 mb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.title }}>
        {customLabel}
      </div>
      {/* Pastilles « Personnalisé » + actions, dans LA MÊME grille 10 colonnes que
          la palette par défaut → même taille / même alignement. */}
      <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(10, 1fr)' }}>
        {custom.map(c => (
          <button key={c} title={c}
            onMouseDown={e => e.preventDefault()}
            onClick={() => { onChange(c); onClose?.() }}
            className="aspect-square rounded-full transition-transform hover:scale-110"
            style={{ background: c, border: '1px solid rgba(0,0,0,.08)', boxShadow: c.toLowerCase() === norm ? '0 0 0 2px #1a73e8' : 'none' }} />
        ))}
        <button
          onClick={openCustom}
          title={customLabel}
          className="aspect-square flex items-center justify-center rounded-full border transition-colors"
          style={{ borderColor: C.border, color: C.textDim }}
          onMouseEnter={e => (e.currentTarget.style.background = C.surface ?? 'transparent')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <Plus size={12} />
        </button>
        {typeof window !== 'undefined' && 'EyeDropper' in window && (
          <button
            onClick={pickEyedropper}
            title="Eyedropper"
            className="aspect-square flex items-center justify-center rounded-full border transition-colors"
            style={{ borderColor: C.border, color: C.textDim }}
            onMouseEnter={e => (e.currentTarget.style.background = C.surface ?? 'transparent')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Pipette size={11} />
          </button>
        )}
      </div>
    </div>
  )
}
