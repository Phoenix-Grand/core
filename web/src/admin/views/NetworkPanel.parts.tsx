/**
 * The parts of `NetworkPanel.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { ShieldCheck, Upload, AlertTriangle, Trash2 } from "lucide-react"
import { Button, Callout, Textarea } from "@ui"
import type { NetworkPanel } from './NetworkPanel'

export function Part1({ askDelete, cert, t }: { askDelete: NetworkPanel['askDelete']; cert: NonNullable<NetworkPanel['cert']>; t: NonNullable<NetworkPanel['tr']> }) {
  return (
    <Button variant="ghost" size="sm" onClick={() => askDelete(cert)}>
                    <Trash2 className="h-4 w-4" />
                    {t('admin.net_cert_delete', 'Supprimer ce certificat')}
                  </Button>
  )
}

export function Part2({ t }: { t: NonNullable<NetworkPanel['tr']> }) {
  return (
    <Callout variant="info" icon={<AlertTriangle className="h-5 w-5" />}>
                {t('admin.net_cert_none', 'Aucun certificat installé. Importez-en un ci-dessous pour pouvoir activer le HTTPS.')}
              </Callout>
  )
}

export function Part3({ t, certPem, setCertPem }: { t: NonNullable<NetworkPanel['tr']>; certPem: NonNullable<NetworkPanel['certPem']>; setCertPem: NonNullable<NetworkPanel['setCertPem']> }) {
  return (
    <Textarea
                label={t('admin.net_cert_chain', 'Certificat (chaîne PEM : feuille + intermédiaires)')}
                value={certPem}
                onChange={e => setCertPem(e.target.value)}
                placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
                className="font-mono text-xs"
                spellCheck={false}
              />
  )
}

export function Part4({ t, keyPem, setKeyPem }: { t: NonNullable<NetworkPanel['tr']>; keyPem: NonNullable<NetworkPanel['keyPem']>; setKeyPem: NonNullable<NetworkPanel['setKeyPem']> }) {
  return (
    <Textarea
                label={t('admin.net_cert_key', 'Clé privée (PEM, non chiffrée)')}
                value={keyPem}
                onChange={e => setKeyPem(e.target.value)}
                placeholder={'-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----'}
                className="font-mono text-xs"
                spellCheck={false}
              />
  )
}

export function Part5({ upload, certPem, keyPem, t }: { upload: NonNullable<NetworkPanel['upload']>; certPem: NonNullable<NetworkPanel['certPem']>; keyPem: NonNullable<NetworkPanel['keyPem']>; t: NonNullable<NetworkPanel['tr']> }) {
  return (
    <Button
                variant="primary"
                onClick={() => upload.mutate()}
                disabled={upload.isPending || !certPem.trim() || !keyPem.trim()}
              >
                <Upload className="h-4 w-4" />
                {upload.isPending
                  ? t('admin.net_cert_installing', 'Installation…')
                  : t('admin.net_cert_install', 'Installer le certificat')}
              </Button>
  )
}

export function Part6({ requestAcme, t }: { requestAcme: NonNullable<NetworkPanel['requestAcme']>; t: NonNullable<NetworkPanel['tr']> }) {
  return (
    <Button
                variant="primary"
                onClick={() => requestAcme.mutate()}
                disabled={requestAcme.isPending}
              >
                <ShieldCheck className="h-4 w-4" />
                {requestAcme.isPending
                  ? t('admin.net_acme_requesting', 'Obtention en cours…')
                  : t('admin.net_acme_request', 'Obtenir / renouveler maintenant')}
              </Button>
  )
}

export function Part7({ askDelete, c, removeCert, t }: { askDelete: NetworkPanel['askDelete']; c: NonNullable<NetworkPanel['rows_history']>[number]['c']; removeCert: NonNullable<NetworkPanel['removeCert']>; t: NonNullable<NetworkPanel['tr']> }) {
  return (
    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => askDelete(c)}
                      disabled={removeCert.isPending}
                      aria-label={t('common.delete', 'Supprimer')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
  )
}
