/**
 * The viewport toolbar of the design page (WEB-VIEWS §4.3, web-specific): the view's width (its design width,
 * phone / tablet / desktop presets, or fitted to the pane), the Kubuno theme (light / dark), the design-time
 * language (fr / en / ar, right-to-left for ar), Design / Run, and indicators (sample data, zoom, the runtime in
 * use). Plain DOM in Visual Studio's colours (`--vs-*`), outside the view's React tree.
 */
import type { KubunoThemeMode } from './bootstrap'

export type WidthChoice = 'design' | 'fit' | number

/** A device frame, or none (the responsive page). */
export type DeviceChoice = 'phone' | 'tablet' | null

/**
 * Device frames in logical (CSS) pixels - the scale the shared controls are sized in (their typographic roles, paddings
 * and gaps are theme values at this scale, like the web). The view is shown at this fixed size - scaled to fit the pane
 * - with phone/tablet proportions and a bezel, rather than as a responsive web page. Rotating swaps width and height.
 */
export const DEVICE_FRAMES: Record<Exclude<DeviceChoice, null>, { w: number; h: number; label: string }> = {
  phone: { w: 390, h: 844, label: 'Téléphone' },
  tablet: { w: 834, h: 1194, label: 'Tablette' },
}

export interface ToolbarState {
  readonly width: WidthChoice
  readonly designWidth: number
  readonly theme: KubunoThemeMode
  readonly lang: string
  readonly design: boolean
  readonly device: DeviceChoice
  readonly landscape: boolean
  readonly sample: boolean
  readonly sampleTitle: string
  readonly zoom: number
  readonly note: string | null
}

export interface ToolbarHandlers {
  width(w: WidthChoice): void
  theme(t: KubunoThemeMode): void
  lang(l: string): void
  design(on: boolean): void
  device(d: DeviceChoice): void
  rotate(): void
}

export const WIDTH_PRESETS = [390, 768, 1280, 1440] as const

