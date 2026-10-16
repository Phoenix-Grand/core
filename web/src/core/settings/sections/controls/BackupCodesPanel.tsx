import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Download, Printer } from 'lucide-react'
import { Button, Callout, Card } from '@ui'

export interface Props {
  codes: string[]
  /** Shown once acknowledged; omit to keep the panel permanent. */
  onDone?: () => void
}

/**
 * The one moment backup codes are readable.
 *
 * The server hashes them with argon2id and has no way to show them again, so the
 * panel leans on that instead of hiding it: the user is told plainly, and given
 * the three ways people actually keep a code sheet - clipboard, a printout, a
 * file. A dialog that only offered "close" would be a trap.
 */
export function BackupCodesPanel({ codes, onDone }: Props) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const asText = codes.join('\n')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard denied (insecure context, permission): the codes are on screen
      // and the two other paths still work, so there is nothing to report.
    }
  }

  const download = () => {
    const blob = new Blob([`${t('settings.bc_file_header')}\n\n${asText}\n`], {
      type: 'text/plain;charset=utf-8',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'kubuno-codes-de-secours.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  // Printed from an isolated iframe rather than by styling the page: the sheet
  // must not inherit the application's layout, and the app must not have to carry
  // print rules for a panel shown once.
  const print = () => {
    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.right = '0'
    frame.style.bottom = '0'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    document.body.appendChild(frame)
    const doc = frame.contentDocument
    if (!doc) { frame.remove(); return }
    const rows = codes.map((c) => `<li>${c}</li>`).join('')
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${t('settings.bc_title')}</title>` +
      '<style>body{font-family:system-ui,sans-serif;padding:32px}' +
      'h1{font-size:16px;margin:0 0 4px}p{font-size:12px;color:#444;margin:0 0 20px}' +
      'ol{font-family:ui-monospace,monospace;font-size:15px;line-height:2;columns:2}' +
      '</style></head><body>' +
      `<h1>${t('settings.bc_title')}</h1><p>${t('settings.bc_print_note')}</p><ol>${rows}</ol>` +
      '</body></html>'
    )
    doc.close()
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    window.setTimeout(() => frame.remove(), 1000)
  }

  return (
    <Card bodyClassName="space-y-4">
      <Callout variant="warning" title={t('settings.bc_once_title')} t={t}>
        {t('settings.bc_once_desc')}
      </Callout>

      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-text-primary select-all">
        {codes.map((code) => (
          <li key={code} className="tracking-wider">{code}</li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={copied ? <Check size={14} /> : <Copy size={14} />}
          onClick={copy}
        >
          {copied ? t('settings.bc_copied') : t('settings.bc_copy')}
        </Button>
        <Button variant="secondary" size="sm" icon={<Printer size={14} />} onClick={print}>
          {t('settings.bc_print')}
        </Button>
        <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={download}>
          {t('settings.bc_download')}
        </Button>
        {onDone && (
          <Button size="sm" onClick={onDone}>
            {t('settings.bc_done')}
          </Button>
        )}
      </div>
    </Card>
  )
}
