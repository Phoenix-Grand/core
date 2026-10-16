/**
 * Kubuno's own illustration set - the pictures offered as a profile photo when
 * someone would rather not upload one.
 *
 * They are COMPOSED here rather than shipped as image files: a handful of
 * recipes crossed with a handful of palettes gives a whole gallery for a couple
 * of kilobytes of code, works offline, needs no CDN and no licence to honour.
 * Every one is a square SVG meant to be seen inside a circle, so the subject
 * stays well within the middle and the corners only ever carry background.
 */

export interface Palette {
  /** Background wash, from top-left to bottom-right. */
  bg: [string, string]
  /** Main subject. */
  ink: string
  /** Secondary accent. */
  accent: string
}

export const PALETTES: ReadonlyArray<{ id: string; palette: Palette }> = [
  { id: 'azur',    palette: { bg: ['#d3e3fd', '#aecbfa'], ink: '#1a73e8', accent: '#174ea6' } },
  { id: 'menthe',  palette: { bg: ['#ceead6', '#a8dab5'], ink: '#1e8e3e', accent: '#0d652d' } },
  { id: 'safran',  palette: { bg: ['#feefc3', '#fde293'], ink: '#e8710a', accent: '#b06000' } },
  { id: 'corail',  palette: { bg: ['#fad2cf', '#f6aea9'], ink: '#d93025', accent: '#a50e0e' } },
  { id: 'lilas',   palette: { bg: ['#e9d2fd', '#d7aefb'], ink: '#9334e6', accent: '#681da8' } },
  { id: 'lagon',   palette: { bg: ['#cbf0f8', '#a1e4f2'], ink: '#12b5cb', accent: '#007b83' } },
  { id: 'argile',  palette: { bg: ['#e8eaed', '#dadce0'], ink: '#5f6368', accent: '#3c4043' } },
  { id: 'rose',    palette: { bg: ['#fdcfe8', '#fba9d6'], ink: '#e52592', accent: '#b80672' } },
]

/** A drawing recipe: given a palette, it returns the SVG body (viewBox 0 0 96 96). */
interface Recipe {
  id: string
  /** Collection the picture belongs to, used to group the gallery. */
  collection: 'abstrait' | 'nature' | 'cosmos' | 'motifs'
  /** Words the search box matches on, beyond the collection and palette names. */
  keywords: string[]
  draw: (p: Palette) => string
}

