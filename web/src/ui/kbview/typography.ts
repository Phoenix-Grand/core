/**
 * The web target's typography, as the views tooling needs it (VIEWS-SPEC §7): the production
 * faces with their files and licences, the family stacks, and the values of the shared
 * typographic roles (`Label Role="…"`, the `--kb-text-*` tokens).
 *
 * The source of truth stays `src/index.css` (`@font-face`, `--font-family-sans`, body and button
 * weights) and `src/theme.css` (`--kb-text-*`, `--font-family-mono`); the registry test reads both
 * files and fails when this table no longer matches them. The design surface (`@kubuno/host-runtime`,
 * the project's dev server, the VSIX fallback host) must serve exactly these files.
 */

/** One `@font-face` of the host, served from `/fonts/` (`public/fonts/` in the sources). */
export interface FontFace {
  readonly family: string
  readonly style: 'normal' | 'italic'
  /** CSS `font-weight` range (variable faces) or single weight. */
  readonly weight: string
  /** Path under `public/`. */
  readonly file: string
  /** SPDX identifier of the face's licence. */
  readonly license: 'OFL-1.1' | 'Apache-2.0'
  /** The licence text shipped next to the file, under `public/` - `null` while it is missing. */
  readonly licenseFile: string | null
}

export const WEB_FONT_FACES: readonly FontFace[] = [
  { family: 'Plus Jakarta Sans', style: 'normal', weight: '200 800', file: 'fonts/PlusJakartaSans.woff2', license: 'OFL-1.1', licenseFile: 'fonts/PlusJakartaSans-OFL.txt' },
  { family: 'Plus Jakarta Sans', style: 'italic', weight: '200 800', file: 'fonts/PlusJakartaSans-Italic.woff2', license: 'OFL-1.1', licenseFile: 'fonts/PlusJakartaSans-OFL.txt' },
  { family: 'Outfit', style: 'normal', weight: '100 900', file: 'fonts/Outfit.woff2', license: 'OFL-1.1', licenseFile: 'fonts/Outfit-OFL.txt' },
  // Roboto (Apache 2.0) and DM Mono (OFL 1.1) ship without their licence text today: to be added
  // to public/fonts before @kubuno/host-runtime redistributes them (VIEWS-SPEC §7.2).
  { family: 'Roboto', style: 'normal', weight: '100 900', file: 'fonts/Roboto.woff2', license: 'Apache-2.0', licenseFile: null },
  { family: 'DM Mono', style: 'normal', weight: '400', file: 'fonts/DMMono-Regular.woff2', license: 'OFL-1.1', licenseFile: null },
]

/** The family stacks (`--font-family-sans` of `index.css`, `--font-family-mono` of `theme.css`). */
export const WEB_FONT_FAMILIES = {
  sans: ['Plus Jakarta Sans', 'Outfit', 'Roboto', 'Arial', 'sans-serif'],
  mono: ['DM Mono', 'Fira Code', 'monospace'],
} as const

/**
 * The typographic roles shared by both targets (`Label Role`, desktop `kubuno_ui::display::Role`),
 * with their web token and size in CSS px. The desktop keeps its own sizes for the same roles.
 */
export const WEB_TEXT_ROLES = {
  Micro: { token: '--kb-text-micro', size: 10.5 },
  Meta: { token: '--kb-text-meta', size: 11.5 },
  Body: { token: '--kb-text-body', size: 13.5 },
  Heading: { token: '--kb-text-heading', size: 15.5 },
  Title: { token: '--kb-text-title', size: 21.5 },
  Badge: { token: '--kb-text-badge', size: 10 },
  Caption: { token: '--kb-text-caption', size: 11 },
  Subtitle: { token: '--kb-text-subtitle', size: 16 },
  Display: { token: '--kb-text-display', size: 24 },
} as const

/** Page titles (`--kb-text-page`): not a Label role, the page header's own step. */
export const WEB_PAGE_TITLE = { token: '--kb-text-page', size: 22.5, adminSize: 27.5 } as const

/** Weights the host enforces (`index.css`): running text 500, `font-medium` → 600, buttons 500. */
export const WEB_FONT_WEIGHTS = { body: 500, medium: 600, button: 500 } as const
