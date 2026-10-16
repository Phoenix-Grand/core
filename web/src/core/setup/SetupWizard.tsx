// First-run installation wizard, in the spirit of WordPress and Nextcloud.
//
// It is the only screen a freshly installed instance serves: the core has no
// database yet, so every other API route answers 503 and the client is sent
// here. The wizard collects the database connection, the first administrator and
// the instance name, then hands over - the server writes its configuration,
// creates the schema and starts the real instance on the same port, with nothing
// to restart by hand.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import axios from 'axios'
import { Check, Database, KeyRound, User, Loader2, AlertTriangle, Image as ImageIcon, X } from 'lucide-react'
import { Button, OutlinedField } from '@ui'
import { ILLUSTRATIONS, illustrationSrc } from '../components/illustrations'
import { SetupWordmark } from './SetupWordmark'
import { LanguageMenu } from './LanguageMenu'
import { registerSetupI18n, SETUP_NS } from './i18n'
import { LANG_COOKIE, applyDir, SUPPORTED } from '../i18n'
import i18n from 'i18next'

interface SetupStatus {
  setup_required: boolean
  version: string
  missing: string[]
  config_path: string
  config_writable: boolean
  token_file: string
  defaults: { db_host: string; db_port: number; db_name: string; db_user: string }
}

interface ThemeChoice {
  id: string
  name: string
  color_scheme: string
  /** The theme's CSS variables, in full - applied live when it is picked. */
  vars: Record<string, string>
}

interface DbTest {
  ok: boolean
  error?: string
  code?: string
  params?: Record<string, unknown>
  server_version?: string
  database_missing: boolean
  can_create_database: boolean
  already_initialised: boolean
}

/** The flow. Every label is looked up in the `setup` namespace under the step's
 *  own key, so a step is described in one place and translated in another. */
const STEPS = ['welcome', 'database', 'admin', 'instance', 'install'] as const
type StepKey = (typeof STEPS)[number]

registerSetupI18n()

/** Paints the wizard with the picked theme, right away.
 *
 *  Choosing a theme has to be visible: an operator picking one on this screen is
 *  choosing what the instance will look like, and a card-sized swatch is not an
 *  answer. The theme's variables are set on the document root - the same
 *  mechanism the running shell uses - so the whole wizard (header, buttons,
 *  cards, illustration frame) turns with the selection and stays that way for
 *  the remaining steps.
 *
 *  Only the variables: a theme's component stylesheets need the running
 *  instance to serve them, and they are loaded once you are inside. */
const appliedThemeVars = new Set<string>()
function applyThemeVars(theme: ThemeChoice | null) {
  const root = document.documentElement
  for (const name of appliedThemeVars) root.style.removeProperty(name)
  appliedThemeVars.clear()
  if (!theme) {
    root.style.removeProperty('color-scheme')
    return
  }
  for (const [name, value] of Object.entries(theme.vars ?? {})) {
    root.style.setProperty(name, value)
    appliedThemeVars.add(name)
  }
  root.style.colorScheme = theme.color_scheme || 'light'
}

/** The theme the product falls back to everywhere else - so the picker opens on
 *  it rather than on nothing. */
const DEFAULT_THEME_ID = 'kubuno-reference'

/** The half-filled form, kept BY THE SERVER for the lifetime of this tab.
 *
 *  The browser holds nothing but an unguessable identifier: the form carries the
 *  installation token and two passwords, and browser storage is the wrong place
 *  for those. They live in the installer process's memory instead - never
 *  written to a disk, gone when the process ends, erased the moment the
 *  installation succeeds.
 *
 *  The identifier is per TAB (`sessionStorage`), so a refresh finds its own
 *  draft and a second tab starts its own installation. */
const DRAFT_ID_KEY = 'kubuno-setup-draft-id'

/** The installer opens in ENGLISH whatever the browser announces: this is a
 *  server being commissioned, not a personal page, and the operator states the
 *  instance's language on the first screen. */
const SETUP_LANG_KEY = 'kubuno-setup-lang'
function initialSetupLang(): string {
  const saved = localStorage.getItem(SETUP_LANG_KEY)
  return saved && SUPPORTED.includes(saved) ? saved : 'en'
}

interface Draft {
  token?: string
  dbHost?: string; dbPort?: string; dbName?: string; dbUser?: string; dbPassword?: string
  dbSchemaPrefix?: string
  dbTest?: DbTest | null; createDb?: boolean
  admUser?: string; admEmail?: string; admPassword?: string; admConfirm?: string
  instanceName?: string; themeId?: string | null; logoDataUrl?: string | null
  step?: string
}

/** 32 random bytes as hex.
 *
 *  `crypto.getRandomValues`, not `crypto.randomUUID`: the installer is reached
 *  over plain HTTP on a LAN address, which is not a secure context, and
 *  `randomUUID` simply does not exist there. */
