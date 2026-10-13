import type { ThemeDef } from '../../core/store/themeStore'
import PreviewFrame from './PreviewFrame'
import GalleryBody from '../theme/GalleryBody'

/**
 * Live preview of a theme's "objects" — primitives and complex components —
 * rendered with the theme's colours/variables scoped to this subtree only, and
 * (for trusted themes) its component overrides resolved via the preview scope.
 * Nothing here affects the live application until the theme is applied.
 *
 * Public entry: renders the gallery body inside an isolated Shadow DOM
 * (PreviewFrame). The previewed theme's variables AND its global.css apply ONLY
 * there, while the live (active) theme is excluded — so the preview reflects the
 * selected theme alone and is never tinted by whichever theme is applied to the app.
 *
 * ── Anatomy ──────────────────────────────────────────────────────────────────
 *   theme/GalleryBody.tsx   accordion assembly (one entry per group)
 *   theme/groups/*.tsx      one file per group of previewed objects
 *   theme/mocks/*.tsx       static reproductions of real app chrome (shell,
 *                           Office ribbon, Drive objects)
 *   theme/PreviewDemos.tsx  bounded stage + interactive demos (overlays, resize…)
 */
export default function ThemePreviewGallery({ theme }: { theme: ThemeDef }) {
  return (
    <PreviewFrame theme={theme}>
      <GalleryBody theme={theme} />
    </PreviewFrame>
  )
}
