/**
 * Paper, in the only unit that survives a printer: millimetres.
 *
 * The console lays reports out itself rather than handing a long page to the
 * browser and hoping. That is what makes a preview a PREVIEW — the sheets on
 * screen are the sheets that come out, cut at the same rows, with the same
 * running footer, and with a page count that can actually be printed on them
 * (`page 2 sur 4` is unobtainable from CSS in this engine, and trivial once the
 * console owns the pagination).
 *
 * Everything here is geometry, no React: the paginator is a pure function of
 * numbers and must be readable as such.
 */

/** CSS pixels per millimetre. CSS fixes 1in = 96px by definition, not by DPI. */
export const MM = 96 / 25.4

export interface PaperFormat {
  id:     string
  /** Short width × height in mm, portrait. */
  widthMm:  number
  heightMm: number
}

/**
 * The two formats worth carrying: the world's, and North America's. Adding a
 * third is a line in this table — the rest of the pipeline reads millimetres.
 */
export const PAPER: Record<string, PaperFormat> = {
  a4:     { id: 'a4',     widthMm: 210,   heightMm: 297   },
  letter: { id: 'letter', widthMm: 215.9, heightMm: 279.4 },
}

export type Orientation = 'portrait' | 'landscape'

/**
 * Gap between two sheets ON SCREEN, in pixels.
 *
 * ⚠ Coupled to `index.css` (`[data-sheets] { gap: 24px }`): the stack's height
 * is computed from it rather than measured, so the two must agree.
 */
export const SHEET_GAP = 24

/**
 * Breathing space above and below the stack, in pixels.
 *
 * ⚠ Coupled to `index.css` (`[data-sheets] { padding: 24px 0 }`) AND counted in
 * the stack's computed height: the frame's height is set from that computation,
 * so padding it forgot about would clip the last sheet.
 */
export const SHEET_PAD = 24

/**
 * Side gutters of the workspace, in pixels — where each sheet's own controls
 * live, on the dark ground rather than on the paper.
 *
 * ⚠ Coupled to `index.css` (`[data-sheets] { padding: 24px 48px }`) AND to the
 * fit computation: the frame's width includes this padding, so a fit that
 * ignored it would scale the sheet to a width it does not have.
 */
export const SHEET_PAD_X = 48

/** Margins of the printed sheet, in mm. Uniform: a report is not a letterhead. */
export const MARGIN_MM = 15

export interface PageGeometry {
  widthMm:   number
  heightMm:  number
  marginMm:  number
  /** Usable box, in CSS pixels — what the paginator fills. */
  contentWidthPx:  number
  contentHeightPx: number
}

export function geometry(
  format: PaperFormat,
  orientation: Orientation,
  /** Height taken by the running footer, measured on the real thing. */
  footerPx: number,
): PageGeometry {
  const portrait = orientation === 'portrait'
  const widthMm  = portrait ? format.widthMm  : format.heightMm
  const heightMm = portrait ? format.heightMm : format.widthMm
  return {
    widthMm,
    heightMm,
    marginMm: MARGIN_MM,
    contentWidthPx:  (widthMm  - 2 * MARGIN_MM) * MM,
    // The footer sits inside the margin box, under the content: whatever it
    // takes is height the content will never get. Reserved here, once, so no
    // downstream code has to remember it exists.
    contentHeightPx: (heightMm - 2 * MARGIN_MM) * MM - footerPx,
  }
}
