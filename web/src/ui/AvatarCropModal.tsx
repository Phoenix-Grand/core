import { useEffect, useRef, useState, useCallback } from 'react'
import { FloatingWindow } from './FloatingWindow'
import { pickImageFile } from '../core/store/imagePickerStore'
import { Button, RangeSlider } from './index'
import { ZoomIn, ZoomOut, ImagePlus, ImageOff } from 'lucide-react'

const BOX = 288   // taille du carré de recadrage (= boîte englobante du cercle)
const OUT = 256   // taille de sortie de l'avatar (px)

export interface AvatarCrop { zoom: number; ox: number; oy: number }

interface Props {
  /** Image initiale à recadrer (avatar actuel ou null). */
  initialSrc?: string | null
  /** Paramètres de recadrage précédents (restaurés sur l'image initiale). */
  initialCrop?: AvatarCrop | null
  saving?:    boolean
  onCancel:   () => void
  /** `original` = fichier nouvellement importé (à conserver côté serveur), sinon null. */
  onSave:     (cropped: Blob, original: File | null, crop: AvatarCrop) => void
}

export default function AvatarCropModal({ initialSrc, initialCrop, saving, onCancel, onSave }: Props) {
  const imgRef     = useRef<HTMLImageElement | null>(null)
  const objUrlRef  = useRef<string | null>(null)   // object URL interne à révoquer
  const origFileRef = useRef<File | null>(null)     // fichier importé cette session (original à conserver)

  const [src, setSrc]     = useState<string | null>(initialSrc ?? null)
  const [nat, setNat]     = useState<{ w: number; h: number } | null>(null)
  const [cover, setCover] = useState(1)
  const [minZoom, setMinZoom] = useState(1)   // zoom min = image entière visible (fit)
  const [zoom, setZoom]   = useState(1)
  const [off, setOff]     = useState({ x: 0, y: 0 })
  const [loadError, setLoadError] = useState(false)
  const drag = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null)

  // (Re)charger l'image quand `src` change
  useEffect(() => {
    if (!src) { setNat(null); return }
    setLoadError(false)
    const im = new Image()
    im.crossOrigin = 'anonymous'   // permet l'export canvas pour les images distantes CORS-ok
    im.onload = () => {
      imgRef.current = im
      const c = BOX / Math.min(im.naturalWidth, im.naturalHeight)
      // zoom min relatif = ratio permettant de voir l'image entière (fit dans la boîte)
      const mz = Math.min(im.naturalWidth, im.naturalHeight) / Math.max(im.naturalWidth, im.naturalHeight)
      setNat({ w: im.naturalWidth, h: im.naturalHeight })
      setCover(c); setMinZoom(mz)
      // Restaurer le recadrage précédent sur l'image initiale ; sinon centrer (cover)
      if (src === initialSrc && initialCrop) {
        const z = Math.max(mz, Math.min(3, initialCrop.zoom))
        const sc = c * z
        const rw = im.naturalWidth * sc, rh = im.naturalHeight * sc
        const loX = Math.min(0, BOX - rw), hiX = Math.max(0, BOX - rw)
        const loY = Math.min(0, BOX - rh), hiY = Math.max(0, BOX - rh)
        setZoom(z)
        setOff({ x: Math.min(hiX, Math.max(loX, initialCrop.ox)), y: Math.min(hiY, Math.max(loY, initialCrop.oy)) })
      } else {
        setZoom(1)
        setOff({ x: (BOX - im.naturalWidth * c) / 2, y: (BOX - im.naturalHeight * c) / 2 })
      }
    }
    im.onerror = () => { setLoadError(true); setNat(null); imgRef.current = null }
    im.src = src
  }, [src])

  // Nettoyage de l'object URL à la fermeture
  useEffect(() => () => { if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current) }, [])

  const scale = cover * zoom
  const rw = nat ? nat.w * scale : 0
  const rh = nat ? nat.h * scale : 0

  // Clamp symétrique : gère l'image plus grande (couvre) OU plus petite (letterbox) que la boîte
  const clamp = useCallback((x: number, y: number) => {
    const loX = Math.min(0, BOX - rw), hiX = Math.max(0, BOX - rw)
    const loY = Math.min(0, BOX - rh), hiY = Math.max(0, BOX - rh)
    return { x: Math.min(hiX, Math.max(loX, x)), y: Math.min(hiY, Math.max(loY, y)) }
  }, [rw, rh])

  useEffect(() => { if (nat) setOff(o => clamp(o.x, o.y)) }, [zoom, nat, clamp])

  const useFile = (file: File | null) => {
    if (!file) return
    if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current)
    const url = URL.createObjectURL(file)
    objUrlRef.current = url
    origFileRef.current = file   // conserver l'original pour le serveur
    setSrc(url)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!nat) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { mx: e.clientX, my: e.clientY, ox: off.x, oy: off.y }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const d = drag.current
    setOff(clamp(d.ox + (e.clientX - d.mx), d.oy + (e.clientY - d.my)))
  }
  const onPointerUp = () => { drag.current = null }

  const handleSave = () => {
    const im = imgRef.current
    if (!im || !nat) return
    const canvas = document.createElement('canvas')
    canvas.width = OUT; canvas.height = OUT
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const ratio = scale
    const s = BOX / ratio
    try {
      // Fond blanc (coins éventuellement vides si dézoom au-delà du cadrage plein)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, OUT, OUT)
      ctx.drawImage(im, -off.x / ratio, -off.y / ratio, s, s, 0, 0, OUT, OUT)
      canvas.toBlob(b => { if (b) onSave(b, origFileRef.current, { zoom, ox: off.x, oy: off.y }) }, 'image/jpeg', 0.9)
    } catch {
      setLoadError(true)   // canvas « tainted » (image distante sans CORS)
    }
  }

  return (
    <FloatingWindow title="Photo de profil" onClose={onCancel} defaultWidth={360} backdrop>
      <div className="p-5 flex flex-col items-center gap-4">
        {/* Zone de recadrage */}
        <div
          className="relative overflow-hidden bg-surface-2 touch-none select-none"
          style={{ width: BOX, height: BOX, cursor: nat ? 'grab' : 'default' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={e => { if (nat) { e.preventDefault(); setZoom(z => Math.min(3, Math.max(minZoom, z - e.deltaY * 0.0015))) } }}
        >
          {nat && src && (
            <img src={src} alt="" draggable={false}
              style={{ position: 'absolute', left: off.x, top: off.y, width: rw, height: rh, maxWidth: 'none' }} />
          )}
          {/* Placeholder si aucune image */}
          {!nat && (
            <button
              type="button"
              onClick={() => { void pickImageFile({ title: 'Photo de profil' }).then(useFile) }}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-tertiary hover:text-primary transition-colors"
            >
              {loadError ? <ImageOff size={36} /> : <ImagePlus size={36} />}
              <span className="text-sm">{loadError ? 'Image illisible - importez-en une' : 'Importer une image'}</span>
            </button>
          )}
          {/* Masque circulaire */}
          {nat && (
            <div className="absolute inset-0 pointer-events-none"
              style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)', borderRadius: '50%', border: '2px solid rgba(255,255,255,0.9)' }} />
          )}
        </div>

        {/* Zoom (si image chargée) */}
        {nat && (
          <div className="flex items-center gap-2 w-full px-1">
            <ZoomOut size={16} className="text-text-tertiary shrink-0" />
            <RangeSlider min={minZoom} max={3} step={0.01} value={zoom}
              onChange={setZoom} className="flex-1" aria-label="Zoom" />
            <ZoomIn size={16} className="text-text-tertiary shrink-0" />
          </div>
        )}

        {/* Import (toujours dispo) */}
        <button
          type="button"
          onClick={() => { void pickImageFile({ title: 'Photo de profil' }).then(useFile) }}
          className="flex items-center gap-1.5 text-sm text-primary hover:text-primary-hover transition-colors"
        >
          <ImagePlus size={15} /> Importer une autre image
        </button>

        {nat && (
          <p className="text-xs text-text-tertiary text-center">
            Glissez pour positionner, utilisez le curseur pour zoomer.
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-3 w-full">
          <Button variant="secondary" className="flex-1" onClick={onCancel}>Annuler</Button>
          <Button className="flex-1" onClick={handleSave} loading={saving} disabled={!nat}>Enregistrer</Button>
        </div>
      </div>
    </FloatingWindow>
  )
}
