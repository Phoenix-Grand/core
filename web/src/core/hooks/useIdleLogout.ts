import { useEffect } from 'react'
import { getPublicConfig } from '../api/publicConfig'
import { useAuthStore } from '../store/authStore'

// Gestion de session liée à l'ACTIVITÉ réelle de l'utilisateur.
//
// Trois mécanismes complémentaires :
//  1. Déconnexion après inactivité (réglage admin `security.session_idle_timeout_min`,
//     0 = désactivé). Minuteur réarmé à chaque interaction → déconnexion visible.
//  2. Keepalive proactif : tant que l'utilisateur est actif, on rafraîchit le jeton
//     AVANT son expiration. C'est essentiel car le backend mesure l'inactivité via
//     `last_used_at` du refresh token, lequel n'est mis à jour qu'à un `/auth/refresh`.
//     Sans keepalive, un utilisateur actif dans un module qui ne tape pas l'API REST
//     pendant un moment (édition locale, dessin, lecture, WebSocket only) voyait son
//     token expirer côté backend et se faisait déconnecter au prochain appel.
//  3. Activité PARTAGÉE entre onglets (BroadcastChannel). Sans ça, chaque onglet
//     mesure l'inactivité indépendamment alors que `logout()` ferme la session
//     entière : un onglet laissé inactif atteint la limite et déconnecte l'utilisateur
//     même s'il travaille dans un AUTRE onglet. Toute interaction dans un onglet réarme
//     donc le minuteur de tous les onglets.
//
// Plafond du keepalive : doit rester sous le TTL du jeton d'accès (15 min par défaut)
// pour qu'il soit renouvelé à temps, et sous la fenêtre d'inactivité.
const KEEPALIVE_CAP_MS = 8 * 60_000
const DEFAULT_IDLE_MS  = 30 * 60_000

export function useIdleLogout() {
  const user         = useAuthStore(s => s.user)
  const logout       = useAuthStore(s => s.logout)
  const refreshToken = useAuthStore(s => s.refreshToken)

  useEffect(() => {
    if (!user) return
    let idleMs = DEFAULT_IDLE_MS // repli avant lecture du réglage
    let cancelled = false
    let logoutTimer: ReturnType<typeof setTimeout> | undefined
    let keepAliveTimer: ReturnType<typeof setTimeout> | undefined
    let lastActivity = Date.now()

    // Canal d'activité partagé entre onglets de la même origine.
    let bc: BroadcastChannel | null = null
    try { bc = new BroadcastChannel('kubuno-session-activity') } catch { bc = null }
    let lastBroadcast = 0

    // Fenêtre pendant laquelle on considère l'utilisateur « actif » pour le
    // keepalive (même si la déconnexion auto est désactivée, on garde la session
    // vivante tant qu'il interagit, dans une fenêtre raisonnable).
    const activeWindow = () => (idleMs > 0 ? idleMs : DEFAULT_IDLE_MS)
    const keepAliveDelay = () =>
      Math.min(KEEPALIVE_CAP_MS, Math.max(60_000, Math.floor(activeWindow() * 0.4)))

    const armLogout = () => {
      if (logoutTimer) clearTimeout(logoutTimer)
      if (idleMs > 0) logoutTimer = setTimeout(() => { void logout() }, idleMs)
    }

    const onActivity = () => {
      if (cancelled) return
      const now = Date.now()
      lastActivity = now
      armLogout()
      // Diffuse l'activité aux autres onglets (throttle 1 s pour ne pas spammer).
      if (bc && now - lastBroadcast > 1000) {
        lastBroadcast = now
        bc.postMessage(now)
      }
    }

    // Activité reçue d'un autre onglet : on s'aligne sur l'horodatage le plus récent.
    if (bc) {
      bc.onmessage = (e) => {
        if (cancelled) return
        const ts = typeof e.data === 'number' ? e.data : 0
        if (ts > lastActivity) {
          lastActivity = ts
          armLogout()
        }
      }
    }

    const scheduleKeepAlive = () => {
      if (keepAliveTimer) clearTimeout(keepAliveTimer)
      keepAliveTimer = setTimeout(keepAliveTick, keepAliveDelay())
    }

    // Renouvelle proactivement le jeton tant que l'utilisateur a interagi
    // récemment, afin que `last_used_at` reste frais côté backend.
    const keepAliveTick = async () => {
      if (cancelled) return
      if (Date.now() - lastActivity < activeWindow()) {
        try {
          await refreshToken()
        } catch {
          // Échec transitoire (réseau) : on ignore. Une session réellement
          // invalide sera traitée par l'intercepteur 401 / le minuteur d'inactivité.
        }
      }
      if (!cancelled) scheduleKeepAlive()
    }

    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel']
    events.forEach(e => window.addEventListener(e, onActivity, { passive: true }))

    // 4. Une LECTURE MULTIMÉDIA en cours compte comme de l'activité : regarder un
    //    film ou écouter de la musique/radio sans toucher la souris ne doit pas
    //    verrouiller la session. Deux sources complémentaires :
    //    a) sondage des <audio>/<video> du DOM en lecture (couvre les lecteurs
    //       vidéo de n'importe quel module, sans aucun contrat) ;
    //    b) l'événement `kubuno:media-activity` (window), que les modules émettent
    //       périodiquement pour leurs lecteurs HORS DOM (éléments `new Audio()`,
    //       ex. lecteur musique/radio et console DJ de media) - contrat léger,
    //       aucun import croisé.
    window.addEventListener('kubuno:media-activity', onActivity)
    const mediaPoll = setInterval(() => {
      if (cancelled) return
      const playing = Array.from(document.querySelectorAll<HTMLMediaElement>('audio, video'))
        .some(m => !m.paused && !m.ended && m.readyState >= 2)
      if (playing) onActivity()
    }, 30_000)

    // Charger la durée configurée par l'admin (réglage public, clé `config`).
    getPublicConfig()
      .then(config => {
        if (cancelled) return
        const raw = config['security.session_idle_timeout_min']
        const min = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : 30
        idleMs = Number.isFinite(min) && min > 0 ? min * 60_000 : 0
        armLogout()
        // Recalcule la cadence du keepalive selon la fenêtre réellement configurée.
        scheduleKeepAlive()
      })
      .catch(() => armLogout())

    armLogout()
    scheduleKeepAlive()

    return () => {
      cancelled = true
      if (logoutTimer) clearTimeout(logoutTimer)
      if (keepAliveTimer) clearTimeout(keepAliveTimer)
      if (bc) { bc.onmessage = null; bc.close() }
      events.forEach(e => window.removeEventListener(e, onActivity))
      window.removeEventListener('kubuno:media-activity', onActivity)
      clearInterval(mediaPoll)
    }
  }, [user, logout, refreshToken])
}
