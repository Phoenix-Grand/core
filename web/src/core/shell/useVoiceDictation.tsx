// Reusable voice-dictation hook + centered toast UI, shared by the core search
// bar and by modules (e.g. Assistant) through @kubuno/sdk. It streams mic audio to
// the self-hosted STT backend and renders a centered, EDITABLE toast:
//   • the transcript appears in a textarea the user can edit at any time;
//   • dictated words are inserted at the caret position (IME-like composition);
//   • the caret stays visible during dictation;
//   • the silence auto-stop countdown pauses while the user is editing;
//   • start/stop earcons + a live mic-level halo + a silence countdown ring.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Mic, Loader2 } from 'lucide-react'
import { api } from '../api/client'
import type { VoiceSession, VoiceErrorCode } from './voiceStt'

function voiceErrorInfo(code?: VoiceErrorCode): { key: string; def: string } {
  switch (code) {
    case 'not-allowed':
      return { key: 'shell.voice_err_denied', def: 'Micro non autorisé. Autorisez le microphone pour ce site dans le navigateur.' }
    case 'audio-capture':
      return { key: 'shell.voice_err_nomic',  def: 'Aucun microphone détecté.' }
    case 'connect':
      return { key: 'shell.voice_err_connect', def: 'Connexion au service vocal impossible.' }
    default:
      return { key: 'shell.voice_err_generic', def: 'Reconnaissance vocale indisponible.' }
  }
}

export interface UseVoiceDictationOptions {
  /** Recognition language; defaults to the UI language. */
  lang?: string
  /** Called live with the full editable text (finalized + interim + manual edits). */
  onText?: (text: string) => void
  /** Optional seed text to start the toast with (caret placed at its end). */
  getSeed?: () => string
  /** Called when the user validates (Enter / ✓): receives the final text, toast closes. */
  onSubmit?: (text: string) => void
}

export interface VoiceDictation {
  enabled: boolean
  listening: boolean
  voiceLoading: boolean
  voiceError: string | null
  micBtnRef: React.RefObject<HTMLButtonElement | null>
  toggleVoice: () => void
  stop: () => void
  /** The centered toast overlay - render it anywhere (it is `position: fixed`). */
  voiceToast: ReactNode
}

