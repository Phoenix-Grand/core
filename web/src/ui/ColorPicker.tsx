// Core UI primitive: Coolorus-inspired colour picker.
// Hue ring + central SV area (square/triangle/circle) + multi-model channel
// sliders (RGB/HSV/HSL/CMYK/Gray) + harmony schemes + hex + swatches + history.
// Promoted out of PaintSharp so EVERY module can use it (not just the creative suite).
// `t` and `C` are optional: omit them outside PaintSharp to get sensible defaults.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { Square, Triangle, Circle, Pipette } from 'lucide-react'
import {
  hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, rgbToHsl, hslToRgb, rgbToCmyk, cmykToRgb,
} from './color'

export type PickerTheme = {
  accent: string; border: string; text: string; textDim: string; toolbar: string
  surface?: string   // fond des champs/contrôles internes (défaut sombre)
  title?:   string   // couleur du titre de l'en-tête (défaut sombre)
}

// Extension point: an extra circular button appended to the left tool column
// (below the SV-shape toggles + eyedropper). Lets a consuming module - e.g.
// PaintSharp's Apex adding a "no fill" option - extend the picker without the
// core knowing about module-specific concepts.
export type PickerTool = {
  id: string
  icon: ReactNode
  title: string
  active?: boolean
  onClick: () => void
}

// Thème sombre par défaut - correspond au chrome des éditeurs PaintSharp.
export const DEFAULT_PICKER_THEME: PickerTheme = {
  accent: '#5a9bdc', border: '#212121', text: '#d6d6d6', textDim: '#8e8e8e', toolbar: '#393939',
  surface: '#252525', title: '#c0c0c0',
}

// Thème clair - pour les modules à interface claire (ex. Office documents).
export const LIGHT_PICKER_THEME: PickerTheme = {
  accent: '#1a73e8', border: '#dadce0', text: '#202124', textDim: '#5f6368', toolbar: '#ffffff',
  surface: '#f1f3f4', title: '#5f6368',
}

// Lit une variable CSS du thème actif (réécrite sur :root par le themeStore),
// avec repli si absente ou hors navigateur.
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// Construit un PickerTheme à partir des variables CSS du thème applicatif courant,
// pour que le picker suive le thème clair/sombre de l'app sans coupler @ui au core.
export function appPickerTheme(): Required<PickerTheme> {
  return {
    accent:  cssVar('--color-primary',        '#1a73e8'),
    border:  cssVar('--color-border',         '#dadce0'),
    text:    cssVar('--color-text-primary',   '#202124'),
    textDim: cssVar('--color-text-secondary', '#5f6368'),
    toolbar: cssVar('--color-surface-0',      '#ffffff'),
    surface: cssVar('--color-surface-2',      '#f1f3f4'),
    title:   cssVar('--color-text-secondary', '#5f6368'),
  }
}

