/**
 * The parts of `ThemesPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { type ThemeDef } from "../../core/store/themeStore"
import type { ThemesPanel } from './ThemesPanel'

function ThemeChip({ theme }: { theme: ThemeDef }) {
  const bg      = theme.vars['--color-surface-1'] ?? '#f8f9fa'
  const surface = theme.vars['--color-surface-0'] ?? '#ffffff'
  const primary = theme.vars['--color-primary']   ?? '#1a73e8'
  const textSec = theme.vars['--color-text-secondary'] ?? '#5f6368'
  const border  = theme.vars['--color-border']    ?? '#e0e0e0'

  return (
    <div className="rounded-md overflow-hidden border flex-shrink-0"
         style={{ background: bg, borderColor: border, width: 56, height: 40 }}>
      <div className="flex items-center gap-1 px-1.5 py-1"
           style={{ background: surface, borderBottom: `1px solid ${border}` }}>
        <div className="rounded-full" style={{ width: 5, height: 5, background: primary }} />
        <div className="rounded flex-1" style={{ height: 3, background: textSec, opacity: 0.3 }} />
      </div>
      <div className="flex gap-1 p-1.5">
        <div className="rounded" style={{ width: 12, height: 4, background: primary, opacity: 0.7 }} />
        <div className="rounded" style={{ width: 16, height: 4, background: textSec, opacity: 0.35 }} />
      </div>
    </div>
  )
}
export { ThemeChip }

export function Part1({ fileInputRef, handleFileChange }: { fileInputRef: NonNullable<ThemesPanel['fileInputRef']>; handleFileChange: ThemesPanel['handleFileChange'] }) {
  return (
    <input ref={fileInputRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileChange} />
  )
}

export function Part2({ zipInputRef, handleZipChange }: { zipInputRef: NonNullable<ThemesPanel['zipInputRef']>; handleZipChange: ThemesPanel['handleZipChange'] }) {
  return (
    <input ref={zipInputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={handleZipChange} />
  )
}

export function Part3() {
  return (
    <pre className="text-xs text-text-tertiary overflow-x-auto">{`{
  "id":           "my-theme",
  "name":         "My Theme",
  "color_scheme": "light",
  "vars": { "--color-primary": "#1a73e8", "--color-surface-0": "#ffffff", ... },
  "global":  { "css": "global.css", "script": "global.js" },
  "modules": { "drive": { "css": "modules/drive.css", "script": "modules/drive.js" } }
}`}</pre>
  )
}
