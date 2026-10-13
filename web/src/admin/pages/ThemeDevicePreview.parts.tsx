/**
 * The parts of `ThemeDevicePreview.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import ThemePreviewGallery from "./ThemePreviewGallery"
import type { ThemeDevicePreview } from './ThemeDevicePreview'

export function Part1({ cur_w, theme }: { cur_w: number; theme: NonNullable<ThemeDevicePreview['props']['theme']> }) {
  return (
    <div
                className="flex-shrink-0 overflow-hidden rounded-[1.6rem] border-[6px] border-surface-3 bg-white shadow-md"
                style={{ width: cur_w }}
              >
                <ThemePreviewGallery theme={theme} />
              </div>
  )
}