// Hook réactif : recalcule le thème du picker quand le thème applicatif change
// (le themeStore réécrit les variables CSS sur documentElement → MutationObserver).
export function useAppPickerTheme(): Required<PickerTheme> {
  const [theme, setTheme] = useState<Required<PickerTheme>>(appPickerTheme)
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(appPickerTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

// Built-in English fallbacks, used only when no `t` is supplied. Modules that pass
// a `t` keep full i18n; the keys match PaintSharp's existing `layer_*` translations.
const FALLBACK_LABELS: Record<string, string> = {
  layer_color_picker:   "Color",
  layer_harmony_comp:   "Complementary",
  layer_harmony_analog: "Analogous",
  layer_harmony_triad:  "Triadic",
  layer_harmony_tetrad: "Tetradic",
  layer_harmony_split:  "Split complementary",
  layer_harmony_mono:   'Monochrome',
  layer_color_recent:   "Recently used",
  layer_color_eyedropper: "Eyedropper",
  layer_color_cancel:   "Cancel",
  layer_color_confirm:  "Add",
}

export type Scheme = 'comp'|'analog'|'triad'|'tetrad'|'split'|'mono'
// Harmonious colour set derived from the base HSV, like Coolorus colour schemes.
export function harmonyColors(scheme: Scheme, h: number, s: number, v: number): [number,number,number][] {
  const at = (dh: number): [number,number,number] => [ (h+dh+360)%360, s, v ]
  switch (scheme) {
    case 'comp':   return [at(0), at(180)]
    case 'analog': return [at(-30), at(0), at(30)]
    case 'triad':  return [at(0), at(120), at(240)]
    case 'tetrad': return [at(0), at(90), at(180), at(270)]
    case 'split':  return [at(0), at(150), at(210)]
    case 'mono':   return [[h,s,Math.max(0.2,v*0.45)],[h,s,v],[h,Math.max(0.12,s*0.45),Math.min(1,v+0.15)]]
  }
}

// Relative hue angles (degrees from the base hue) that define each scheme's
// geometry - reused to draw the selector glyphs so the icon matches the result.
const HARMONY_ANGLES: Record<Scheme, number[]> = {
  comp:   [0, 180],
  analog: [-30, 0, 30],
  triad:  [0, 120, 240],
  tetrad: [0, 90, 180, 270],
  split:  [0, 150, 210],
  mono:   [], // rendered specially: dots along a single radius
}

// Coolorus-style harmony glyph: a hue-ring outline with the scheme's marker dots
// placed at their true angles and joined by the harmony polygon (the shape that
// defines the relationship). `mono` shows graduated dots along a single radius.
// `comp` (2 points) is a diameter; `analog` an open arc; the rest closed polygons.
function HarmonyIcon({ scheme, size = 20, color = 'currentColor' }: {
  scheme: Scheme; size?: number; color?: string
}) {
  const c = size / 2, R = size / 2 - 3, dot = Math.max(1.6, size * 0.095)
  const pt = (a: number): [number, number] =>
    [c + R * Math.sin(a * Math.PI / 180), c - R * Math.cos(a * Math.PI / 180)]
  // Analogous hues sit only ±30° apart - too cramped to read at 20px, so the glyph
  // spreads them wider (illustrative only; the real harmony still uses HARMONY_ANGLES).
  const iconAngles = scheme === 'analog' ? [-48, 0, 48] : HARMONY_ANGLES[scheme]
  const pts = iconAngles.map(pt)
  const poly = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none"
         strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <circle cx={c} cy={c} r={R} stroke={color} strokeOpacity={0.3} strokeWidth={1} />
      {scheme === 'mono' ? (
        <>
          <line x1={c} y1={c + R} x2={c} y2={c - R} stroke={color} strokeOpacity={0.45} strokeWidth={1.2} />
          {[-1, -0.33, 0.33, 1].map((f, i) => (
            <circle key={i} cx={c} cy={c - R * f} r={i === 3 ? dot * 1.25 : dot}
                    fill={color} fillOpacity={0.45 + 0.18 * (i + 1)} />
          ))}
        </>
      ) : (
        <>
          {pts.length === 2 ? (
            <line x1={pts[0][0]} y1={pts[0][1]} x2={pts[1][0]} y2={pts[1][1]}
                  stroke={color} strokeOpacity={0.55} strokeWidth={1.2} />
          ) : scheme === 'analog' ? (
            // Adjacent hues → an arc riding the hue ring between the outer two dots.
            <path d={`M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} A${R},${R} 0 0 1 ${pts[2][0].toFixed(1)},${pts[2][1].toFixed(1)}`}
                  stroke={color} strokeOpacity={0.55} strokeWidth={1.2} fill="none" />
          ) : (
            <polygon points={poly} stroke={color} strokeOpacity={0.55} strokeWidth={1.2}
                     fill={color} fillOpacity={0.14} />
          )}
          {pts.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={i === 0 ? dot * 1.3 : dot} fill={color} />
          ))}
        </>
      )}
    </svg>
  )
}