const RECIPES: readonly Recipe[] = [
  {
    id: 'arcs', collection: 'abstrait', keywords: ['arc', 'cercle', 'rond'],
    draw: p => `
      <circle cx="48" cy="48" r="26" fill="none" stroke="${p.ink}" stroke-width="7" stroke-linecap="round"
              stroke-dasharray="82 200" transform="rotate(-45 48 48)"/>
      <circle cx="48" cy="48" r="14" fill="${p.accent}"/>`,
  },
  {
    id: 'galets', collection: 'abstrait', keywords: ['galet', 'forme', 'organique'],
    draw: p => `
      <ellipse cx="38" cy="54" rx="20" ry="24" fill="${p.ink}" transform="rotate(-18 38 54)"/>
      <ellipse cx="60" cy="42" rx="13" ry="16" fill="${p.accent}" opacity=".85" transform="rotate(22 60 42)"/>`,
  },
  {
    id: 'prisme', collection: 'motifs', keywords: ['triangle', 'prisme', 'géométrie'],
    draw: p => `
      <path d="M48 22 L72 66 L24 66 Z" fill="${p.ink}"/>
      <path d="M48 40 L62 66 L34 66 Z" fill="${p.accent}" opacity=".7"/>`,
  },
  {
    id: 'damier', collection: 'motifs', keywords: ['damier', 'carré', 'grille'],
    draw: p => {
      let s = ''
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        if ((r + c) % 2) continue
        s += `<rect x="${24 + c * 12}" y="${24 + r * 12}" width="12" height="12" rx="3" fill="${(r + c) % 4 ? p.ink : p.accent}"/>`
      }
      return s
    },
  },
  {
    id: 'collines', collection: 'nature', keywords: ['colline', 'paysage', 'montagne', 'soleil'],
    draw: p => `
      <circle cx="64" cy="34" r="9" fill="${p.accent}"/>
      <path d="M8 72 Q30 46 48 62 Q64 76 88 54 L88 88 L8 88 Z" fill="${p.ink}"/>`,
  },
  {
    id: 'feuille', collection: 'nature', keywords: ['feuille', 'plante', 'nature', 'végétal'],
    draw: p => `
      <path d="M48 20 C70 30 74 58 48 76 C22 58 26 30 48 20 Z" fill="${p.ink}"/>
      <path d="M48 26 L48 74" stroke="${p.accent}" stroke-width="3" stroke-linecap="round"/>`,
  },
  {
    id: 'vagues', collection: 'nature', keywords: ['vague', 'mer', 'eau', 'océan'],
    draw: p => `
      <path d="M14 46 Q28 36 42 46 T70 46 T96 46" fill="none" stroke="${p.accent}" stroke-width="6" stroke-linecap="round"/>
      <path d="M14 60 Q28 50 42 60 T70 60 T96 60" fill="none" stroke="${p.ink}" stroke-width="6" stroke-linecap="round"/>
      <path d="M14 74 Q28 64 42 74 T70 74 T96 74" fill="none" stroke="${p.accent}" stroke-width="6" stroke-linecap="round" opacity=".6"/>`,
  },
  {
    id: 'lune', collection: 'cosmos', keywords: ['lune', 'nuit', 'croissant', 'étoile'],
    draw: p => `
      <path d="M60 22 A26 26 0 1 0 60 74 A21 21 0 1 1 60 22 Z" fill="${p.ink}"/>
      <circle cx="30" cy="30" r="2.5" fill="${p.accent}"/>
      <circle cx="24" cy="60" r="2" fill="${p.accent}"/>
      <circle cx="40" cy="20" r="1.8" fill="${p.accent}"/>`,
  },
  {
    id: 'planete', collection: 'cosmos', keywords: ['planète', 'anneau', 'espace', 'saturne'],
    draw: p => `
      <circle cx="48" cy="46" r="18" fill="${p.ink}"/>
      <ellipse cx="48" cy="52" rx="32" ry="9" fill="none" stroke="${p.accent}" stroke-width="4" transform="rotate(-16 48 52)"/>`,
  },
  {
    id: 'comete', collection: 'cosmos', keywords: ['comète', 'filante', 'espace'],
    draw: p => `
      <path d="M22 70 L58 34" stroke="${p.accent}" stroke-width="6" stroke-linecap="round" opacity=".65"/>
      <path d="M32 74 L62 44" stroke="${p.accent}" stroke-width="4" stroke-linecap="round" opacity=".4"/>
      <circle cx="64" cy="32" r="11" fill="${p.ink}"/>`,
  },
  {
    id: 'spirale', collection: 'abstrait', keywords: ['spirale', 'tourbillon'],
    draw: p => `
      <path d="M48 20 A28 28 0 1 1 20 48 A28 28 0 0 1 48 20" fill="none" stroke="${p.ink}" stroke-width="6" stroke-linecap="round"/>
      <path d="M48 34 A14 14 0 1 1 34 48" fill="none" stroke="${p.accent}" stroke-width="6" stroke-linecap="round"/>`,
  },
  {
    id: 'confettis', collection: 'motifs', keywords: ['confetti', 'points', 'fête'],
    draw: p => {
      const pts = [[30, 30], [58, 26], [70, 48], [44, 44], [26, 56], [52, 66], [72, 68], [38, 74]]
      return pts.map(([x, y], i) =>
        `<circle cx="${x}" cy="${y}" r="${i % 3 === 0 ? 7 : 4.5}" fill="${i % 2 ? p.accent : p.ink}" opacity="${i % 3 === 0 ? 1 : .8}"/>`
      ).join('')
    },
  },
]

export interface Illustration {
  /** `<recipe>-<palette>`, stable - it is the file name once picked. */
  id: string
  collection: Recipe['collection']
  keywords: string[]
  svg: string
}

function compose(recipe: Recipe, paletteId: string, p: Palette): string {
  const gid = `g-${recipe.id}-${paletteId}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">` +
    `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${p.bg[0]}"/><stop offset="1" stop-color="${p.bg[1]}"/>` +
    `</linearGradient></defs>` +
    `<rect width="96" height="96" fill="url(#${gid})"/>` +
    recipe.draw(p) +
    `</svg>`
}

/** The whole gallery: every recipe in every palette. */
export const ILLUSTRATIONS: Illustration[] = RECIPES.flatMap(r =>
  PALETTES.map(({ id: pid, palette }) => ({
    id: `${r.id}-${pid}`,
    collection: r.collection,
    keywords: [...r.keywords, pid, r.collection],
    svg: compose(r, pid, palette),
  }))
)

export const COLLECTIONS: ReadonlyArray<{ id: Recipe['collection']; label: string }> = [
  { id: 'abstrait', label: 'Abstrait' },
  { id: 'nature',   label: 'Nature' },
  { id: 'cosmos',   label: 'Cosmos' },
  { id: 'motifs',   label: 'Motifs' },
]

/** Inline `src` for an <img>, without a network round-trip. */
export function illustrationSrc(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** The picked illustration as a real file, ready to upload. */
export function illustrationFile(ill: Illustration): File {
  return new File([ill.svg], `${ill.id}.svg`, { type: 'image/svg+xml' })
}
