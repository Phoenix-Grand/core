import axios from 'axios'

/**
 * `/api/v1/config` - les réglages d'instance publics, lus par une demi-douzaine
 * de consommateurs sans lien entre eux : la langue et le thème au démarrage, le
 * délai d'inactivité, le logo de l'instance, la page de connexion, des widgets
 * d'accueil, des panneaux d'administration…
 *
 * Chacun faisait sa propre requête, si bien que la même réponse était
 * téléchargée quatre fois par chargement de page. Ce module est la SOURCE
 * UNIQUE : il partage la requête en cours entre tous les appelants simultanés,
 * puis garde brièvement le résultat.
 *
 * `axios` brut, sans le client authentifié : c'est la seule surface joignable
 * SANS session, et la page de connexion en dépend avant tout jeton.
 */
export type PublicConfig = Record<string, unknown>

/** La config publique ne bouge qu'au rythme des réglages d'instance. */
const TTL_MS = 60_000

let cached: { at: number; value: PublicConfig } | null = null
let inflight: Promise<PublicConfig> | null = null

/**
 * La configuration publique, depuis le cache si elle est fraîche, sinon depuis
 * le réseau. Les appels concurrents partagent une seule requête.
 *
 * Rejette comme la requête sous-jacente : chaque appelant garde sa propre
 * conduite en cas d'échec (valeur de repli, écran dégradé…). Un échec n'est
 * jamais mémorisé, donc l'appel suivant retente.
 */
export function getPublicConfig(): Promise<PublicConfig> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.value)
  if (inflight) return inflight

  inflight = axios
    .get<{ config?: PublicConfig }>('/api/v1/config', { withCredentials: true })
    .then((r) => {
      const value = r.data?.config ?? {}
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => { inflight = null })

  return inflight
}

/**
 * Oublie la copie mémorisée - à appeler quand un réglage public vient d'être
 * modifié depuis l'administration, pour que la prochaine lecture reparte du
 * serveur sans attendre la fin du délai de fraîcheur.
 */
export function invalidatePublicConfig(): void {
  cached = null
}
