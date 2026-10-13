/**
 * The parts of `OAuthProvidersPanel.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { useState } from "react"
import { Plus, Trash2, Edit2, KeyRound, Copy, Check, Power, PlugZap } from "lucide-react"
import { Button, Callout, Input } from "@ui"
import type { OAuthProvidersPanel } from './OAuthProvidersPanel'
const PRESETS: { key: string; label: string; display: string; issuerHint: string; scopes: string }[] = [
  { key: 'keycloak', label: 'Keycloak', display: 'Keycloak', issuerHint: 'https://auth.exemple.com/realms/mon-realm', scopes: 'openid email profile' },
  { key: 'gitlab',   label: 'GitLab',   display: 'GitLab',   issuerHint: 'https://gitlab.com',                         scopes: 'openid email profile' },
  { key: 'authentik',label: 'Authentik',display: 'Authentik',issuerHint: 'https://auth.exemple.com/application/o/<app>/', scopes: 'openid email profile' },
  { key: 'generic',  label: 'Autre (OIDC)', display: '',     issuerHint: 'https://idp.exemple.com',                   scopes: 'openid email profile' },
]

export interface FormState {
  slug:          string
  display_name:  string
  issuer_url:    string
  client_id:     string
  client_secret: string
  scopes:        string
  button_color:  string
  enabled:       boolean
  allow_signup:  boolean
  claim_username:     string
  claim_email:        string
  claim_display_name: string
  claim_groups:       string
  sync_groups:        boolean
}

function ProviderForm({
  initial,
  isEdit,
  onSave,
  onCancel,
}: {
  initial: FormState
  isEdit: boolean
  onSave: (data: FormState) => void
  onCancel: () => void
}) {
  const [f, setF] = useState<FormState>(initial)
  const [copied, setCopied] = useState(false)
  const set = (k: keyof FormState, v: string | boolean) => setF((p) => ({ ...p, [k]: v }))

  const redirectUri = f.slug
    ? `${window.location.origin}/api/v1/auth/oauth/${f.slug}/callback`
    : `${window.location.origin}/api/v1/auth/oauth/<slug>/callback`

  const copyRedirect = () => {
    navigator.clipboard?.writeText(redirectUri).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    })
  }

  const canSave = f.slug.trim() && f.display_name.trim() && f.issuer_url.trim() && f.client_id.trim()

  return (
    <div className="border border-border rounded-xl p-4 bg-surface-1 space-y-4">
      {!isEdit && (
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setF((prev) => ({
                ...prev,
                slug: prev.slug || p.key === 'generic' ? prev.slug : p.key,
                display_name: prev.display_name || p.display,
                scopes: p.scopes,
              }))}
              className="px-3 py-1.5 rounded-md text-xs font-medium border border-border hover:bg-surface-2 transition-colors"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-text-secondary">Identifiant (slug, dans l'URL)</span>
          <Input value={f.slug} disabled={isEdit}
            onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="keycloak" />
        </label>
        <label className="text-sm">
          <span className="text-text-secondary">Nom affiché (bouton)</span>
          <Input value={f.display_name} onChange={(e) => set('display_name', e.target.value)} placeholder="Keycloak" />
        </label>
        <label className="text-sm md:col-span-2">
          <span className="text-text-secondary">Issuer URL (OIDC discovery)</span>
          <Input value={f.issuer_url} onChange={(e) => set('issuer_url', e.target.value)}
            placeholder="https://auth.exemple.com/realms/mon-realm" />
        </label>
        <label className="text-sm">
          <span className="text-text-secondary">Client ID</span>
          <Input value={f.client_id} onChange={(e) => set('client_id', e.target.value)} placeholder="kubuno" />
        </label>
        <label className="text-sm">
          <span className="text-text-secondary">
            Client secret {isEdit && <span className="text-text-tertiary">(laisser vide = inchangé)</span>}
          </span>
          <Input type="password" value={f.client_secret} onChange={(e) => set('client_secret', e.target.value)}
            placeholder={isEdit ? '••••••••' : 'secret (vide si client public)'} autoComplete="new-password" />
        </label>
        <label className="text-sm">
          <span className="text-text-secondary">Scopes</span>
          <Input value={f.scopes} onChange={(e) => set('scopes', e.target.value)} placeholder="openid email profile" />
        </label>
        <label className="text-sm">
          <span className="text-text-secondary">Couleur du bouton (hex, optionnel)</span>
          <Input value={f.button_color} onChange={(e) => set('button_color', e.target.value)} placeholder="#4d9de0" />
        </label>
      </div>

      {/* ── Mappage des revendications ────────────────────────────────────
          Les quatre noms étaient codés en dur : justes pour qui les avait
          écrits, faux pour tout fournisseur ayant choisi les siens. Un chemin
          pointé est accepté (resource_access.<client>.roles chez Keycloak). */}
      <div>
        <div className="text-sm font-medium text-text-primary">Mappage des revendications</div>
        <p className="mt-0.5 text-text-tertiary" style={{ fontSize: 'var(--kb-text-meta)' }}>
          Quelle revendication du profil alimente quel champ. Les valeurs par défaut sont celles
          d’OpenID Connect. Un chemin pointé est accepté.
        </p>
        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-sm">
            <span className="text-text-secondary">Identifiant</span>
            <Input value={f.claim_username} onChange={(e) => set('claim_username', e.target.value)}
              placeholder="preferred_username" className="font-mono" />
          </label>
          <label className="text-sm">
            <span className="text-text-secondary">Adresse électronique</span>
            <Input value={f.claim_email} onChange={(e) => set('claim_email', e.target.value)}
              placeholder="email" className="font-mono" />
          </label>
          <label className="text-sm">
            <span className="text-text-secondary">Nom affiché</span>
            <Input value={f.claim_display_name} onChange={(e) => set('claim_display_name', e.target.value)}
              placeholder="name" className="font-mono" />
          </label>
          <label className="text-sm">
            <span className="text-text-secondary">Groupes</span>
            <Input value={f.claim_groups} onChange={(e) => set('claim_groups', e.target.value)}
              placeholder="groups" className="font-mono" />
          </label>
        </div>
      </div>

      <div className="flex flex-wrap gap-5">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Activé (visible sur la page de connexion)
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={f.allow_signup} onChange={(e) => set('allow_signup', e.target.checked)} />
          Autoriser la création de comptes
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={f.sync_groups} onChange={(e) => set('sync_groups', e.target.checked)} />
          Importer les groupes revendiqués
        </label>
      </div>

      {f.sync_groups && (
        <Callout variant="info">
          Le fournisseur décidera de l’appartenance aux groupes sur cette instance. Seules les
          adhésions accordées par lui sont reprises : ce qu’un administrateur a attribué à la main
          n’est jamais retiré.
        </Callout>
      )}

      {/* Redirect URI to register in the IdP */}
      <div className="rounded-lg bg-surface-2 p-3 text-sm">
        <div className="text-text-secondary mb-1">URL de redirection à déclarer dans le fournisseur :</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs break-all text-text-primary">{redirectUri}</code>
          <button onClick={copyRedirect} className="p-1.5 rounded hover:bg-surface-3 text-text-secondary" title="Copier">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Annuler</Button>
        <Button disabled={!canSave} onClick={() => onSave(f)}>{isEdit ? 'Enregistrer' : 'Ajouter'}</Button>
      </div>
    </div>
  )
}
export { ProviderForm }