function newDraftId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function draftId(): string {
  try {
    const existing = sessionStorage.getItem(DRAFT_ID_KEY)
    if (existing && /^[0-9a-f]{32,64}$/.test(existing)) return existing
    const fresh = newDraftId()
    sessionStorage.setItem(DRAFT_ID_KEY, fresh)
    return fresh
  } catch {
    return newDraftId()   // private mode: the draft simply will not survive
  }
}

export default function SetupWizard() {
  const { t } = useTranslation(SETUP_NS)
  const [lang, setLang] = useState(initialSetupLang)

  const [draftKey] = useState(draftId)
  const [hydrated, setHydrated] = useState(false)

  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  // The step lives in the URL, so a refresh - or a bookmark, or the browser's
  // Back button - lands where the operator was instead of at the beginning.
  const navigate = useNavigate()
  const { step: stepParam } = useParams<{ step?: string }>()
  const urlStep = Math.max(0, STEPS.indexOf((stepParam ?? 'welcome') as StepKey))
  const goToStep = (i: number) => {
    const clamped = Math.min(Math.max(i, 0), STEPS.length - 1)
    navigate(clamped === 0 ? '/setup' : `/setup/${STEPS[clamped]}`)
  }

  // Step 1 - proof that whoever is installing has access to the machine.
  const [token, setToken] = useState('')
  // Step 2 - database
  const [dbHost, setDbHost] = useState('localhost')
  const [dbPort, setDbPort] = useState('5432')
  const [dbName, setDbName] = useState('kubuno')
  const [dbUser, setDbUser] = useState('kubuno')
  const [dbPassword, setDbPassword] = useState('')
  // Optional: prefixes every schema name so several instances share one server.
  const [dbSchemaPrefix, setDbSchemaPrefix] = useState('')
  const [testing, setTesting] = useState(false)
  const [dbTest, setDbTest] = useState<DbTest | null>(null)
  const [createDb, setCreateDb] = useState(false)
  // Step 3 - first administrator
  const [admUser, setAdmUser] = useState('admin')
  const [admEmail, setAdmEmail] = useState('')
  const [admPassword, setAdmPassword] = useState('')
  const [admConfirm, setAdmConfirm] = useState('')
  // Step 4 - instance
  const [instanceName, setInstanceName] = useState('Kubuno')
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [themes, setThemes] = useState<ThemeChoice[]>([])
  const [themeId, setThemeId] = useState<string | null>(null)
  // Step 5 - installing
  const [installing, setInstalling] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [admExisted, setAdmExisted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // English on arrival, whatever the browser says - then whatever the operator
  // picks, which also becomes the instance's default language.
  useEffect(() => {
    void i18n.changeLanguage(lang)
    applyDir(lang)
    localStorage.setItem(SETUP_LANG_KEY, lang)
    document.cookie = `${LANG_COOKIE}=${lang}; path=/; max-age=31536000; SameSite=Lax`
  }, [lang])

  // Bring back what this tab had typed, before anything can overwrite it.
  useEffect(() => {
    axios
      .get<{ draft: Draft | null }>(`/api/v1/setup/draft/${draftKey}`)
      .then(r => {
        const d = r.data?.draft
        if (d) {
          if (d.token != null) setToken(d.token)
          if (d.dbHost) setDbHost(d.dbHost)
          if (d.dbPort) setDbPort(d.dbPort)
          if (d.dbName) setDbName(d.dbName)
          if (d.dbUser) setDbUser(d.dbUser)
          if (d.dbPassword != null) setDbPassword(d.dbPassword)
          if (d.dbSchemaPrefix != null) setDbSchemaPrefix(d.dbSchemaPrefix)
          if (d.dbTest !== undefined) setDbTest(d.dbTest)
          if (d.createDb != null) setCreateDb(d.createDb)
          if (d.admUser) setAdmUser(d.admUser)
          if (d.admEmail != null) setAdmEmail(d.admEmail)
          if (d.admPassword != null) setAdmPassword(d.admPassword)
          if (d.admConfirm != null) setAdmConfirm(d.admConfirm)
          if (d.instanceName) setInstanceName(d.instanceName)
          if (d.themeId !== undefined) setThemeId(d.themeId)
          if (d.logoDataUrl !== undefined) setLogoDataUrl(d.logoDataUrl)
        }
      })
      .catch(() => {/* no draft, or an installed instance: start clean */})
      .finally(() => setHydrated(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    axios
      .get<SetupStatus>('/api/v1/setup/status')
      .then(r => {
        // An installed instance answers `setup_required: false` - and an older
        // one has no such route at all, so the SPA's index.html comes back with
        // a 200. Anything that is not the expected object means "installed".
        if (typeof r.data !== 'object' || r.data === null || r.data.setup_required !== true) {
          setUnavailable(true)
          return
        }
        setStatus(r.data)
        setDbHost(r.data.defaults.db_host)
        setDbPort(String(r.data.defaults.db_port))
        setDbName(r.data.defaults.db_name)
        setDbUser(r.data.defaults.db_user)
      })
      .catch(() => setUnavailable(true))

    // The themes shipped with the instance, read off disk by the installer -
    // the very ones the administration console manages afterwards.
    axios
      .get<{ themes: ThemeChoice[] }>('/api/v1/setup/themes')
      .then(r => {
        const list = r.data.themes ?? []
        setThemes(list)
        // The reference theme IS the default appearance, so it starts selected:
        // leaving the picker empty showed one thing and would have recorded
        // another. Applying it too keeps the screen and the state in agreement.
        const initial = list.find(x => x.id === DEFAULT_THEME_ID) ?? list[0]
        if (initial) {
          setThemeId(initial.id)
          applyThemeVars(initial)
        }
      })
      .catch(() => setThemes([]))
  }, [])

  // Once the installation succeeded the wizard's server steps aside and the real
  // instance takes the port. Wait for it to answer, then go to the sign-in page.
  useEffect(() => {
    if (!installed) return
    const timer = setInterval(() => {
      axios
        .get('/api/v1/config')
        .then(() => window.location.replace('/login'))
        .catch(() => {/* still starting */})
    }, 1500)
    return () => clearInterval(timer)
  }, [installed])

  // Kept up to date as it is typed, so a refresh two steps later finds it.
  // Never before hydration: the first render holds defaults, and saving those
  // would erase the very draft we are about to restore.
  useEffect(() => {
    if (!hydrated || installed) return
    const body: Draft = {
      token, dbHost, dbPort, dbName, dbUser, dbPassword, dbSchemaPrefix, dbTest, createDb,
      admUser, admEmail, admPassword, admConfirm, instanceName, themeId, logoDataUrl,
    }
    // Debounced: this fires on every keystroke.
    const timer = setTimeout(() => {
      void axios.put(`/api/v1/setup/draft/${draftKey}`, body).catch(() => {/* best effort */})
    }, 400)
    return () => clearTimeout(timer)
  }, [hydrated, installed, draftKey, token, dbHost, dbPort, dbName, dbUser, dbPassword,
      dbSchemaPrefix, dbTest, createDb, admUser, admEmail, admPassword, admConfirm,
      instanceName, themeId, logoDataUrl])

  const passwordProblem = useMemo(() => {
    if (admPassword && admPassword.length < 12) return t('admin.tooShort')
    if (admConfirm && admPassword !== admConfirm) return t('admin.mismatch')
    return null
  }, [admPassword, admConfirm, t])

  /** The furthest step the current answers actually allow.
   *
   *  Matters on a refresh: the URL may name a step whose prerequisites are gone
   *  (the token and the passwords are deliberately not kept), and showing the
   *  administrator form to someone who has not proved anything would be a lie -
   *  Install would refuse at the end. So the wizard steps back to the last
   *  honest step and corrects the address. */
  const reachableStep = (): number => {
    for (let i = 0; i < STEPS.length - 1; i++) if (!canLeaveStep(i)) return i
    return STEPS.length - 1
  }

  const canLeaveStep = (i: number): boolean => {
    if (i === 0) return token.trim().length >= 8
    if (i === 1) return !!dbTest?.ok || (!!dbTest?.database_missing && createDb)
    if (i === 2)
      return (
        admUser.trim().length >= 3 &&
        admEmail.includes('@') &&
        admPassword.length >= 12 &&
        admPassword === admConfirm
      )
    return true
  }

  async function testDatabase() {
    setTesting(true)
    setDbTest(null)
    setError(null)
    try {
      const { data } = await axios.post<DbTest>('/api/v1/setup/test-database', {
        host: dbHost, port: Number(dbPort) || 5432, user: dbUser,
        password: dbPassword, database: dbName,
      })
      setDbTest(data)
      setCreateDb(data.database_missing && data.can_create_database)
    } catch (e) {
      setError(apiError(e, t))
    } finally {
      setTesting(false)
    }
  }

  async function install() {
    setInstalling(true)
    setError(null)
    try {
      const { data } = await axios.post<{ admin_existed?: boolean }>('/api/v1/setup/install', {
        token: token.trim(),
        create_database: createDb,
        database: {
          host: dbHost, port: Number(dbPort) || 5432, user: dbUser,
          password: dbPassword, database: dbName,
          schema_prefix: dbSchemaPrefix.trim() || undefined,
        },
        admin: { username: admUser.trim(), email: admEmail.trim(), password: admPassword },
        instance: {
          name: instanceName.trim(),
          logo_dataurl: logoDataUrl,
          theme_id: themeId,
          locale: lang,
        },
      })
      // Nothing left to come back to. The server clears its own store on a
      // successful install; this drops the tab's identifier with it.
      try { sessionStorage.removeItem(DRAFT_ID_KEY) } catch { /* private mode */ }
      setAdmExisted(Boolean(data?.admin_existed))
      setInstalled(true)
    } catch (e) {
      setError(apiError(e, t))
      setInstalling(false)
    }
  }

  // The address is corrected rather than left lying: after a refresh the bar
  // must say where you really are.
  useEffect(() => {
    // Not before the draft is back: on the first render every field is empty,
    // and judging the step then would send a restored installation back to the
    // welcome screen - exactly what the draft exists to prevent.
    if (!status || !hydrated || installed) return
    const allowed = Math.min(urlStep, reachableStep())
    if (allowed !== urlStep) {
      navigate(allowed === 0 ? '/setup' : `/setup/${STEPS[allowed]}`, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlStep, status, hydrated, installed, token, dbTest, createDb, admUser, admEmail, admPassword, admConfirm])

  const langMenu = <LanguageMenu value={lang} onChange={setLang} />

  if (unavailable) {
    return (
      <Shell trailing={langMenu} version={status?.version}>
        <div style={{ maxWidth: 460 }}>
          <h1 className="m-0 mb-3 text-3xl font-normal tracking-tight">{t('installed.title')}</h1>
          <p className="m-0 mb-7 text-[15px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {t('installed.text')}
          </p>
          <Pill onClick={() => window.location.replace('/login')}>{t('installed.signIn')}</Pill>
        </div>
      </Shell>
    )
  }

  if (!status || !hydrated) {
    return (
      <Shell trailing={langMenu}>
        <Loader2 size={26} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
      </Shell>
    )
  }

  const step = hydrated ? Math.min(urlStep, reachableStep()) : urlStep
  const key: StepKey = STEPS[step]

  if (installed) {
    return (
      <Shell navLabel={t('nav.done')} progress={1} trailing={langMenu} version={status.version}>
        <div style={{ maxWidth: 620, width: '100%' }}>
          <h1 className="m-0 mb-7 text-[34px] font-normal tracking-tight">{t('done.title')}</h1>
          <div className="rounded-2xl px-7 pb-7 pt-2"
               style={{ background: 'var(--color-surface-0)', border: '1px solid var(--color-border)' }}>
            <Done title={t('done.dbReady', { name: dbName })} text={t('done.dbReadyText')} />
            <Done
              title={admExisted ? t('done.adminKept') : t('done.adminCreated', { name: admUser })}
              text={admExisted ? t('done.adminKeptText') : t('done.adminCreatedText')}
            />
            <Done title={t('done.configSaved')} text={status.config_path} last />
            <div className="mt-6 flex justify-end">
              <Pill onClick={() => window.location.replace('/login')}>
                {t('done.explore', { name: instanceName || 'Kubuno' })}
              </Pill>
            </div>
          </div>
          <p className="mt-5 flex items-center gap-2 text-[13.5px]" style={{ color: 'var(--color-text-secondary)' }}>
            <Loader2 size={15} className="animate-spin" /> {t('done.starting')}
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell navLabel={t(`nav.${key}`)} progress={(step + 1) / STEPS.length} trailing={langMenu}
           version={status.version}>
      <div className="flex w-full flex-wrap items-start justify-center gap-x-[72px] gap-y-10">
        {/* ── The questions ── */}
        <section style={{ flex: '1 1 440px', maxWidth: 520 }}>
          <h1 className="m-0 mb-2 text-[34px] font-normal tracking-tight">{t(`${key}.title`)}</h1>
          <p className="m-0 mb-7 text-[15px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {t(`${key}.lead`)}
          </p>

          {!status.config_writable && (
            <Notice tone="warn">
              <Trans t={t} i18nKey="configNotWritable"
                     values={{ path: status.config_path, cmd: `chown kubuno:kubuno ${status.config_path}` }}
                     components={{ 1: <strong /> }} />
            </Notice>
          )}

          <div className="flex flex-col gap-4">
            {key === 'welcome' && (
              <>
                <Notice tone="info">
                  <Trans t={t} i18nKey="welcome.tokenHelp"
                         values={{ file: status.token_file, cmd: 'journalctl -u kubuno -n 40' }}
                         components={{ 1: <strong /> }} />
                </Notice>
                <OutlinedField label={t('welcome.tokenLabel')} value={token} onChange={setToken}
                               icon={<KeyRound size={24} strokeWidth={1.8} />}
                               primaryColor="var(--color-primary)" autoFocus />
              </>
            )}

            {key === 'database' && (
              <>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <OutlinedField label={t('database.host')} value={dbHost} onChange={setDbHost}
                                   icon={<Database size={24} strokeWidth={1.8} />} primaryColor="var(--color-primary)" />
                  </div>
                  <div style={{ width: 120 }}>
                    <OutlinedField label={t('database.port')} value={dbPort} onChange={setDbPort}
                                   inputMode="numeric" primaryColor="var(--color-primary)" />
                  </div>
                </div>
                <OutlinedField label={t('database.name')} value={dbName} onChange={setDbName} primaryColor="var(--color-primary)" />
                <OutlinedField label={t('database.user')} value={dbUser} onChange={setDbUser} primaryColor="var(--color-primary)" />
                <OutlinedField label={t('database.password')} value={dbPassword} onChange={setDbPassword}
                               type="password" primaryColor="var(--color-primary)" />
                <div>
                  <OutlinedField label={t('database.schemaPrefix')} value={dbSchemaPrefix}
                                 onChange={setDbSchemaPrefix} primaryColor="var(--color-primary)" />
                  <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{t('database.schemaPrefixHint')}</p>
                </div>
                <div className="flex items-center gap-3.5">
                  <Pill tone="ghost" onClick={testDatabase} disabled={testing}>
                    {testing ? t('actions.testing') : t('actions.test')}
                  </Pill>
                  {dbTest?.ok && (
                    <span className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--color-success, #1e8e3e)' }}>
                      <Check size={16} /> {t('database.connected')}
                    </span>
                  )}
                </div>
                {dbTest?.ok && dbTest.server_version && <Notice tone="ok">{dbTest.server_version.split(',')[0]}</Notice>}
                {dbTest?.ok && dbTest.already_initialised && <Notice tone="warn">{t('database.alreadyInitialised')}</Notice>}
                {dbTest && !dbTest.ok && dbTest.database_missing && (
                  <Notice tone={dbTest.can_create_database ? 'info' : 'warn'}>
                    {translateFailure(dbTest, t)}{' '}
                    {dbTest.can_create_database ? (
                      <label className="mt-2 flex items-center gap-2">
                        <input type="checkbox" checked={createDb} onChange={e => setCreateDb(e.target.checked)} />
                        {t('database.createIt')}
                      </label>
                    ) : (
                      t('database.createHint', { cmd: `createdb -O ${dbUser} ${dbName}` })
                    )}
                  </Notice>
                )}
                {dbTest && !dbTest.ok && !dbTest.database_missing && <Notice tone="error">{translateFailure(dbTest, t)}</Notice>}
              </>
            )}

            {key === 'admin' && (
              <>
                <OutlinedField label={t('admin.username')} value={admUser} onChange={setAdmUser}
                               icon={<User size={24} strokeWidth={1.8} />} primaryColor="var(--color-primary)" />
                <OutlinedField label={t('admin.email')} value={admEmail} onChange={setAdmEmail}
                               type="email" primaryColor="var(--color-primary)" />
                <OutlinedField label={t('admin.password')} value={admPassword} onChange={setAdmPassword}
                               type="password" primaryColor="var(--color-primary)" />
                <OutlinedField label={t('admin.confirm')} value={admConfirm} onChange={setAdmConfirm}
                               type="password" primaryColor="var(--color-primary)" />
                {passwordProblem && <Notice tone="warn">{passwordProblem}</Notice>}
              </>
            )}

            {key === 'instance' && (
              <>
                <OutlinedField label={t('instance.name')} value={instanceName} onChange={setInstanceName}
                               primaryColor="var(--color-primary)" />
                <LogoField value={logoDataUrl} onChange={setLogoDataUrl}
                           error={logoError} onError={setLogoError} t={t} />
                {themes.length > 0 && (
                  <ThemeField
                    themes={themes}
                    value={themeId}
                    onChange={id => {
                      setThemeId(id)
                      applyThemeVars(themes.find(x => x.id === id) ?? null)
                    }}
                    t={t}
                  />
                )}
                <p className="m-0 text-[12.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {t('instance.footnote')}
                </p>
              </>
            )}

            {key === 'install' && (
              <>
                <Summary rows={[
                  [t('install.summaryDb'), `${dbUser}@${dbHost}:${dbPort}/${dbName}${createDb ? ` (${t('install.toCreate')})` : ''}`],
                  [t('install.summaryAdmin'), `${admUser} - ${admEmail}`],
                  [t('install.summaryInstance'), instanceName],
                  [t('install.summaryConfig'), status.config_path],
                ]} />
                {installing && (
                  <div className="flex items-center gap-2.5" style={{ color: 'var(--color-text-secondary)' }}>
                    <Loader2 size={18} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
                    {t('install.working')}
                  </div>
                )}
              </>
            )}

            {error && <Notice tone="error">{error}</Notice>}
          </div>

          <div className="mt-8 flex items-center gap-2">
            {step < STEPS.length - 1 ? (
              <Pill onClick={() => goToStep(step + 1)} disabled={!canLeaveStep(step)}>{t('actions.next')}</Pill>
            ) : (
              <Pill onClick={install} disabled={installing}>{t('actions.install')}</Pill>
            )}
            {step > 0 && (
              <Pill tone="text" onClick={() => goToStep(step - 1)} disabled={installing}>
                {t('actions.back')}
              </Pill>
            )}
          </div>
        </section>

        {/* ── What the step is FOR, not decoration ── */}
        <aside className="pt-2 text-center" style={{ flex: '0 1 380px', maxWidth: 420 }}>
          <Illustration key={key} stepKey={key} />
          <h2 className="mb-3 mt-7 text-2xl font-normal tracking-tight">{t(`${key}.pitchTitle`)}</h2>
          <p className="m-0 text-[14.5px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            {t(`${key}.pitch`)}
          </p>
        </aside>
      </div>
    </Shell>
  )
}

/** The refusal an installer endpoint sent back, said in the language on screen.
 *
 *  The server names the reason with a stable code because it cannot know which
 *  language this screen is in. An unknown code (an older server, a case added
 *  later) falls back to the sentence the server sent rather than to nothing. */
function translateFailure(
  payload: { error?: string; code?: string; params?: Record<string, unknown> } | undefined,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  const code = payload?.code
  if (code) {
    const key = `errors.${code}`
    const said = t(key, { ...(payload?.params ?? {}) })
    if (said !== key) return said
  }
  return payload?.error ?? t('errors.generic')
}

function apiError(e: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (axios.isAxiosError(e)) {
    if (!e.response) return t('errors.unreachable')
    return translateFailure(e.response.data as Parameters<typeof translateFailure>[0], t)
  }
  return t('errors.generic')
}

// ── Presentation ─────────────────────────────────────────────────────────────
// The shape the big cloud suites use for their setup flows: a slim bar carrying
// the product mark and the step, a progress rule under it, then one screen per
// question - the form on one side, what the step is FOR on the other.

function Shell({ children, navLabel, progress, trailing, version }: {
  children: React.ReactNode; navLabel?: string; progress?: number
  trailing?: React.ReactNode; version?: string
}) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column',
                  background: 'var(--color-surface-1, #f8f9fa)' }}>
      <header style={{ background: 'var(--color-surface-0, #fff)', position: 'relative',
                       display: 'flex', alignItems: 'center', justifyContent: 'center',
                       height: 64, padding: '0 24px', flexShrink: 0 }}>
        {navLabel && (
          <span style={{ position: 'absolute', insetInlineStart: 24, fontSize: 19,
                         color: 'var(--color-text-primary)' }}>
            {navLabel}
          </span>
        )}
        <SetupWordmark height={26} />
        {/* The language choice sits in the bar, reachable from the first screen
            to the last - it is a decision about the instance, not a preference
            buried in a menu. */}
        {trailing && <span className="absolute" style={{ insetInlineEnd: 24 }}>{trailing}</span>}
      </header>
      {/* Progress rule: the whole flow at a glance, without a numbered stepper
          that would claim more room than it earns. */}
      <div style={{ height: 4, background: 'var(--color-border, #dadce0)', flexShrink: 0 }}>
        <div style={{ height: '100%', width: `${Math.round((progress ?? 0) * 100)}%`,
                      marginInlineStart: 0, background: 'var(--color-primary)',
                      transition: 'width 320ms ease' }} />
      </div>
      <main style={{ flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                     padding: '56px 32px 40px' }}>
        <div style={{ width: '100%', maxWidth: 1040, display: 'flex', justifyContent: 'center' }}>
          {children}
        </div>
      </main>
      <SetupFooter version={version} />
    </div>
  )
}

/** Who made this, and under which licence.
 *
 *  On the one screen shown before anything else exists, saying it plainly is
 *  worth more than a discreet mark: whoever is installing is deciding whether to
 *  trust the software with their data. */
function SetupFooter({ version }: { version?: string }) {
  const { t } = useTranslation(SETUP_NS)
  return (
    <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 px-8 pb-8 text-center text-xs"
            style={{ color: 'var(--color-text-tertiary)' }}>
      <span>
        <Trans
          t={t}
          i18nKey="footer.poweredBy"
          values={{ brand: 'Martinien OLINGA' }}
          components={{
            1: (
              <a href="https://toiledev.com" target="_blank" rel="noreferrer noopener"
                 style={{ color: 'var(--color-text-secondary)', textDecoration: 'none' }} />
            ),
          }}
        />
      </span>
      <span aria-hidden>·</span>
      <span dir="ltr">Kubuno{version ? ` ${version}` : ''}</span>
      <span aria-hidden>·</span>
      <span>{t('footer.license')}</span>
    </footer>
  )
}

/** The rounded action button of the flow. `ghost` outlines it, `text` drops the
 *  frame - the hierarchy the reference screens use between Next / Test / Back. */
function Pill({ children, onClick, disabled, tone = 'primary' }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean
  tone?: 'primary' | 'ghost' | 'text'
}) {
  return (
    <Button
      variant={tone === 'primary' ? 'primary' : tone === 'ghost' ? 'secondary' : 'ghost'}
      onClick={onClick}
      disabled={disabled}
      className="!rounded-full !px-6 !h-10"
    >
      {children}
    </Button>
  )
}

/** One thing that now exists, on the closing screen. */
function Done({ title, text, last }: { title: string; text: string; last?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 14, paddingTop: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Check size={20} style={{ color: '#1e8e3e', flexShrink: 0 }} />
        {!last && <div style={{ flex: 1, width: 1, background: 'var(--color-border, #dadce0)', marginTop: 6 }} />}
      </div>
      <div style={{ paddingBottom: last ? 0 : 4 }}>
        <p style={{ margin: 0, fontWeight: 500 }}>{title}</p>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: 13.5,
                    lineHeight: 1.55, wordBreak: 'break-all' }}>{text}</p>
      </div>
    </div>
  )
}

