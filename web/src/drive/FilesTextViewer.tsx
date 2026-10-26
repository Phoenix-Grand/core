// Visionneuse de fichiers TEXTE (txt, md, csv, log, json, code…) - agnostique de la
// source : alimentée par un `load()` qui renvoie le Blob via le chemin AUTHENTIFIÉ
// de la source (local, System, distant). Fenêtre flottante redimensionnable avec
// numéros de ligne, retour à la ligne, copie et téléchargement.
import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Copy, Check, Download, WrapText } from 'lucide-react'
import { FloatingWindow } from '@ui'

// Extensions purement textuelles (hors types à visionneuse dédiée : svg=image, pdf, polices…).
const TEXT_EXTS = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'json', 'jsonc', 'ndjson', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less',
  'html', 'htm', 'vue', 'svelte', 'astro',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
  'c', 'h', 'cpp', 'cxx', 'cc', 'hpp', 'hh', 'cs', 'm', 'mm',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto', 'lua', 'pl', 'r', 'dart', 'ex', 'exs', 'erl', 'clj', 'hs', 'vim',
  'dockerfile', 'gitignore', 'gitattributes', 'editorconfig', 'makefile', 'cmake', 'gradle', 'diff', 'patch', 'srt', 'vtt',
])
const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/x-yaml', 'application/yaml',
  'application/javascript', 'application/x-sh', 'application/x-httpd-php',
  'application/toml', 'application/x-toml', 'image/svg+xml',
])

/** Le fichier est-il consultable comme du texte ? (MIME `text/*`, MIME texte connu, ou extension.) */
export function isTextFile(file: { name: string; mime_type: string }): boolean {
  const m = (file.mime_type || '').toLowerCase()
  if (m.startsWith('text/')) return true
  if (TEXT_MIMES.has(m)) return true
  const lower = file.name.toLowerCase()
  const ext = lower.includes('.') ? lower.split('.').pop()! : lower // ex. « Dockerfile », « Makefile »
  return TEXT_EXTS.has(ext)
}

const MAX_CHARS = 2_000_000 // au-delà : tronqué (perf + mémoire)

interface Props {
  name:    string
  load:    () => Promise<Blob>
  onClose: () => void
}

export default function FilesTextViewer({ name, load, onClose }: Props) {
  const { t } = useTranslation('drive')
  const [text,      setText]      = useState<string | null>(null)
  const [error,     setError]     = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [wrap,      setWrap]      = useState(false)
  const [copied,    setCopied]    = useState(false)

  useEffect(() => {
    let alive = true
    setText(null); setError(false); setTruncated(false)
    load()
      .then(blob => blob.text())
      .then(raw => {
        if (!alive) return
        // Fichier binaire mal étiqueté « texte » → octets NUL en tête : on refuse.
        if (/\u0000/.test(raw.slice(0, 2000))) { setError(true); return }
        if (raw.length > MAX_CHARS) { setText(raw.slice(0, MAX_CHARS)); setTruncated(true) }
        else setText(raw)
      })
      .catch(() => { if (alive) setError(true) })
    return () => { alive = false }
  }, [load])

  const lineCount = useMemo(() => (text ? text.split('\n').length : 0), [text])
  const gutter    = useMemo(
    () => (text && !wrap ? Array.from({ length: lineCount }, (_, i) => i + 1).join('\n') : ''),
    [text, wrap, lineCount],
  )

  const ext = (name.includes('.') ? name.split('.').pop()! : name).toUpperCase()

  const copy = async () => {
    if (text == null) return
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) }
    catch { /* presse-papiers indisponible */ }
  }
  const download = () => {
    if (text == null) return
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a'); a.href = url; a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const titleActions = (
    <>
      <button
        onClick={() => setWrap(v => !v)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-sm transition-colors ${
          wrap ? 'border-primary text-primary bg-primary-light' : 'border-border text-text-secondary hover:bg-surface-1'
        }`}
        title={t('txtview.wrap', { defaultValue: "Word wrap" })}
      >
        <WrapText size={15} />
        <span className="hidden sm:inline">{t('txtview.wrap', { defaultValue: "Word wrap" })}</span>
      </button>
      <button
        onClick={copy}
        disabled={text == null}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border text-sm
                   text-text-secondary hover:bg-surface-1 disabled:opacity-40"
        title={t('txtview.copy', { defaultValue: 'Copy' })}
      >
        {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
        <span className="hidden sm:inline">{copied ? t('txtview.copied', { defaultValue: "Copied" }) : t('txtview.copy', { defaultValue: 'Copy' })}</span>
      </button>
      <button
        onClick={download}
        disabled={text == null}
        className="p-2 text-text-tertiary hover:text-text-primary rounded-lg hover:bg-surface-1 disabled:opacity-40"
        title={t('common.download', { defaultValue: "Download" })}
      >
        <Download size={16} />
      </button>
    </>
  )

  return (
    <FloatingWindow
      title={
        <span className="flex items-center gap-2">
          <span className="font-semibold">{name}</span>
          <span className="text-xs text-text-tertiary font-normal">{ext}{text != null && !error && ` · ${lineCount} ${t('txtview.lines', { defaultValue: 'lines' })}`}</span>
        </span>
      }
      icon={<FileText size={16} className="text-sky-600" />}
      onClose={onClose}
      defaultWidth={880}
      defaultHeight={680}
      resizable
      titleActions={titleActions}
    >
      <div className="flex flex-col flex-1 min-h-0">
        {truncated && (
          <div className="px-4 py-1.5 text-xs text-warning bg-warning-light border-b border-border shrink-0">
            {t('txtview.truncated', { defaultValue: "Large file — preview truncated." })}
          </div>
        )}
        {error ? (
          <div className="flex flex-col items-center justify-center flex-1 text-text-tertiary gap-3">
            <FileText size={40} className="opacity-30" />
            <p className="text-sm">{t('txtview.cannot_load', { defaultValue: "Preview unavailable (binary or unreadable file)." })}</p>
          </div>
        ) : text == null ? (
          <div className="flex items-center justify-center flex-1">
            <div className="w-6 h-6 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : text.length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-text-tertiary text-sm">
            {t('txtview.empty', { defaultValue: 'Empty file.' })}
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 overflow-auto bg-white font-mono text-xs leading-5">
            {!wrap && (
              <pre className="select-none text-right text-text-tertiary px-3 py-3 bg-surface-1 border-r border-border sticky left-0">
                {gutter}
              </pre>
            )}
            <pre className={`flex-1 px-4 py-3 text-text-primary ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>
              {text}
            </pre>
          </div>
        )}
      </div>
    </FloatingWindow>
  )
}