export function Part1({ setEditing }: { setEditing: NonNullable<OAuthProvidersPanel['setEditing']> }) {
  return (
    <Button onClick={() => setEditing('new')}><Plus size={16} className="mr-1" /> Ajouter</Button>
  )
}

export function Part2({ providers, editing, toFormState, submit, setEditing, testM, updateM, onDelete }: { providers: OAuthProvidersPanel['providers']; editing: OAuthProvidersPanel['editing']; toFormState: OAuthProvidersPanel['toFormState']; submit: OAuthProvidersPanel['submit']; setEditing: NonNullable<OAuthProvidersPanel['setEditing']>; testM: NonNullable<OAuthProvidersPanel['testM']>; updateM: NonNullable<OAuthProvidersPanel['updateM']>; onDelete: OAuthProvidersPanel['onDelete'] }) {
  return (
    <>{providers?.map((p) => (
                editing === p.id ? (
                  <ProviderForm key={p.id} initial={toFormState(p)} isEdit onSave={submit} onCancel={() => setEditing(null)} />
                ) : (
                  <div key={p.id} className="flex items-center gap-3 border border-border rounded-xl p-3">
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ background: (p.button_color || '#4d9de0') + '22', color: p.button_color || '#4d9de0' }}
                    >
                      <KeyRound size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{p.display_name}</span>
                        <span className="text-xs font-mono text-text-tertiary">/{p.slug}</span>
                        {!p.enabled && <span className="text-xs px-1.5 py-0.5 rounded bg-surface-3 text-text-tertiary">désactivé</span>}
                      </div>
                      <div className="text-sm text-text-tertiary truncate">{p.issuer_url}</div>
                    </div>
                    <button
                      onClick={() => testM.mutate(p.id)}
                      title="Tester la découverte OIDC"
                      className="p-2 rounded-lg hover:bg-surface-2 text-text-secondary"
                    >
                      <PlugZap size={16} />
                    </button>
                    <button
                      onClick={() => updateM.mutate({ id: p.id, data: { enabled: !p.enabled } })}
                      title={p.enabled ? 'Désactiver' : 'Activer'}
                      className={`p-2 rounded-lg hover:bg-surface-2 ${p.enabled ? 'text-success' : 'text-text-tertiary'}`}
                    >
                      <Power size={16} />
                    </button>
                    <button onClick={() => setEditing(p.id)} title="Modifier" className="p-2 rounded-lg hover:bg-surface-2 text-text-secondary">
                      <Edit2 size={16} />
                    </button>
                    <button onClick={() => onDelete(p)} title="Supprimer" className="p-2 rounded-lg hover:bg-danger-light text-danger">
                      <Trash2 size={16} />
                    </button>
                  </div>
                )
              ))}</>
  )
}

