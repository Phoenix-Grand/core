/**
 * MediaViewer - generic image/video/audio/pdf/text full-screen preview.
 * For IMAGES it browses the other images of the same folder as a gallery
 * (on-screen arrows + ←/→ keys). Other types open alone.
 */
import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'
import { signedUrl, useSignedUrl } from '@kubuno/sdk'
import type { FileItem } from '../api'
import type { ThumbSpec } from '../storageSource'

export function MediaViewer({ files, start, contentOf, onClose }: {
  files: FileItem[]; start: number; contentOf: (f: FileItem) => ThumbSpec; onClose: () => void
}) {
  const [idx, setIdx] = useState(start)
  const file = files[Math.max(0, Math.min(idx, files.length - 1))]
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  const m = file.mime_type
  const isText = m.startsWith('text/') || m === 'application/json' || /\.(txt|md|csv|log|json|xml|yaml|yml)$/i.test(file.name)
  const canNav = m.startsWith('image/') && files.length > 1
  const go = (d: number) => setIdx(i => (i + d + files.length) % files.length)
  // <img>/<video>/<audio>/<iframe> cannot send the Authorization header: the
  // URL carries a signed ticket (a long-lived `stream` one for media and PDFs,
  // whose players issue Range requests for as long as the viewer is open).
  // Blob URLs pass through unchanged.
  const streamed = m.startsWith('video/') || m.startsWith('audio/') || m === 'application/pdf'
  const src = useSignedUrl(url, { purpose: streamed ? 'stream' : 'view' })

  useEffect(() => {
    let alive = true; let obj: string | null = null
    setErr(false); setText(null)
    const spec = contentOf(file)
    setUrl(spec.kind === 'url' ? (spec.url ?? null) : null)
    const txtKind = m.startsWith('text/') || m === 'application/json' || /\.(txt|md|csv|log|json|xml|yaml|yml)$/i.test(file.name)
    async function run() {
      try {
        let blob: Blob | null = null
        if (spec.kind === 'blob' && spec.load) blob = await spec.load()
        if (blob) { obj = URL.createObjectURL(blob); if (alive) setUrl(obj) }
        if (txtKind) {
          const t = blob ? await blob.text() : (spec.url ? await (await fetch(await signedUrl(spec.url))).text() : '')
          if (alive) setText(t)
        }
      } catch { if (alive) setErr(true) }
    }
    run()
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj) }
  }, [file.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (canNav && e.key === 'ArrowRight') go(1)
      else if (canNav && e.key === 'ArrowLeft') go(-1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canNav, files.length, onClose])

  return (
    <div className="fixed inset-0 z-[9998] bg-black/80 flex flex-col" onClick={onClose}>
      <div className="flex items-center justify-between px-5 py-3 text-white/90" onClick={e => e.stopPropagation()}>
        <span className="text-sm font-medium truncate">
          {file.name}{canNav && <span className="ml-2 text-white/50">{idx + 1} / {files.length}</span>}
        </span>
        <button onClick={onClose} className="p-1.5 rounded-full hover:bg-white/15 transition-colors"><X size={20} /></button>
      </div>
      <div className="relative flex-1 min-h-0 flex items-center justify-center p-4" onClick={e => e.stopPropagation()}>
        {canNav && (
          <button onClick={() => go(-1)} aria-label="Previous"
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/25 text-white transition-colors">
            <ChevronLeft size={26} />
          </button>
        )}
        {err ? (
          <p className="text-white/80 text-sm">Preview unavailable.</p>
        ) : isText ? (
          <pre className="max-w-4xl w-full max-h-full overflow-auto bg-white text-text-primary text-sm rounded-lg p-4 whitespace-pre-wrap">{text ?? '…'}</pre>
        ) : !src ? (
          <Loader2 size={28} className="animate-spin text-white/80" />
        ) : m.startsWith('image/') ? (
          <img src={src} alt={file.name} className="max-w-full max-h-full object-contain" />
        ) : m.startsWith('video/') ? (
          <video src={src} controls autoPlay className="max-w-full max-h-full" />
        ) : m.startsWith('audio/') ? (
          <audio src={src} controls autoPlay className="w-[min(600px,90vw)]" />
        ) : m === 'application/pdf' ? (
          <iframe src={src} title={file.name} className="w-full h-full bg-white rounded-lg" />
        ) : (
          <p className="text-white/80 text-sm">Preview unavailable — download the file.</p>
        )}
        {canNav && (
          <button onClick={() => go(1)} aria-label="Next"
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/25 text-white transition-colors">
            <ChevronRight size={26} />
          </button>
        )}
      </div>
    </div>
  )
}