/** The flow's illustration, served by the core itself out of `frontend/public/` -
 *  at this point in the life of an instance nothing else can serve anything.
 *
 *  Three sources are tried in turn, so artwork can be added without touching
 *  this file: the step's own picture (`setup-<step>.png`), the one shared by the
 *  whole flow (`setup-hero.png`), and finally the artwork the app draws itself.
 *  A step with no picture of its own therefore shows the shared one rather than
 *  a broken image. */
function sources(stepKey: string): string[] {
  return [`/setup-${stepKey}.png`, '/setup-hero.png', houseArt()]
}

function Illustration({ stepKey }: { stepKey: string }) {
  const [tried, setTried] = useState(0)
  const candidates = sources(stepKey)
  return (
    <img
      src={candidates[Math.min(tried, candidates.length - 1)]}
      onError={() => setTried(t => t + 1)}
      alt=""
      style={{ width: '100%', maxWidth: 340, borderRadius: 20 }}
    />
  )
}

/** Last resort: artwork the app draws itself - no image bank, no network. */
function houseArt(): string {
  const ill = ILLUSTRATIONS.find(i => i.id === 'arcs-azur') ?? ILLUSTRATIONS[0]
  return illustrationSrc(ill.svg)
}

/** Optional logo. A drop zone rather than a file button: it is the gesture
 *  people expect for a picture, and it leaves room to show the result at the
 *  size it will actually be used.
 *
 *  Stored as a data-URI in `instance.logo_url` - the key the shell already
 *  reads - because no upload endpoint can exist before the instance does. */