type SvShape = 'square' | 'triangle' | 'circle'
// Saturation/Value picker area - square, HSV triangle, or circle (Coolorus shapes).
// Hue comes from the surrounding ring; this maps a 2D position to (s, v).
function SvArea({ size, h, s, v, shape, onChange }: {
  size: number; h: number; s: number; v: number; shape: SvShape; onChange: (s:number,v:number)=>void
}) {
  const canRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef(false)
  // Equilateral HSV triangle inscribed in the inner circle (vertices 120° apart):
  // white at top, black bottom-left, pure hue bottom-right.
  const Rtri = size/2 - 1, cxT = size/2, cyT = size/2, SIN60 = 0.8660254
  const tri = {
    w:   [cxT,            cyT - Rtri]            as [number,number],
    blk: [cxT - Rtri*SIN60, cyT + Rtri*0.5]      as [number,number],
    hue: [cxT + Rtri*SIN60, cyT + Rtri*0.5]      as [number,number],
  }
  const bary = (px:number,py:number,a:[number,number],b:[number,number],c:[number,number]) => {
    const d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
    const wa=((b[1]-c[1])*(px-c[0])+(c[0]-b[0])*(py-c[1]))/d
    const wb=((c[1]-a[1])*(px-c[0])+(a[0]-c[0])*(py-c[1]))/d
    return [wa,wb,1-wa-wb]
  }
  // (s,v) → pixel position of the handle
  const handlePos = (): [number,number] => {
    if (shape==='triangle') {
      const wBlk=1-v, wHue=s*v, wW=(1-s)*v
      return [wW*tri.w[0]+wHue*tri.hue[0]+wBlk*tri.blk[0], wW*tri.w[1]+wHue*tri.hue[1]+wBlk*tri.blk[1]]
    }
    let x=s*size, y=(1-v)*size
    if (shape==='circle') { const cx=size/2,cy=size/2,R=size/2; let dx=x-cx,dy=y-cy; const d=Math.hypot(dx,dy); if(d>R){dx*=R/d;dy*=R/d;x=cx+dx;y=cy+dy} }
    return [x,y]
  }
  useEffect(() => {
    const cv=canRef.current; if(!cv) return; const ctx=cv.getContext('2d')!
    const SS=3, n=Math.round(size*SS) // supersample → smooth (anti-aliased) edges via CSS downscale
    cv.width=n; cv.height=n
    const img=ctx.createImageData(n,n); const d=img.data; const R=n/2
    const tw:[number,number]=[tri.w[0]*SS,tri.w[1]*SS], th:[number,number]=[tri.hue[0]*SS,tri.hue[1]*SS], tb:[number,number]=[tri.blk[0]*SS,tri.blk[1]*SS]
    for(let y=0;y<n;y++) for(let x=0;x<n;x++){
      let ss=0,vv=0,inside=true
      if(shape==='triangle'){ const [wW,wH,wB]=bary(x+0.5,y+0.5,tw,th,tb); if(wW<0||wH<0||wB<0){inside=false} else { vv=1-wB; ss=(wW+wH)>0?wH/(wW+wH):0 } }
      else if(shape==='circle'){ const dx=x-R,dy=y-R; if(Math.hypot(dx,dy)>R){inside=false} else { ss=x/n; vv=1-y/n } }
      else { ss=x/n; vv=1-y/n }
      const o=(y*n+x)*4
      if(!inside){ d[o+3]=0; continue }
      const [r,g,b]=hsvToRgb(h,ss,vv); d[o]=r;d[o+1]=g;d[o+2]=b;d[o+3]=255
    }
    ctx.putImageData(img,0,0)
  }, [h, shape, size]) // eslint-disable-line react-hooks/exhaustive-deps
  const upd = (e:{clientX:number;clientY:number}) => {
    const cv=canRef.current; if(!cv) return; const rc=cv.getBoundingClientRect()
    let px=e.clientX-rc.left, py=e.clientY-rc.top
    if(shape==='triangle'){ let [wW,wH,wB]=bary(px,py,tri.w,tri.hue,tri.blk); wW=Math.max(0,wW);wH=Math.max(0,wH);wB=Math.max(0,wB); const sum=wW+wH+wB||1; wW/=sum;wH/=sum;wB/=sum; const vv=1-wB, ss=(wW+wH)>0?wH/(wW+wH):0; onChange(ss,vv); return }
    if(shape==='circle'){ const cx=size/2,cy=size/2,R=size/2; let dx=px-cx,dy=py-cy; const dd=Math.hypot(dx,dy); if(dd>R){px=cx+dx*R/dd;py=cy+dy*R/dd} }
    onChange(Math.max(0,Math.min(1,px/size)), Math.max(0,Math.min(1,1-py/size)))
  }
  useEffect(()=>{ const m=(e:PointerEvent)=>{if(drag.current)upd(e)}; const u=()=>{drag.current=false}; window.addEventListener('pointermove',m); window.addEventListener('pointerup',u); return ()=>{window.removeEventListener('pointermove',m);window.removeEventListener('pointerup',u)} }) // eslint-disable-line react-hooks/exhaustive-deps
  const [hxp,hyp]=handlePos()
  return (
    <div className="absolute" style={{ left:(212-size)/2, top:(212-size)/2, width:size, height:size }}>
      <canvas ref={canRef} tabIndex={0} role="slider"
              aria-label="Saturation / value"
              aria-valuetext={`S ${Math.round(s*100)}%, V ${Math.round(v*100)}%`}
              onPointerDown={e=>{drag.current=true;upd(e)}}
              onKeyDown={e=>{
                const st=e.shiftKey?0.1:0.02, cl=(x:number)=>Math.max(0,Math.min(1,x))
                if(e.key==='ArrowLeft') onChange(cl(s-st),v)
                else if(e.key==='ArrowRight') onChange(cl(s+st),v)
                else if(e.key==='ArrowUp') onChange(s,cl(v+st))
                else if(e.key==='ArrowDown') onChange(s,cl(v-st))
                else return
                e.preventDefault()
              }}
              className="focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              style={{ width:size, height:size, cursor:'crosshair', borderRadius: shape==='circle'?'50%':2 }} />
      <div className="absolute rounded-full pointer-events-none"
           style={{ width:11, height:11, border:'2px solid #fff', boxShadow:'0 0 0 1px rgba(0,0,0,.5)', left:hxp-5.5, top:hyp-5.5 }} />
    </div>
  )
}