/** Lucide device glyphs for the width presets (plain SVG - the toolbar is DOM outside the view's React tree). */
const glyph = (paths: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const DEVICE: Record<number, { icon: string; label: string }> = {
  390:  { label: 'Téléphone',            icon: glyph('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>') },
  768:  { label: 'Tablette',             icon: glyph('<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>') },
  1280: { label: 'Ordinateur portable', icon: glyph('<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>') },
  1440: { label: 'Grand écran',         icon: glyph('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>') },
}
const FIT_ICON = glyph('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>')
const DEVICE_ICON: Record<'phone' | 'tablet', string> = {
  phone: glyph('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
  tablet: glyph('<rect width="16" height="20" x="4" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
}
const NO_DEVICE_ICON = glyph('<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>')
const ROTATE_ICON = glyph('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>')

interface Btn {
  el: HTMLButtonElement
  on: (s: ToolbarState) => boolean
}

export function createToolbar(doc: Document, languages: readonly string[], handlers: ToolbarHandlers, options: { mobile?: boolean } = {}): { el: HTMLElement; update(s: ToolbarState): void } {
  const bar = doc.createElement('div')
  bar.className = 'kbd-toolbar'
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', 'Affichage du concepteur')
  const buttons: Btn[] = []
  let designBtn: HTMLButtonElement | null = null

  const group = (label: string): HTMLElement => {
    const g = doc.createElement('div')
    g.className = 'kbd-group'
    g.setAttribute('role', 'group')
    g.setAttribute('aria-label', label)
    const l = doc.createElement('span')
    l.className = 'kbd-label'
    l.textContent = label
    g.appendChild(l)
    bar.appendChild(g)
    return g
  }
  const button = (g: HTMLElement, text: string, title: string, on: Btn['on'], click: () => void, svgMarkup?: string): HTMLButtonElement => {
    const b = doc.createElement('button')
    b.type = 'button'
    b.className = svgMarkup ? 'kbd-btn kbd-btn-icon' : 'kbd-btn'
    if (svgMarkup) { b.innerHTML = svgMarkup; b.setAttribute('aria-label', title) } else { b.textContent = text }
    b.title = title
    b.addEventListener('click', click)
    // The toolbar never takes the keyboard from the surface for long: a click returns the focus to it.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    g.appendChild(b)
    buttons.push({ el: b, on })
    return b
  }

  // The responsive-width presets are a web concept (page breakpoints); a mobile view uses a device frame instead, so
  // this group is left out when editing for mobile.
  if (!options.mobile) {
    const width = group('Largeur')
    designBtn = button(width, '-', 'Largeur de conception (DesignWidth)', (s) => s.width === 'design', () => handlers.width('design'))
    for (const w of WIDTH_PRESETS) button(width, String(w), `${DEVICE[w].label} - ${w} px`, (s) => s.width === w, () => handlers.width(w), DEVICE[w].icon)
    button(width, 'Ajusté', 'Ajustée au volet', (s) => s.width === 'fit', () => handlers.width('fit'), FIT_ICON)
  }

  // A device frame (phone/tablet, portrait or landscape) instead of the responsive page - for mobile views.
  const dev = group('Appareil')
  button(dev, 'Aucun', 'Aucun cadre (page web responsive)', (s) => s.device === null, () => handlers.device(null), NO_DEVICE_ICON)
  button(dev, 'Téléphone', `Cadre téléphone - ${DEVICE_FRAMES.phone.w}×${DEVICE_FRAMES.phone.h}`, (s) => s.device === 'phone', () => handlers.device('phone'), DEVICE_ICON.phone)
  button(dev, 'Tablette', `Cadre tablette - ${DEVICE_FRAMES.tablet.w}×${DEVICE_FRAMES.tablet.h}`, (s) => s.device === 'tablet', () => handlers.device('tablet'), DEVICE_ICON.tablet)
  const rotateBtn = button(dev, 'Pivoter', 'Pivoter (portrait / paysage)', (s) => s.landscape, () => handlers.rotate(), ROTATE_ICON)

  const theme = group('Thème')
  button(theme, 'Clair', 'Thème Kubuno clair (kubuno-reference)', (s) => s.theme === 'light', () => handlers.theme('light'))
  button(theme, 'Sombre', 'Thème Kubuno sombre (kubuno-dark)', (s) => s.theme === 'dark', () => handlers.theme('dark'))

  const lang = group('Langue')
  for (const l of languages) button(lang, l.toUpperCase(), l === 'ar' ? 'Arabe (de droite à gauche)' : l === 'fr' ? 'Français' : l === 'en' ? 'Anglais' : l, (s) => s.lang === l, () => handlers.lang(l))

  const mode = group('Mode')
  button(mode, 'Conception', 'Mode conception : sélection et édition', (s) => s.design, () => handlers.design(true))
  button(mode, 'Exécution', 'Mode exécution : la vue est interactive', (s) => !s.design, () => handlers.design(false))

  const spacer = doc.createElement('div')
  spacer.className = 'kbd-spacer'
  bar.appendChild(spacer)
  const note = doc.createElement('span')
  note.className = 'kbd-note'
  bar.appendChild(note)
  const sample = doc.createElement('span')
  sample.className = 'kbd-chip'
  sample.textContent = "Données d'exemple"
  bar.appendChild(sample)
  const zoom = doc.createElement('span')
  zoom.className = 'kbd-label'
  bar.appendChild(zoom)

  return {
    el: bar,
    update(s) {
      if (designBtn) designBtn.textContent = `${s.designWidth} (conception)`
      rotateBtn.disabled = s.device === null
      for (const b of buttons) b.el.setAttribute('aria-pressed', String(b.on(s)))
      sample.dataset.on = String(s.sample)
      sample.title = s.sampleTitle
      zoom.textContent = `${Math.round(s.zoom * 100)} %`
      note.textContent = s.note ?? ''
      note.title = s.note ?? ''
    },
  }
}
