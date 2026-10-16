import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { pickImageFile } from '../store/imagePickerStore'
import { useLocation } from 'react-router-dom'
import { Search, X, Camera, Mic } from 'lucide-react'
import { useSearchStore, resolveSearchConfig } from '../store/searchStore'
import { useVoiceDictation } from './useVoiceDictation'
import { themed } from '@ui'

function DefaultFilterPanel({ onClose, dark = false }: { onClose: () => void; dark?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="p-4 text-center">
      <p className={`text-sm ${dark ? 'text-white/50' : 'text-text-tertiary'}`}>{t('shell.no_filter')}</p>
      <button onClick={onClose} className="mt-3 text-xs text-primary hover:underline">{t('common.close')}</button>
    </div>
  )
}

function TuneIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6"  x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="8"  cy="6"  r="2" fill="white" />
      <circle cx="16" cy="12" r="2" fill="white" />
      <circle cx="10" cy="18" r="2" fill="white" />
    </svg>
  )
}

// `dark` : variante sombre pour les topbars PaintSharp (#111). `compact` : hauteur réduite
// (h-9 au lieu de h-12) pour tenir dans une topbar de 40px. Défauts = barre claire de
// l'AppHeader, strictement inchangée.
function SearchBarBase({ dark = false, compact = false }: { dark?: boolean; compact?: boolean }) {
  const { t } = useTranslation()
  const { configs } = useSearchStore()
  const { pathname } = useLocation()
  const [filterOpen, setFilterOpen] = useState(false)
  const [focused,    setFocused]    = useState(false)
  // The query lives in the store so modules can seed it (URL-restored searches).
  const query    = useSearchStore(s => s.query)
  const setQuery = useSearchStore(s => s.setQuery)
  const containerRef  = useRef<HTMLDivElement>(null)
  const inputRef      = useRef<HTMLInputElement>(null)

  const config = resolveSearchConfig(configs, pathname)

  const handleChange = (value: string) => {
    setQuery(value)
    config?.onSearch?.(value)
  }

  // Voice dictation (shared hook): live transcript fills the search field.
  const voice = useVoiceDictation({ getSeed: () => '', onText: handleChange })

  // Clear the field when switching between modules - but not on the initial
  // mount, so a query seeded from the URL (F5-restored search) survives. A
  // module keeps ownership of its query while its own routes stay active.
  const prevModuleRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    const prev = prevModuleRef.current
    prevModuleRef.current = config?.moduleId
    if (prev === undefined || prev === config?.moduleId) return
    setQuery('')
    setFilterOpen(false)
    config?.onSearch?.('')
  }, [config?.moduleId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!filterOpen && !voice.listening) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
        voice.stop()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [filterOpen, voice.listening]) // eslint-disable-line react-hooks/exhaustive-deps

  /* Un module peut remplacer tout le composant, mais PAS la taille du champ : sa sortie
   * est enveloppée dans `.kb-search`, dont la règle CSS (index.css, non-layered) impose
   * la taille au champ et à ses calques superposés. Un `text-*` posé par un module y
   * perdrait de toute façon, les utilitaires vivant dans une couche de cascade. */
  if (config?.SearchComponent) return (
    <div className="kb-search contents"><config.SearchComponent /></div>
  )

  const placeholder = config?.placeholderKey
    ? t(config.placeholderKey)
    : (config?.placeholder ?? t('header.search_placeholder'))
  const CustomFilterPanel = config?.FilterPanel
  const isActive          = focused || filterOpen

  const rowH   = compact ? 'h-9' : 'h-12'
  const ico    = compact ? 16 : 20
  const fltBtn = compact ? 'w-8 h-8' : 'w-10 h-10'

  /* Contenu de la ligne de recherche - identique dans les deux états */
  const searchRow = (
    <div className={`flex items-center ${rowH} flex-shrink-0`}>
      <div className={`${compact ? 'pl-3 pr-2' : 'pl-4 pr-2'} flex-shrink-0`}>
        <Search size={ico} className={dark ? 'text-white/60' : 'text-text-secondary'} />
      </div>

      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder={placeholder}
        onChange={e => handleChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className={`flex-1 bg-transparent outline-none min-w-0 ${
          dark ? 'text-white placeholder:text-white/40' : 'text-text-primary placeholder:text-text-tertiary'}`}
      />

      {query && (
        <button
          onMouseDown={e => { e.preventDefault(); handleChange('') }}
          className={`flex-shrink-0 px-1 ${dark ? 'text-white/50 hover:text-white' : 'text-text-tertiary hover:text-text-primary'}`}
          aria-label={t('shell.clear')}
        >
          <X size={16} />
        </button>
      )}

      <div className="flex items-center flex-shrink-0 pr-2">
        {/* Bouton micro - recherche vocale auto-hébergée (Vosk/Whisper), présent
            par défaut sur tous les navigateurs. Masqué si l'admin a désactivé la
            reconnaissance vocale ou si le module stt est absent. */}
        {voice.enabled && (
          <button
            onClick={voice.toggleVoice}
            aria-label={t('shell.search_by_voice', { defaultValue: 'Recherche vocale' })}
            title={t('shell.search_by_voice', { defaultValue: 'Recherche vocale' })}
            className={`${fltBtn} flex items-center justify-center rounded-full transition-colors
              ${(voice.listening || voice.voiceLoading)
                ? 'text-red-500 bg-red-500/10'
                : (dark ? 'text-white/60 hover:bg-white/10' : 'text-text-secondary hover:bg-[#e8f0fe]')}`}
          >
            <Mic size={ico} className={voice.listening ? 'animate-pulse' : ''} />
          </button>
        )}
        {config?.onImageSearch && (
          <>
            <button
              onClick={() => { void pickImageFile({ title: t('shell.search_by_image', { defaultValue: 'Rechercher des images similaires' }) })
                .then(f => { if (f) config.onImageSearch!(f) }) }}
              aria-label={t('shell.search_by_image', { defaultValue: 'Rechercher des images similaires' })}
              title={t('shell.search_by_image', { defaultValue: 'Rechercher des images similaires' })}
              className={`${fltBtn} flex items-center justify-center rounded-full transition-colors
                ${dark ? 'text-white/60 hover:bg-white/10' : 'text-text-secondary hover:bg-[#e8f0fe]'}`}
            >
              <Camera size={ico} />
            </button>
          </>
        )}
        <div className={`w-px ${compact ? 'h-5' : 'h-6'} mx-2 flex-shrink-0 ${dark ? 'bg-white/15' : 'bg-border'}`} />
        <button
          onClick={() => setFilterOpen(v => !v)}
          aria-label={t('shell.search_options')}
          className={`${fltBtn} flex items-center justify-center rounded-full transition-colors
            ${filterOpen
              ? (dark ? 'bg-white/15 text-white' : 'bg-primary-light text-primary')
              : (dark ? 'text-white/60 hover:bg-white/10' : 'text-text-secondary hover:bg-[#e8f0fe]')}`}
        >
          {filterOpen ? <X size={ico} /> : <TuneIcon size={ico} />}
        </button>
      </div>
    </div>
  )

  return (
    <div ref={containerRef} className="kb-search relative w-full">

      {/* Toast d'écoute vocale - centré à l'écran, fourni par le hook partagé.
          Rendu DANS containerRef pour que le clic dessus ne compte pas comme un
          clic « extérieur » (qui arrête la dictée). */}
      {voice.voiceToast}

      {filterOpen ? (
        <>
          {/*
           * Spacer invisible - maintient la hauteur du header pendant que
           * le bloc unifié est en position absolute.
           */}
          <div className={rowH} aria-hidden />

          {/*
           * Bloc unique contenant TOUT : ligne de recherche + séparateur + filtre.
           * Un seul border, un seul border-radius, une seule ombre.
           * Il s'étend librement vers le bas par-dessus le contenu de la page.
           */}
          <div
            className="absolute left-0 right-0 top-0 z-[70]"
            style={{
              background:   dark ? '#1c1c1e' : '#ffffff',
              border:       dark ? '1px solid rgba(255,255,255,0.12)' : '1px solid #e0e0e0',
              borderRadius: compact ? 18 : 24,
              boxShadow:    '0 4px 20px rgba(0,0,0,0.16)',
              overflow:     'hidden',
            }}
          >
            {searchRow}
            <div style={{ height: 1, background: dark ? 'rgba(255,255,255,0.12)' : 'var(--color-border)', margin: '0 16px' }} />
            {CustomFilterPanel
              ? <CustomFilterPanel onClose={() => setFilterOpen(false)} />
              : <DefaultFilterPanel onClose={() => setFilterOpen(false)} dark={dark} />}
          </div>
        </>
      ) : (
        /* Pill normale quand le filtre est fermé */
        <div
          className="transition-all"
          style={{
            background:   dark
              ? (isActive ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.07)')
              : (isActive ? '#ffffff' : 'var(--color-search-bg)'),
            boxShadow:    isActive && !dark
              ? '0 1px 3px rgba(0,0,0,0.2), 0 2px 6px rgba(0,0,0,0.1)'
              : 'none',
            border:       dark
              ? `1px solid ${isActive ? 'rgba(255,255,255,0.2)' : 'transparent'}`
              : `1px solid ${isActive ? '#e0e0e0' : 'transparent'}`,
            borderRadius: '9999px',
          }}
        >
          {searchRow}
        </div>
      )}
    </div>
  )
}

// Themeable core shell object: a theme can override the global search bar.
export default themed('shell.search', SearchBarBase)
