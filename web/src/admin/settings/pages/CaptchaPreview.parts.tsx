/**
 * The parts of `CaptchaPreview.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { RefreshCw } from "lucide-react"
import type { CaptchaPreview } from './CaptchaPreview'

export function Part1({ isFetching }: { isFetching: NonNullable<CaptchaPreview['isFetching']> }) {
  return (
    <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
  )
}

export function Part2({ c, t }: { c: NonNullable<CaptchaPreview['c']>; t: NonNullable<CaptchaPreview['tr']> }) {
  return (
    <img
              src={c.image}
              alt={t('admin.captcha_preview_title', { defaultValue: 'Aperçu' })}
              width={180}
              height={60}
              className="block rounded-md"
              style={{ border: '1px solid var(--color-border)', background: '#f1f3f4' }}
            />
  )
}

export function Part3({ c }: { c: NonNullable<CaptchaPreview['c']> }) {
  return (
    <div
                className="relative select-none overflow-hidden rounded-md"
                style={{ width: c.width, height: c.height, border: '1px solid var(--color-border)' }}
              >
                <img src={c.background} alt="" width={c.width} height={c.height} draggable={false} />
                <img
                  src={c.piece}
                  alt=""
                  draggable={false}
                  style={{
                    position: 'absolute',
                    top: c.piece_y,
                    left: 0,
                    width: c.piece_width,
                    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
                  }}
                />
              </div>
  )
}