export function useVoiceDictation(opts: UseVoiceDictationOptions = {}): VoiceDictation {
  const { t, i18n } = useTranslation()
  const lang = opts.lang ?? i18n.language

  const [listening, setListening] = useState(false)
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceLevel, setVoiceLevel] = useState(0)
  const [voiceCountdown, setVoiceCountdown] = useState(0)  // 0..1 silence progress
  const [text, setText] = useState('')                     // editable transcript

  const sessionRef = useRef<VoiceSession | null>(null)
  const loadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const micBtnRef = useRef<HTMLButtonElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const hasSpokenRef = useRef(false)
  const lastSoundRef = useRef(0)
  const lastEditRef = useRef(0)   // performance.now() of last manual edit (typing/caret)
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const soundThresholdRef = useRef(0.04)
  const silenceMsRef = useRef(3000)

  // Editable-text + composition state (refs, to stay current inside ws callbacks).
  const textRef = useRef('')                  // latest text value
  const composStartRef = useRef(0)            // caret where the current utterance began
  const composLenRef = useRef(0)              // length of the interim text inserted
  const pendingCaretRef = useRef<number | null>(null)
  const onTextRef = useRef<typeof opts.onText>(opts.onText)
  onTextRef.current = opts.onText
  const onSubmitRef = useRef<typeof opts.onSubmit>(opts.onSubmit)
  onSubmitRef.current = opts.onSubmit
  const [mounted, setMounted] = useState(false)  // entrance animation flag

  // ── Status (admin switch + per-language + capture settings) ──────────────────
  const { data: sttStatus } = useQuery({
    queryKey: ['stt-status', lang],
    queryFn: () => api.get<{ enabled: boolean; silence_ms?: number; sound_threshold?: number }>(
      '/stt/status', { params: { lang } }).then((r) => r.data),
    retry: false,
    staleTime: 60_000,
  })
  const enabled = !!sttStatus?.enabled
  useEffect(() => {
    if (typeof sttStatus?.silence_ms === 'number') silenceMsRef.current = sttStatus.silence_ms
    if (typeof sttStatus?.sound_threshold === 'number') soundThresholdRef.current = sttStatus.sound_threshold
  }, [sttStatus])

  // Apply the pending caret position + auto-grow after a programmatic text update.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    if (pendingCaretRef.current != null) {
      const pos = Math.min(pendingCaretRef.current, ta.value.length)
      try { ta.setSelectionRange(pos, pos) } catch { /* */ }
      pendingCaretRef.current = null
    }
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }, [text])

  const setTextProgrammatic = (next: string, caret: number) => {
    textRef.current = next
    pendingCaretRef.current = caret
    setText(next)
    onTextRef.current?.(next)
  }

  // Insert/replace the current interim transcript at the caret (composition).
  const applyComposition = (chunk: string, finalize: boolean) => {
    const base = textRef.current
    const start = Math.min(composStartRef.current, base.length)
    const end = Math.min(start + composLenRef.current, base.length)
    const insert = finalize ? (chunk ? `${chunk} ` : '') : chunk
    const next = base.slice(0, start) + insert + base.slice(end)
    if (finalize) {
      composStartRef.current = start + insert.length
      composLenRef.current = 0
    } else {
      composLenRef.current = insert.length
    }
    setTextProgrammatic(next, start + insert.length)
  }

  // Detected sound resets the silence countdown (and arms it).
  const onSound = () => { hasSpokenRef.current = true; lastSoundRef.current = performance.now() }
  // A manual edit pauses the countdown for a short grace period, so the user is
  // never cut off mid-typing (distinct from speaking, which uses onSound).
  const markEditing = () => { lastEditRef.current = performance.now() }

  const clearLoadTimer = () => {
    if (loadTimerRef.current) { clearTimeout(loadTimerRef.current); loadTimerRef.current = null }
  }
  const stopCountdownLoop = () => {
    if (countdownIntervalRef.current) { clearInterval(countdownIntervalRef.current); countdownIntervalRef.current = null }
  }

  // Silence watchdog: ticks 10×/s; fires after silenceMs of quiet, pauses while
  // the pointer hovers the mic button OR the textarea is focused (editing).
  const startCountdownLoop = () => {
    stopCountdownLoop()
    lastSoundRef.current = performance.now()
    countdownIntervalRef.current = setInterval(() => {
      if (!sessionRef.current) return
      const overButton = micBtnRef.current?.matches(':hover') ?? false
      // Pause while the user is actively editing the transcript (recent keystroke
      // or caret move in the focused textarea).
      const editing = !!taRef.current && document.activeElement === taRef.current
        && (performance.now() - lastEditRef.current) < 1200
      const running = hasSpokenRef.current && !overButton && !editing
      if (!running) { lastSoundRef.current = performance.now(); setVoiceCountdown(0); return }
      const elapsed = performance.now() - lastSoundRef.current
      if (elapsed >= silenceMsRef.current) { stopVoice(); return }
      setVoiceCountdown(elapsed / silenceMsRef.current)
    }, 100)
  }

  const playCue = (kind: 'start' | 'end') => {
    try {
      if (!audioCtxRef.current) {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        if (!Ctx) return
        audioCtxRef.current = new Ctx()
      }
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      const notes = kind === 'start' ? [660, 990] : [780, 440]
      const now = ctx.currentTime
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        const t0 = now + i * 0.085
        const dur = 0.12
        gain.gain.setValueAtTime(0.0001, t0)
        gain.gain.linearRampToValueAtTime(0.13, t0 + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(t0); osc.stop(t0 + dur + 0.02)
      })
    } catch { /* best-effort */ }
  }

  const stopVoice = () => {
    const wasActive = !!sessionRef.current
    clearLoadTimer()
    stopCountdownLoop()
    setVoiceCountdown(0)
    sessionRef.current?.stop()
    sessionRef.current = null
    setListening(false)
    setVoiceLoading(false)
    setVoiceLevel(0)
    if (wasActive) playCue('end')
  }

  const toggleVoice = () => {
    if (listening || voiceLoading) { stopVoice(); return }
    setVoiceError(null)
    const seed = opts.getSeed?.() ?? ''
    textRef.current = seed
    setText(seed)
    composStartRef.current = seed.length
    composLenRef.current = 0
    hasSpokenRef.current = false
    setVoiceLoading(true)
    clearLoadTimer()
    loadTimerRef.current = setTimeout(() => {
      stopVoice()
      const info = voiceErrorInfo()
      setVoiceError(t(info.key, { defaultValue: info.def }))
    }, 30000)
    void (async () => {
      try {
        const { startVoiceSession } = await import('./voiceStt')
        const session = await startVoiceSession(lang, {
          onReady: () => {
            clearLoadTimer(); setVoiceLoading(false); setListening(true); startCountdownLoop(); playCue('start')
            // Focus the editable field so the caret is visible from the start.
            requestAnimationFrame(() => {
              const ta = taRef.current
              if (!ta) return
              ta.focus()
              const len = textRef.current.length
              try { ta.setSelectionRange(len, len) } catch { /* */ }
              composStartRef.current = len
              composLenRef.current = 0
            })
          },
          onLevel: (lv) => {
            setVoiceLevel(lv)
            if (lv > soundThresholdRef.current) onSound()
          },
          onPartial: (p) => applyComposition(p, false),
          onResult: (f) => applyComposition(f, true),
          onError: (code) => {
            const info = voiceErrorInfo(code)
            stopVoice()
            setVoiceError(t(info.key, { defaultValue: info.def }))
          },
        })
        sessionRef.current = session
      } catch { /* onError already surfaced it */ }
    })()
  }

  // Cleanup on unmount.
  useEffect(() => () => {
    clearLoadTimer(); stopCountdownLoop(); sessionRef.current?.stop()
    audioCtxRef.current?.close().catch(() => {})
  }, [])

  // ── User edits inside the textarea ───────────────────────────────────────────
  const onUserChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    textRef.current = v
    setText(v)
    onTextRef.current?.(v)
    composStartRef.current = e.target.selectionStart ?? v.length
    composLenRef.current = 0
    markEditing()  // editing pauses the silence countdown
  }
  const onUserCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    // A user-driven caret move: next dictated words insert here.
    composStartRef.current = e.currentTarget.selectionStart ?? textRef.current.length
    composLenRef.current = 0
    markEditing()
  }

  // Validate: stop and hand the final text to the consumer (e.g. send / search).
  const validate = () => { const txt = textRef.current; stopVoice(); onSubmitRef.current?.(txt) }

  const onUserKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    markEditing()
    if (e.key === 'Escape') { e.preventDefault(); stopVoice() }            // cancel
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); validate() } // confirm
    // Shift+Enter falls through → newline.
  }
  // Keep the caret visible: if focus is lost while still listening, take it back.
  const onUserBlur = () => { if (sessionRef.current) requestAnimationFrame(() => taRef.current?.focus()) }

  // Entrance animation: flip `mounted` on the frame after the toast appears.
  useEffect(() => {
    if (listening || voiceLoading || voiceError) {
      const id = requestAnimationFrame(() => setMounted(true))
      return () => cancelAnimationFrame(id)
    }
    setMounted(false)
  }, [listening, voiceLoading, voiceError])

  const C = 2 * Math.PI * 22
  const voicePrompt = voiceError
    || (voiceLoading ? t('shell.voice_preparing', { defaultValue: 'Préparation du micro…' }) : '')

  const voiceToast = (listening || voiceLoading || voiceError) ? (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center px-4"
      style={{
        background: mounted ? 'rgba(15,23,42,0.16)' : 'rgba(15,23,42,0)',
        backdropFilter: mounted ? 'blur(2px)' : 'none',
        WebkitBackdropFilter: mounted ? 'blur(2px)' : 'none',
        transition: 'background 160ms ease',
      }}
      // Click on the dim backdrop (not the card) dismisses - consistent everywhere.
      onMouseDown={(e) => { if (e.target === e.currentTarget) stopVoice() }}
    >
      <div
        role="status"
        aria-live="polite"
        className="flex items-end gap-5"
        style={{
          width: 'min(860px, 100%)',
          background: '#ffffff',
          border: '1px solid #ececec',
          borderRadius: 34,
          boxShadow: '0 16px 56px rgba(0,0,0,0.24)',
          padding: '24px 30px',
          transform: mounted ? 'scale(1)' : 'scale(0.96)',
          opacity: mounted ? 1 : 0,
          transition: 'transform 160ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease',
        }}
      >
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {voiceError ? (
            <span className="break-words leading-snug text-2xl text-[#ea4335]">{voicePrompt}</span>
          ) : (
            <textarea
              ref={taRef}
              value={text}
              onChange={onUserChange}
              onKeyDown={onUserKey}
              onClick={onUserCaret}
              onKeyUp={onUserCaret}
              onBlur={onUserBlur}
              rows={1}
              placeholder={voicePrompt || t('shell.voice_listening', { defaultValue: 'Parlez maintenant.' })}
              aria-label={t('shell.voice_listening', { defaultValue: 'Parlez maintenant.' })}
              className="w-full resize-none bg-transparent outline-none border-none leading-snug text-2xl text-text-primary placeholder:text-text-secondary"
              style={{ maxHeight: 260 }}
            />
          )}
        </div>

        <div className="flex items-center gap-3 self-end pb-0.5">
          {/* Stop the mic (keeps the text) */}
          <button
            ref={micBtnRef}
            onClick={toggleVoice}
            aria-label={t('shell.voice_stop', { defaultValue: 'Arrêter la dictée' })}
            title={t('shell.voice_stop', { defaultValue: 'Arrêter la dictée' })}
            className="relative flex-shrink-0 rounded-full flex items-center justify-center"
            style={{ width: 64, height: 64, background: 'rgba(234,67,53,0.12)' }}
          >
            {voiceLoading ? (
              <Loader2 size={32} className="relative animate-spin" style={{ color: 'var(--color-text-secondary)' }} />
            ) : (
              <>
                {listening && !voiceError && (
                  <span className="absolute inset-0 rounded-full" style={{
                    background: 'rgba(234,67,53,0.28)',
                    transform: `scale(${1 + Math.min(voiceLevel, 1) * 1.5})`,
                    transition: 'transform 90ms ease-out',
                  }} />
                )}
                {voiceCountdown > 0 && (
                  <svg className="absolute pointer-events-none"
                    style={{ inset: -3, width: 'calc(100% + 6px)', height: 'calc(100% + 6px)', transform: 'rotate(-90deg)' }}
                    viewBox="0 0 48 48" aria-hidden>
                    <circle cx="24" cy="24" r="22" fill="none" stroke="#ea4335" strokeWidth="3" strokeLinecap="round"
                      strokeDasharray={C} strokeDashoffset={C * voiceCountdown}
                      style={{ transition: 'stroke-dashoffset 100ms linear' }} />
                  </svg>
                )}
                <Mic size={32} className="relative" style={{ color: '#ea4335' }} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { enabled, listening, voiceLoading, voiceError, micBtnRef, toggleVoice, stop: stopVoice, voiceToast }
}
