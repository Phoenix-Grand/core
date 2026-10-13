import { formatRelative, toDate } from '../intl/datetime'
// Widgets du core (moduleId 'core') — toujours disponibles sur le tableau de bord,
// indépendamment des modules installés. Enregistrés en side-effect (import dans main.tsx).
import { useEffect, useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import * as Avatar from '@radix-ui/react-avatar'
import {
  HardDrive, Activity, KeyRound, ArrowRight, ShieldCheck,
  Upload, Trash2, Move, Share2, FileText, Image as ImageIcon,
  Calendar, CheckSquare, Contact, Circle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { api } from '../api/client'
import type { ApiToken } from '../types'
import DashboardWidget from './DashboardWidget'
import { WidgetRegistry } from './WidgetRegistry'
import { useWidgetConfig } from './WidgetConfigContext'
import { ClockCanvas, FlipClockCanvas, CLOCK_FACES, type FaceExtras } from './clockFaces'
import { getPublicConfig } from '../api/publicConfig'

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

// ── Quota de stockage ───────────────────────────────────────────────────────
function QuotaWidget() {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  if (!user) return null
  const used = user.used_bytes
  const quota = user.quota_bytes || 1
  const pct = Math.min(100, Math.round((used / quota) * 100))
  const free = Math.max(0, quota - used)
  const danger = pct >= 90
  const color = danger ? 'var(--color-danger)' : pct >= 75 ? 'var(--color-warning)' : 'var(--color-primary)'

  return (
    <DashboardWidget title={t('widgets.quota_title')} icon={<HardDrive size={15} className="text-primary" />}>
      <div className="p-4">
        <div className="flex items-end justify-between mb-2">
          <span className="text-2xl font-semibold text-text-primary">{pct}%</span>
          <span className="text-xs text-text-tertiary">
            {t('widgets.quota_subtitle', { used: fmtBytes(used), total: fmtBytes(quota) })}
          </span>
        </div>
        <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
        </div>
        <p className="text-xs mt-2" style={{ color: danger ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>
          {danger ? t('widgets.quota_almost_full') : t('widgets.quota_free', { free: fmtBytes(free) })}
        </p>
      </div>
    </DashboardWidget>
  )
}

// ── Profil ────────────────────────────────────────────────────────────────────
function ProfileWidget() {
  const { t } = useTranslation()
  const user = useAuthStore(s => s.user)
  if (!user) return null
  const name = user.display_name || user.username
  const initials = (user.display_name || user.username || user.email).slice(0, 2).toUpperCase()
  const pct = Math.min(100, Math.round((user.used_bytes / (user.quota_bytes || 1)) * 100))

  return (
    <DashboardWidget title={name} icon={<ShieldCheck size={15} className="text-primary" />}>
      <div className="p-4 flex flex-col items-center text-center gap-2">
        <Avatar.Root className="w-16 h-16 rounded-full overflow-hidden bg-primary-light flex items-center justify-center">
          {user.avatar_url && <Avatar.Image src={user.avatar_url} className="w-full h-full object-cover" />}
          <Avatar.Fallback className="text-lg font-medium text-primary">{initials}</Avatar.Fallback>
        </Avatar.Root>
        <div>
          <p className="text-sm font-medium text-text-primary">{name}</p>
          <p className="text-xs text-text-tertiary">{user.email}</p>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full bg-surface-2 text-text-secondary">
          {t('admin.role_' + user.role, { defaultValue: user.role })}
        </span>
        <div className="w-full mt-1">
          <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <Link to="/settings" className="flex items-center gap-1 text-xs text-primary hover:underline mt-1">
          {t('widgets.profile_manage')} <ArrowRight size={11} />
        </Link>
      </div>
    </DashboardWidget>
  )
}

// ── Flux d'activité ─────────────────────────────────────────────────────────
interface ActivityEvent {
  id: number
  event_type: string
  source_module: string | null
  payload: Record<string, unknown>
  created_at: string
}

const EVENT_META: Record<string, { key: string; icon: LucideIcon; color: string }> = {
  FileUploaded:   { key: 'ev_file_uploaded',  icon: Upload,     color: 'text-green-500' },
  FileDeleted:    { key: 'ev_file_deleted',   icon: Trash2,     color: 'text-danger' },
  FileMoved:      { key: 'ev_file_moved',     icon: Move,       color: 'text-blue-500' },
  ShareCreated:   { key: 'ev_share_created',  icon: Share2,     color: 'text-primary' },
  ShareRevoked:   { key: 'ev_share_revoked',  icon: Share2,     color: 'text-text-tertiary' },
  NoteCreated:    { key: 'ev_note_created',   icon: FileText,   color: 'text-yellow-500' },
  PhotoImported:  { key: 'ev_photo_imported', icon: ImageIcon,  color: 'text-purple-500' },
  EventCreated:   { key: 'ev_event_created',  icon: Calendar,   color: 'text-blue-500' },
  TaskCompleted:  { key: 'ev_task_completed', icon: CheckSquare, color: 'text-green-500' },
  ContactUpdated: { key: 'ev_contact_updated', icon: Contact,   color: 'text-pink-500' },
}

function ActivityWidget() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({
    queryKey: ['widget-activity'],
    queryFn: () => api.get<{ events: ActivityEvent[] }>('/me/activity', { params: { limit: 12 } }).then(r => r.data.events),
    staleTime: 30_000,
  })
  const events = data ?? []

  return (
    <DashboardWidget title={t('widgets.activity_title')} icon={<Activity size={15} className="text-primary" />}>
      {isLoading ? (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary">{t('common.loading')}</div>
      ) : events.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-text-tertiary italic">{t('widgets.activity_empty')}</div>
      ) : (
        <ul className="divide-y divide-border">
          {events.map(ev => {
            const meta = EVENT_META[ev.event_type]
            const Icon = meta?.icon ?? Circle
            const label = meta ? t('widgets.' + meta.key) : t('widgets.ev_generic')
            return (
              <li key={ev.id} className="flex items-center gap-3 px-4 py-2.5">
                <Icon size={15} className={`shrink-0 ${meta?.color ?? 'text-text-tertiary'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary truncate">{label}</p>
                  <p className="text-xs text-text-tertiary">
                    {ev.source_module ? `${ev.source_module} · ` : ''}
                    {formatRelative(toDate(ev.created_at))}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </DashboardWidget>
  )
}

// ── Horloge ───────────────────────────────────────────────────────────────────
function ClockWidget() {
  const { i18n } = useTranslation()
  const cfg = useWidgetConfig({ style: 'digital', seconds: false, format24: true })
  const [now, setNow] = useState(() => new Date())

  // Mesure du cadre → l'horloge grandit/rétrécit avec la taille du widget.
  const bodyRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => {
      setBox({ w: e.contentRect.width, h: e.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // Tick every second when seconds are shown or in flip/analog mode, else every minute.
  const fast = cfg.seconds || cfg.style !== 'digital'
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), fast ? 1000 : 1000)
    return () => clearInterval(id)
  }, [fast])

  const lng = i18n.language
  const date = now.toLocaleDateString(lng, { weekday: 'long', day: 'numeric', month: 'long' })

  const h24 = now.getHours()
  const hour12 = h24 % 12 || 12
  const hh = String(cfg.format24 ? h24 : hour12).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  const ampm = cfg.format24 ? undefined : (h24 < 12 ? 'AM' : 'PM')
  const time = `${hh}:${mm}${cfg.seconds ? ':' + ss : ''}${ampm ? ' ' + ampm : ''}`

  const isFlip = cfg.style === 'flip'
  const face = CLOCK_FACES[cfg.style] ?? CLOCK_FACES.digital
  const bleed = face.chrome === 'bleed'

  // Card-chrome faces leave room for the date label below; bleed faces are square
  // and fill the whole frame (they embed their own date/branding).
  const canvasW = bleed ? Math.max(60, Math.min(box.w - 16, box.h - 16)) : Math.max(40, box.w - 20)
  const canvasH = bleed ? canvasW : Math.max(40, box.h - 34)

  const extras: FaceExtras = {
    time, hh, mm, ss, ampm, showSeconds: cfg.seconds,
    digital: `${hh}:${mm}`,
    day: String(now.getDate()).padStart(2, '0'),
    year: String(now.getFullYear()),
    month: now.toLocaleDateString('en', { month: 'short' }).toUpperCase(),
    weekday: now.toLocaleDateString('en', { weekday: 'short' }).toUpperCase(),
  }

  return (
    <div
      ref={bodyRef}
      className={`rounded-2xl overflow-hidden h-full flex flex-col items-center justify-center p-3 gap-1.5 ${
        bleed ? '' : 'bg-[var(--color-surface-card)] border-[3px] border-[var(--color-surface-card-border)]'
      }`}
      style={bleed ? { background: face.bg } : undefined}
    >
      <div className="flex-1 min-h-0 w-full flex items-center justify-center">
        {box.w > 0 && (isFlip
          ? <FlipClockCanvas width={canvasW} height={canvasH} hh={hh} mm={mm} ss={ss} showSeconds={cfg.seconds} ampm={ampm} />
          : <ClockCanvas draw={face.draw} width={canvasW} height={canvasH} date={now} extras={extras} />)}
      </div>
      {!bleed && <span className="text-xs text-text-secondary capitalize flex-shrink-0">{date}</span>}
    </div>
  )
}

// ── Tokens API / MCP ──────────────────────────────────────────────────────────
function TokensWidget() {
  const { t } = useTranslation()
  const { data: tokens } = useQuery({
    queryKey: ['widget-api-tokens'],
    queryFn: () => api.get<{ tokens: ApiToken[] }>('/me/api-tokens').then(r => r.data.tokens),
    staleTime: 60_000,
  })
  const { data: config } = useQuery({
    queryKey: ['public-config'],
    queryFn: getPublicConfig,
    staleTime: 300_000,
  })

  const now = Date.now()
  const active = (tokens ?? []).filter(tk => !tk.expires_at || new Date(tk.expires_at).getTime() > now)
  const mcpKnown = config && 'mcp.enabled' in config
  const mcpOn = Boolean(config?.['mcp.enabled'])

  return (
    <DashboardWidget
      title={t('widgets.tokens_title')}
      icon={<KeyRound size={15} className="text-primary" />}
      link="/settings?tab=api-tokens"
      linkLabel={t('widgets.tokens_manage')}
    >
      <div className="p-4 flex flex-col gap-3">
        <div>
          <span className="text-2xl font-semibold text-text-primary">{active.length}</span>
          <p className="text-xs text-text-tertiary mt-0.5">
            {active.length === 0 ? t('widgets.tokens_none') : t('widgets.tokens_active', { count: active.length })}
          </p>
        </div>
        {mcpKnown && (
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full ${mcpOn ? 'bg-success' : 'bg-text-tertiary'}`} />
            <span className="text-text-secondary">{mcpOn ? t('widgets.mcp_on') : t('widgets.mcp_off')}</span>
          </div>
        )}
      </div>
    </DashboardWidget>
  )
}

// ── Enregistrement ──────────────────────────────────────────────────────────
WidgetRegistry.register({
  id: 'core-profile', moduleId: 'core', Component: ProfileWidget, size: 'small', order: 1,
  title: 'widgets.name_profile', description: 'widgets.desc_profile', icon: 'UserCircle', accent: '#1a73e8',
})
WidgetRegistry.register({
  id: 'core-quota', moduleId: 'core', Component: QuotaWidget, size: 'small', order: 2,
  title: 'widgets.name_quota', description: 'widgets.desc_quota', icon: 'HardDrive', accent: '#1e8e3e',
})
WidgetRegistry.register({
  id: 'core-clock', moduleId: 'core', Component: ClockWidget, size: 'small', order: 3,
  title: 'widgets.name_clock', description: 'widgets.desc_clock', icon: 'Clock', accent: '#f9ab00',
  settings: [
    {
      key: 'style', type: 'select', label: 'widgets.set_clock_style', default: 'digital',
      options: [
        { value: 'digital',            label: 'widgets.set_clock_digital' },
        { value: 'flip',               label: 'widgets.set_clock_flip' },
        { value: 'analog',             label: 'widgets.set_clock_analog' },
        { value: 'style7',             label: 'widgets.set_clock_style7' },
        { value: 'roman_blue_gold',    label: 'widgets.set_clock_roman' },
        { value: 'gorgy',              label: 'widgets.set_clock_gorgy' },
        { value: 'style_seven_square', label: 'widgets.set_clock_seven_square' },
        { value: 'sapling',            label: 'widgets.set_clock_sapling' },
        { value: 'blue_round',         label: 'widgets.set_clock_blue_round' },
      ],
    },
    { key: 'seconds',  type: 'toggle', label: 'widgets.set_clock_seconds',  default: false },
    { key: 'format24', type: 'toggle', label: 'widgets.set_clock_24h',      default: true },
  ],
})
WidgetRegistry.register({
  id: 'core-tokens', moduleId: 'core', Component: TokensWidget, size: 'small', order: 4,
  title: 'widgets.name_tokens', description: 'widgets.desc_tokens', icon: 'KeyRound', accent: '#8430ce',
})
WidgetRegistry.register({
  id: 'core-activity', moduleId: 'core', Component: ActivityWidget, size: 'medium', order: 5,
  title: 'widgets.name_activity', description: 'widgets.desc_activity', icon: 'Activity', accent: '#d93025',
})