function LogoField({ value, onChange, error, onError, t }: {
  value: string | null; onChange: (v: string | null) => void
  error: string | null; onError: (v: string | null) => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  const [over, setOver] = useState(false)
  const MAX = 200 * 1024
  const ACCEPTED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])

  const take = (f?: File | null) => {
    onError(null)
    if (!f) return
    if (!ACCEPTED.has(f.type)) { onError(t('instance.logoTypes')); return }
    if (f.size > MAX) { onError(t('instance.logoTooBig')); return }
    const r = new FileReader()
    r.onload = () => onChange(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => onError(t('instance.logoUnreadable'))
    r.readAsDataURL(f)
  }

  return (
    <div>
      <FieldLabel>{t('instance.logo')}</FieldLabel>
      <label
        onDragOver={e => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]) }}
        className="flex cursor-pointer items-center gap-4 rounded-xl border border-dashed p-4 transition-colors"
        style={{
          borderColor: over ? 'var(--color-primary)' : 'var(--color-border)',
          background: over ? 'var(--color-primary-light)' : 'var(--color-surface-0)',
        }}
      >
        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg"
             style={{ background: 'var(--color-surface-1)' }}>
          {value
            ? <img src={value} alt="" className="h-full w-full object-contain" />
            : <ImageIcon size={22} style={{ color: 'var(--color-text-tertiary)' }} />}
        </div>
        <div className="min-w-0">
          <p className="m-0 text-sm" style={{ color: 'var(--color-text-primary)' }}>
            {value ? t('instance.logoChosen') : t('instance.logoDrop')}
          </p>
          <p className="m-0 mt-1 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            {t('instance.logoHint')}
          </p>
        </div>
        {value && (
          <button type="button" className="ml-auto flex items-center gap-1.5 text-sm"
                  style={{ background: 'none', border: 0, color: 'var(--color-text-secondary)', cursor: 'pointer' }}
                  onClick={e => { e.preventDefault(); onChange(null); onError(null) }}>
            <X size={14} /> {t('instance.remove')}
          </button>
        )}
        <input type="file" className="hidden"
               accept="image/png,image/jpeg,image/webp,image/svg+xml"
               onChange={e => take(e.target.files?.[0])} />
      </label>
      {error && <p className="mt-2 text-sm" style={{ color: 'var(--color-danger, #a50e0e)' }}>{error}</p>}
    </div>
  )
}