export function Part3({ p, r, r_authorization_endpoint, r_detail, r_hint }: { p: NonNullable<OAuthProvidersPanel['rows_items']>[number]['p']; r: NonNullable<OAuthProvidersPanel['rows_items']>[number]['r']; r_authorization_endpoint: string; r_detail: string; r_hint: string }) {
  return (
    <Callout key={`probe-${p.id}`} variant={r.ok ? 'success' : 'danger'} title={`${p.display_name} — ${r.message}`}>
                    <p className="break-all">{r.issuer_url} · {r.elapsed_ms} ms</p>
                    {r.authorization_endpoint && (
                      <pre className="mt-2 max-w-full overflow-x-auto rounded-md border border-border bg-surface-1 px-2.5 py-2 font-mono text-text-primary"
                           style={{ fontSize: 'var(--kb-text-meta)' }}>
    {`authorization_endpoint  ${r_authorization_endpoint}
token_endpoint          ${r.token_endpoint ?? ''}
userinfo_endpoint       ${r.userinfo_endpoint ?? ''}`}
                      </pre>
                    )}
                    {r.detail && (
                      <pre className="mt-2 max-w-full overflow-x-auto rounded-md border border-border bg-surface-1 px-2.5 py-2 font-mono text-text-primary"
                           style={{ fontSize: 'var(--kb-text-meta)' }}>
                        {r_detail}
                      </pre>
                    )}
                    {r.hint && <p className="mt-2">{r_hint}</p>}
                  </Callout>
  )
}
