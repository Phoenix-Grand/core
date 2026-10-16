import '@testing-library/jest-dom'

// ── Contexte Canvas 2D déterministe pour les tests de canvas-engine ───────────
//
// jsdom stubifie HTMLCanvasElement mais getContext('2d') retourne null.
// canvas-engine.ts s'appuie sur measureText pour le layout ; on fournit un mock
// proportionnel afin que word-wrap et mapping de coordonnées soient testables.
//
// Modèle de police (correspond aux métriques Arial typiques à 96 dpi) :
//   char width  = fontPx * 0.55   (largeur proportionnelle moyenne)
//   ascent      = fontPx * 0.80
//   descent     = fontPx * 0.25
//   lineHeight  = (ascent + descent) * 1.15   (LH_RATIO par défaut Google Docs)
//
// Exemples à 11 pt (14.667 px) :
//   char width ≈ 8.07 px  →  624 px de zone de contenu ≈ 77 cars par ligne
//   line height ≈ 17.71 px

class FakeContext2D {
  // ── Propriétés de dessin ────────────────────────────────────────────────────
  font                     = ''
  textBaseline             = ''
  textAlign                = ''
  fillStyle                = ''
  strokeStyle              = ''
  lineWidth                = 1
  lineCap                  = 'butt'
  lineJoin                 = 'miter'
  miterLimit               = 10
  lineDashOffset           = 0
  globalAlpha              = 1
  globalCompositeOperation = 'source-over'
  shadowBlur               = 0
  shadowColor              = 'rgba(0,0,0,0)'
  shadowOffsetX            = 0
  shadowOffsetY            = 0
  imageSmoothingEnabled    = true
  imageSmoothingQuality    = 'low'
  direction                = 'inherit'
  fontKerning              = 'auto'

  // ── Mesure (seul usage réel par canvas-engine.ts via mc()) ─────────────────

  private fontPx(): number {
    const m = this.font.match(/(\d+(?:\.\d+)?)px/)
    return m ? parseFloat(m[1]) : 14.667          // 11 pt par défaut
  }

  measureText(text: string) {
    const px  = this.fontPx()
    const cw  = text.length * px * 0.55
    const asc = px * 0.80
    const dsc = px * 0.25
    return {
      width:                    cw,
      actualBoundingBoxAscent:  asc,
      actualBoundingBoxDescent: dsc,
      actualBoundingBoxLeft:    0,
      actualBoundingBoxRight:   cw,
      fontBoundingBoxAscent:    px * 0.85,
      fontBoundingBoxDescent:   px * 0.30,
      emHeightAscent:           asc,
      emHeightDescent:          px * 0.20,
      hangingBaseline:          px * 0.60,
      alphabeticBaseline:       0,
      ideographicBaseline:      -(px * 0.20),
    }
  }

  // ── Méthodes de rendu (noops - ce contexte ne rend rien) ───────────────────

  clearRect()          { /* noop */ }
  save()               { /* noop */ }
  restore()            { /* noop */ }
  scale()              { /* noop */ }
  translate()          { /* noop */ }
  rotate()             { /* noop */ }
  transform()          { /* noop */ }
  setTransform()       { /* noop */ }
  resetTransform()     { /* noop */ }
  fillRect()           { /* noop */ }
  strokeRect()         { /* noop */ }
  fillText()           { /* noop */ }
  strokeText()         { /* noop */ }
  beginPath()          { /* noop */ }
  closePath()          { /* noop */ }
  moveTo()             { /* noop */ }
  lineTo()             { /* noop */ }
  arc()                { /* noop */ }
  arcTo()              { /* noop */ }
  bezierCurveTo()      { /* noop */ }
  quadraticCurveTo()   { /* noop */ }
  rect()               { /* noop */ }
  ellipse()            { /* noop */ }
  roundRect()          { /* noop */ }
  fill()               { /* noop */ }
  stroke()             { /* noop */ }
  clip()               { /* noop */ }
  drawImage()          { /* noop */ }
  setLineDash()        { /* noop */ }
  getLineDash()        { return [] }
  isPointInPath()      { return false }
  isPointInStroke()    { return false }
  getTransform()       { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } }
  createLinearGradient()  { return { addColorStop() { /* noop */ } } }
  createRadialGradient()  { return { addColorStop() { /* noop */ } } }
  createConicGradient()   { return { addColorStop() { /* noop */ } } }
  createPattern()         { return null }
  createImageData(w: number, h: number) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' }
  }
  getImageData(sx: number, sy: number, sw: number, sh: number) {
    void sx; void sy
    return { width: sw, height: sh, data: new Uint8ClampedArray(sw * sh * 4), colorSpace: 'srgb' }
  }
  putImageData()  { /* noop */ }
}

// Patch prototype une seule fois - s'applique à tous les fichiers de test.
// Pas de vi.spyOn pour survivre aux restoreAllMocks().
;(HTMLCanvasElement.prototype as unknown as { getContext: (_id: string) => unknown }).getContext =
  (_id: string) => new FakeContext2D()