// One labelled gradient channel slider for the Coolorus picker.
function ColorChan({ label, value, max, track, onInput, C }: {
  label: string; value: number; max: number; track: string; onInput: (v:number)=>void
  C: { border:string; text:string; textDim:string; surface:string }
}) {
  const ref = useRef<HTMLDivElement>(null); const drag = useRef(false)
  const upd = (e:{clientX:number}) => { const el=ref.current; if(!el)return; const rc=el.getBoundingClientRect(); onInput(Math.max(0,Math.min(1,(e.clientX-rc.left)/rc.width))*max) }
  useEffect(()=>{ const m=(e:PointerEvent)=>{if(drag.current)upd(e)}; const u=()=>{drag.current=false}; window.addEventListener('pointermove',m); window.addEventListener('pointerup',u); return ()=>{window.removeEventListener('pointermove',m);window.removeEventListener('pointerup',u)} }) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] w-3 text-center" style={{ color:C.textDim }}>{label}</span>
      <div ref={ref} tabIndex={0} role="slider"
           aria-label={label} aria-valuemin={0} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)}
           onPointerDown={e=>{drag.current=true;upd(e)}}
           onKeyDown={e=>{
             const st=e.shiftKey?10:1
             if(e.key==='ArrowLeft'||e.key==='ArrowDown') onInput(Math.max(0,value-st))
             else if(e.key==='ArrowRight'||e.key==='ArrowUp') onInput(Math.min(max,value+st))
             else return
             e.preventDefault()
           }}
           className="relative flex-1 h-3 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
           style={{ background:track, border:`1px solid ${C.border}`, borderRadius:2 }}>
        <div className="absolute top-[-2px] bottom-[-2px] pointer-events-none"
             style={{ width:3, background:'#fff', boxShadow:'0 0 0 1px rgba(0,0,0,.6)', left:`calc(${(value/max)*100}% - 1.5px)`, borderRadius:2 }} />
      </div>
      <input type="number" min={0} max={Math.round(max)} value={Math.round(value)}
             onChange={e=>onInput(Math.max(0,Math.min(max,+e.target.value)))}
             className="w-11 h-5 text-[10px] text-center outline-none"
             style={{ background:C.surface, color:C.text, border:`1px solid ${C.border}`, borderRadius:2 }} />
    </div>
  )
}