/** The themes shipped with the instance - the same ones the administration
 *  console offers later, not an invented palette. Each card is drawn with that
 *  theme's OWN variables, so what is on the card is what the instance will look
 *  like. */
function ThemeField({ themes, value, onChange, t }: {
  themes: ThemeChoice[]; value: string | null; onChange: (id: string) => void
  t: (k: string, o?: Record<string, unknown>) => string
}) {
  return (
    <div>
      <FieldLabel>{t('instance.theme')}</FieldLabel>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))' }}>
        {themes.map(th => {
          const v = th.vars ?? {}
          const active = th.id === value
          const surface = v['--color-surface-0'] ?? '#ffffff'
          const panel = v['--color-surface-1'] ?? '#f8f9fa'
          const primary = v['--color-primary'] ?? '#1a73e8'
          const ink = v['--color-text-primary'] ?? '#202124'
          const line = v['--color-border'] ?? '#dadce0'
          return (
            <button key={th.id} type="button" onClick={() => onChange(th.id)} aria-pressed={active}
                    className="overflow-hidden rounded-xl p-0 text-left transition-shadow"
                    style={{ border: `2px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                             background: 'var(--color-surface-0)', cursor: 'pointer' }}>
              {/* Miniature of the shell: rail, header, content - painted with the
                  theme's own colours. */}
              <div className="flex h-20" style={{ background: surface }} aria-hidden>
                <div className="h-full w-1/4" style={{ background: panel, borderRight: `1px solid ${line}` }}>
                  <div className="mx-1.5 mt-1.5 h-1.5 rounded" style={{ background: primary }} />
                  <div className="mx-1.5 mt-1.5 h-1 rounded" style={{ background: line }} />
                  <div className="mx-1.5 mt-1 h-1 rounded" style={{ background: line }} />
                </div>
                <div className="flex-1">
                  <div className="h-4 w-full" style={{ background: primary }} />
                  <div className="mx-2 mt-2 h-1.5 w-2/3 rounded" style={{ background: ink, opacity: .75 }} />
                  <div className="mx-2 mt-1.5 h-1 w-1/2 rounded" style={{ background: line }} />
                  <div className="mx-2 mt-1 h-1 w-3/5 rounded" style={{ background: line }} />
                </div>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-2">
                <span className="truncate text-sm" style={{ color: 'var(--color-text-primary)' }}>{th.name}</span>
                {active && <Check size={14} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />}
                <span className="ml-auto text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>
                  {th.color_scheme === 'dark' ? t('instance.dark') : t('instance.light')}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The small grey caption above an optional field. */
/** Caption of an optional field - every field carrying one is optional. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation(SETUP_NS)
  return (
    <p className="m-0 mb-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
      {children} <span style={{ color: 'var(--color-text-tertiary)' }}>· {t('instance.optional')}</span>
    </p>
  )
}

function Notice({ tone, children }: { tone: 'info' | 'ok' | 'warn' | 'error'; children: React.ReactNode }) {
  const palette = {
    info:  { bg: '#e8f0fe', fg: '#174ea6' },
    ok:    { bg: '#e6f4ea', fg: '#1e6b32' },
    warn:  { bg: '#fef7e0', fg: '#8a6100' },
    error: { bg: '#fce8e6', fg: '#a50e0e' },
  }[tone]
  return (
    <div style={{ background: palette.bg, color: palette.fg, borderRadius: 12, padding: '14px 16px',
                  fontSize: 13.5, lineHeight: 1.6, display: 'flex', gap: 10, marginBottom: 4 }}>
      {tone === 'warn' || tone === 'error' ? (
        <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 1 }} />
      ) : null}
      <div>{children}</div>
    </div>
  )
}

function Summary({ rows }: { rows: [string, string][] }) {
  return (
    <dl style={{ margin: 0, background: 'var(--color-surface-0, #fff)',
                 border: '1px solid var(--color-border, #dadce0)', borderRadius: 14, padding: 20,
                 display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '10px 20px', fontSize: 14 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--color-text-secondary)' }}>{k}</dt>
          <dd style={{ margin: 0, wordBreak: 'break-all' }}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