// Coolorus-inspired colour picker: hue ring + central SV square + multi-model
// sliders (RGB/HSV/HSL/CMYK/Gray) + hex + swatches.
export function ColorPicker({ t, color, onChange, onClose, C: CProp = DEFAULT_PICKER_THEME, history = [], onPickHistory, onConfirm, onCancel, confirmLabel, cancelLabel, leftTools = [] }: {
  t?: TFunction; color: string; onChange: (hex:string)=>void; onClose: ()=>void
  C?: PickerTheme
  history?: string[]; onPickHistory?: (hex:string)=>void
  // Pied de page optionnel (Annuler / Ajouter). Fourni p.ex. par ColorSwatchPicker
  // pour que le picker « Personnalisé » confirme ou annule, et revienne à la grille.
  onConfirm?: (hex:string)=>void; onCancel?: ()=>void; confirmLabel?: string; cancelLabel?: string
  // Boutons circulaires supplémentaires ajoutés en bas de la colonne de gauche.
  leftTools?: PickerTool[]
}) {
  // Normalise le thème : `surface`/`title` absents (ex. thème PaintSharp) → défauts sombres.
  const C = { ...DEFAULT_PICKER_THEME, ...CProp } as Required<PickerTheme>
  const tr = (k: string) => (t ? t(k, { defaultValue: FALLBACK_LABELS[k] ?? k }) : (FALLBACK_LABELS[k] ?? k))
  const [r0,g0,b0] = hexToRgb(color)
  const [h0,s0,v0] = rgbToHsv(r0,g0,b0)
  const [h, setH] = useState(h0); const [s, setS] = useState(s0); const [v, setV] = useState(v0)
  const [mode, setMode] = useState<'RGB'|'HSV'|'HSL'|'CMYK'|'GRAY'>('RGB')
  const [svShape, setSvShape] = useState<SvShape>('square')
  const [scheme, setScheme] = useState<Scheme>('comp')
  useEffect(() => {
    const [rr,gg,bb] = hexToRgb(color)
    const cur = rgbToHex(...hsvToRgb(h,s,v) as [number,number,number])
    if (cur.toLowerCase() !== color.toLowerCase()) { const [nh,ns,nv] = rgbToHsv(rr,gg,bb); setH(nh); setS(ns); setV(nv) }
  }, [color]) // eslint-disable-line react-hooks/exhaustive-deps

  const setHSV = (nh:number, ns:number, nv:number) => { setH(nh); setS(ns); setV(nv); onChange(rgbToHex(...hsvToRgb(nh,ns,nv) as [number,number,number])) }
  const setRgb = (r:number,g:number,b:number) => { const [nh,ns,nv] = rgbToHsv(r,g,b); setHSV(nh,ns,nv) }

  // Screen colour picker (Chromium EyeDropper API). Rendered only where supported.
  const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window
  const pickEyedropper = async () => {
    const ED = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
    if (!ED) return
    try { const res = await new ED().open(); const [rr,gg,bb] = hexToRgb(res.sRGBHex); setRgb(rr,gg,bb) }
    catch { /* cancelled by the user */ }
  }

  const SIZE = 212, RING = 22
  const wheelRef = useRef<HTMLDivElement>(null); const dragHue = useRef(false)
  const updHue = (e:{clientX:number;clientY:number}) => { const el=wheelRef.current; if(!el)return; const rc=el.getBoundingClientRect(); const dx=e.clientX-rc.left-rc.width/2, dy=e.clientY-rc.top-rc.height/2; let a=Math.atan2(dx,-dy)*180/Math.PI; a=(a+360)%360; setHSV(a,s,v) }
  useEffect(()=>{ const m=(e:PointerEvent)=>{if(dragHue.current)updHue(e)}; const u=()=>{dragHue.current=false}; window.addEventListener('pointermove',m); window.addEventListener('pointerup',u); return ()=>{window.removeEventListener('pointermove',m);window.removeEventListener('pointerup',u)} }) // eslint-disable-line react-hooks/exhaustive-deps

  const [r,g,b] = hsvToRgb(h,s,v).map(Math.round) as [number,number,number]
  const hueHex = rgbToHex(...hsvToRgb(h,1,1) as [number,number,number])
  const hex = rgbToHex(r,g,b)
  const ringR = SIZE/2 - RING/2
  const hAng = h*Math.PI/180
  const hxp = SIZE/2 + ringR*Math.sin(hAng), hyp = SIZE/2 - ringR*Math.cos(hAng)
  const sqSide = Math.round((SIZE - 2*RING - 12)/Math.SQRT2) // square inscribed in inner circle
  const innerD = SIZE - 2*RING - 6                            // triangle/circle fill the inner circle
  const svSize = svShape==='square' ? sqSide : innerD
  const harm = harmonyColors(scheme, h, s, v)
  const toHex = (rr:number,gg:number,bb:number)=>rgbToHex(Math.round(rr),Math.round(gg),Math.round(bb))

  // Channel sliders for the active colour model.
  type Ch = { l:string; val:number; max:number; track:string; set:(v:number)=>void }
  let chans: Ch[] = []
  if (mode==='RGB') chans = [
    { l:'R', val:r, max:255, track:`linear-gradient(to right,${toHex(0,g,b)},${toHex(255,g,b)})`, set:x=>setRgb(x,g,b) },
    { l:'G', val:g, max:255, track:`linear-gradient(to right,${toHex(r,0,b)},${toHex(r,255,b)})`, set:x=>setRgb(r,x,b) },
    { l:'B', val:b, max:255, track:`linear-gradient(to right,${toHex(r,g,0)},${toHex(r,g,255)})`, set:x=>setRgb(r,g,x) },
  ]
  else if (mode==='HSV') chans = [
    { l:'H', val:h, max:360, track:'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)', set:x=>setHSV(x,s,v) },
    { l:'S', val:s*100, max:100, track:`linear-gradient(to right,${toHex(...hsvToRgb(h,0,v) as [number,number,number])},${toHex(...hsvToRgb(h,1,v) as [number,number,number])})`, set:x=>setHSV(h,x/100,v) },
    { l:'V', val:v*100, max:100, track:`linear-gradient(to right,#000,${toHex(...hsvToRgb(h,s,1) as [number,number,number])})`, set:x=>setHSV(h,s,x/100) },
  ]
  else if (mode==='HSL') { const [hh,sl,ll]=rgbToHsl(r,g,b); chans = [
    { l:'H', val:hh, max:360, track:'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)', set:x=>setRgb(...hslToRgb(x,sl,ll) as [number,number,number]) },
    { l:'S', val:sl*100, max:100, track:`linear-gradient(to right,${toHex(...hslToRgb(hh,0,ll) as [number,number,number])},${toHex(...hslToRgb(hh,1,ll) as [number,number,number])})`, set:x=>setRgb(...hslToRgb(hh,x/100,ll) as [number,number,number]) },
    { l:'L', val:ll*100, max:100, track:`linear-gradient(to right,#000,${toHex(...hslToRgb(hh,sl,0.5) as [number,number,number])},#fff)`, set:x=>setRgb(...hslToRgb(hh,sl,x/100) as [number,number,number]) },
  ] }
  else if (mode==='CMYK') { const [c,m,y,k]=rgbToCmyk(r,g,b); chans = [
    { l:'C', val:c, max:100, track:`linear-gradient(to right,${toHex(...cmykToRgb(0,m,y,k) as [number,number,number])},${toHex(...cmykToRgb(100,m,y,k) as [number,number,number])})`, set:x=>setRgb(...cmykToRgb(x,m,y,k) as [number,number,number]) },
    { l:'M', val:m, max:100, track:`linear-gradient(to right,${toHex(...cmykToRgb(c,0,y,k) as [number,number,number])},${toHex(...cmykToRgb(c,100,y,k) as [number,number,number])})`, set:x=>setRgb(...cmykToRgb(c,x,y,k) as [number,number,number]) },
    { l:'Y', val:y, max:100, track:`linear-gradient(to right,${toHex(...cmykToRgb(c,m,0,k) as [number,number,number])},${toHex(...cmykToRgb(c,m,100,k) as [number,number,number])})`, set:x=>setRgb(...cmykToRgb(c,m,x,k) as [number,number,number]) },
    { l:'K', val:k, max:100, track:`linear-gradient(to right,${toHex(...cmykToRgb(c,m,y,0) as [number,number,number])},#000)`, set:x=>setRgb(...cmykToRgb(c,m,y,x) as [number,number,number]) },
  ] }
  else { const gy=Math.round((r+g+b)/3); chans = [
    { l:'K', val:gy/255*100, max:100, track:'linear-gradient(to right,#000,#fff)', set:x=>{ const gg=Math.round(x/100*255); setRgb(gg,gg,gg) } },
  ] }

  const SWATCHES = ['#000000','#ffffff','#e84a4a','#f9ab00','#f4d03f','#1e8e3e','#16a085','#4a90e8','#2c3e50','#9b51e0','#ff7eb6','#7f8c8d']
  const MODES: typeof mode[] = ['RGB','HSV','HSL','CMYK','GRAY']
  const SCHEMES: { key: Scheme; label: string }[] = [
    { key:'comp',   label:'layer_harmony_comp' },
    { key:'analog', label:'layer_harmony_analog' },
    { key:'triad',  label:'layer_harmony_triad' },
    { key:'tetrad', label:'layer_harmony_tetrad' },
    { key:'split',  label:'layer_harmony_split' },
    { key:'mono',   label:'layer_harmony_mono' },
  ]

  return (
    <div className="shadow-2xl p-3" style={{ width:312, background:C.toolbar, border:`1px solid ${C.border}`, borderRadius:4 }}
         onPointerDown={e => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-medium" style={{ color:C.title }}>{tr('layer_color_picker')}</span>
        <button onClick={onClose} className="text-[11px] px-1 rounded hover:bg-white/10" style={{ color:C.textDim }}>✕</button>
      </div>

      {/* SV-shape column (left) + hue ring/SV area (centre) + harmony column (right) */}
      <div className="flex items-start gap-1.5 justify-center">
        {/* SV area shape selector + screen eyedropper - vertical column of circular
            buttons (mirrors the harmony column on the right), top-aligned. */}
        <div className="flex flex-col gap-1" style={{ height:SIZE }}>
          {(['square','triangle','circle'] as SvShape[]).map(sh => {
            const active = svShape===sh
            return (
              <button key={sh} onClick={()=>setSvShape(sh)} title={sh} aria-pressed={active}
                      className="w-8 h-8 flex items-center justify-center rounded-full transition-colors"
                      style={{ background: active?C.accent:C.surface,
                               color: active?'#fff':C.textDim, border:`1px solid ${active?C.accent:C.border}` }}>
                {sh==='square' ? <Square size={15}/> : sh==='triangle' ? <Triangle size={15}/> : <Circle size={15}/>}
              </button>
            )
          })}
          {hasEyeDropper && (
            <button onClick={pickEyedropper} title={tr('layer_color_eyedropper')}
                    aria-label={tr('layer_color_eyedropper')}
                    className="w-8 h-8 flex items-center justify-center rounded-full transition-colors"
                    style={{ background:C.surface, color:C.textDim, border:`1px solid ${C.border}` }}
                    onMouseEnter={e=>{ e.currentTarget.style.color=C.accent; e.currentTarget.style.borderColor=C.accent }}
                    onMouseLeave={e=>{ e.currentTarget.style.color=C.textDim; e.currentTarget.style.borderColor=C.border }}>
              <Pipette size={14} />
            </button>
          )}
          {/* Module-provided extra tools (e.g. Apex "no fill"). */}
          {leftTools.map(tool => (
            <button key={tool.id} onClick={tool.onClick} title={tool.title}
                    aria-label={tool.title} aria-pressed={tool.active ?? undefined}
                    className="w-8 h-8 flex items-center justify-center rounded-full transition-colors"
                    style={{ background: tool.active?C.accent:C.surface,
                             color: tool.active?'#fff':C.textDim, border:`1px solid ${tool.active?C.accent:C.border}` }}>
              {tool.icon}
            </button>
          ))}
        </div>

        <div className="relative" style={{ width:SIZE, height:SIZE }}>
          <div ref={wheelRef} tabIndex={0} role="slider"
               aria-label={tr('layer_color_picker')} aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(h)}
               onPointerDown={e=>{dragHue.current=true;updHue(e)}}
               onKeyDown={e=>{
                 const st=e.shiftKey?10:1
                 if(e.key==='ArrowLeft'||e.key==='ArrowDown') setHSV((h-st+360)%360,s,v)
                 else if(e.key==='ArrowRight'||e.key==='ArrowUp') setHSV((h+st)%360,s,v)
                 else return
                 e.preventDefault()
               }}
               className="absolute inset-0 rounded-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
               style={{ background:'conic-gradient(#f00 0deg,#ff0 60deg,#0f0 120deg,#0ff 180deg,#00f 240deg,#f0f 300deg,#f00 360deg)' }} />
          <div className="absolute rounded-full" style={{ inset:RING, background:C.toolbar }} />
          {/* hue handle */}
          <div className="absolute rounded-full pointer-events-none"
               style={{ width:14, height:14, border:'2px solid #fff', boxShadow:'0 0 0 1px rgba(0,0,0,.6)', background:hueHex, left:hxp-7, top:hyp-7 }} />
          {/* harmony markers on the ring */}
          {harm.slice(1).map((c, i) => {
            const a=c[0]*Math.PI/180, mx=SIZE/2+ringR*Math.sin(a), my=SIZE/2-ringR*Math.cos(a)
            return <div key={i} className="absolute rounded-full pointer-events-none"
                        style={{ width:10, height:10, border:'2px solid rgba(255,255,255,.85)', background:rgbToHex(...hsvToRgb(c[0],c[1],c[2]) as [number,number,number]), left:mx-5, top:my-5 }} />
          })}
          {/* SV area (square / triangle / circle) */}
          <SvArea size={svSize} h={h} s={s} v={v} shape={svShape} onChange={(ns,nv)=>setHSV(h,ns,nv)} />
        </div>

        {/* Harmony scheme selector - vertical column of circular icon buttons
            (replaces the old <select>). 6×32px + 5×4px gaps = 212px = wheel height. */}
        <div className="flex flex-col gap-1 justify-between" style={{ height:SIZE }}>
          {SCHEMES.map(sc => {
            const active = scheme===sc.key
            return (
              <button key={sc.key} onClick={()=>setScheme(sc.key)} title={tr(sc.label)}
                      aria-label={tr(sc.label)} aria-pressed={active}
                      className="w-8 h-8 flex items-center justify-center rounded-full transition-colors"
                      style={{ background: active?C.accent:C.surface,
                               color: active?'#fff':C.textDim, border:`1px solid ${active?C.accent:C.border}` }}>
                <HarmonyIcon scheme={sc.key} size={20} />
              </button>
            )
          })}
        </div>
      </div>

      {/* Harmony swatches */}
      <div className="flex gap-1 mt-2.5">
        {harm.map((c, i) => { const hx=rgbToHex(...hsvToRgb(c[0],c[1],c[2]) as [number,number,number])
          return <button key={i} onClick={()=>setHSV(c[0],c[1],c[2])} title={hx}
                         className="flex-1 h-6" style={{ background:hx, borderRadius:3, border:`1px solid ${C.border}` }} /> })}
      </div>

      {/* Preview + hex */}
      <div className="flex items-center gap-2 mt-2">
        <div style={{ width:28, height:24, background:hex, border:`1px solid ${C.border}`, borderRadius:2, flexShrink:0 }} />
        <span className="text-[10px]" style={{ color:C.textDim }}>#</span>
        <input value={hex.replace('#','').toUpperCase()}
               onChange={e=>{ let v=e.target.value.trim().replace(/^#/,'')
                 if(/^[0-9a-fA-F]{3}$/.test(v)) v=v.split('').map(c=>c+c).join('')  // #abc → #aabbcc
                 if(/^[0-9a-fA-F]{6}$/.test(v)){ const [rr,gg,bb]=hexToRgb('#'+v); setRgb(rr,gg,bb) } }}
               className="flex-1 h-6 text-[11px] px-2 outline-none font-mono uppercase"
               style={{ background:C.surface, border:`1px solid ${C.border}`, color:C.text, borderRadius:2 }} />
      </div>

      {/* Model tabs */}
      <div className="flex mt-2.5 mb-1.5" style={{ borderBottom:`1px solid ${C.border}` }}>
        {MODES.map(md => (
          <button key={md} onClick={()=>setMode(md)}
                  className="px-1.5 py-0.5 text-[10px] font-medium"
                  style={{ color: mode===md ? C.accent : C.textDim, borderBottom: mode===md ? `2px solid ${C.accent}` : '2px solid transparent' }}>
            {md}
          </button>
        ))}
      </div>

      {/* Channel sliders */}
      <div className="space-y-1.5">
        {chans.map(ch => <ColorChan key={ch.l} label={ch.l} value={ch.val} max={ch.max} track={ch.track} onInput={ch.set} C={C} />)}
      </div>

      {/* Swatches */}
      <div className="flex flex-wrap gap-1 mt-2.5">
        {SWATCHES.map(sw => (
          <button key={sw} onClick={()=>{ const [rr,gg,bb]=hexToRgb(sw); setRgb(rr,gg,bb) }} title={sw}
                  style={{ width:16, height:16, background:sw, borderRadius:2,
                           border:`1px solid ${sw.toLowerCase()===hex.toLowerCase()?C.accent:C.border}` }} />
        ))}
      </div>

      {/* Recently used colours (last 30) */}
      {history.length > 0 && (
        <div className="mt-3 pt-2" style={{ borderTop:`1px solid ${C.border}` }}>
          <div className="text-[10px] uppercase tracking-wide mb-1.5" style={{ color:C.textDim }}>{tr('layer_color_recent')}</div>
          <div className="grid gap-1" style={{ gridTemplateColumns:'repeat(10, 1fr)' }}>
            {history.slice(0,30).map((c,i) => (
              <button key={c+i} title={c}
                      onClick={()=>{ const [rr,gg,bb]=hexToRgb(c); setRgb(rr,gg,bb); onPickHistory?.(c) }}
                      className="aspect-square transition-transform hover:scale-110"
                      style={{ background:c, borderRadius:3,
                               border:`1px solid ${c.toLowerCase()===hex.toLowerCase()?C.accent:C.border}`,
                               boxShadow: c.toLowerCase()===hex.toLowerCase()?`0 0 0 1px ${C.accent}`:'none' }} />
            ))}
          </div>
        </div>
      )}

      {/* Pied de page optionnel : Annuler / Ajouter (revient à la grille de pastilles). */}
      {(onConfirm || onCancel) && (
        <div className="flex items-center justify-end gap-2 mt-3 pt-2.5" style={{ borderTop:`1px solid ${C.border}` }}>
          {onCancel && (
            <button onClick={onCancel}
                    className="px-3 h-7 text-[11px] font-medium rounded transition-colors"
                    style={{ color:C.text, background:'transparent', border:`1px solid ${C.border}` }}>
              {cancelLabel ?? tr('layer_color_cancel')}
            </button>
          )}
          {onConfirm && (
            <button onClick={()=>onConfirm(hex)}
                    className="px-3 h-7 text-[11px] font-medium rounded transition-colors"
                    style={{ color:'#fff', background:C.accent, border:`1px solid ${C.accent}` }}>
              {confirmLabel ?? tr('layer_color_confirm')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
