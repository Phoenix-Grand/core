/**
 * The parts of `PagedPreview.kbcontrol` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { MoreVertical, RotateCw } from "lucide-react"
import { MenuDropdown } from "@ui"
import { SHEET_PAD_X } from "./geometry"
import TableFragment from "./TableFragment"
import type { PagedPreview } from './PagedPreview'
const RAIL_W  = 150

export function Part1({ geos, firstOrientation }: { geos: NonNullable<PagedPreview['geos']>; firstOrientation: NonNullable<PagedPreview['firstOrientation']> }) {
  return (
    <style>{`
        @page kb-portrait  { size: ${geos.current.portrait.widthMm}mm ${geos.current.portrait.heightMm}mm;  margin: 0; }
        @page kb-landscape { size: ${geos.current.landscape.widthMm}mm ${geos.current.landscape.heightMm}mm; margin: 0; }
        @page { size: ${geos.current[firstOrientation].widthMm}mm ${geos.current[firstOrientation].heightMm}mm; margin: 0; }
        @media print {
          /* The document STARTS in the first sheet's page context. Without this
             the root carries the unnamed page, the first sheet switches context,
             and switching forces a break — a blank sheet ahead of page 1, in the
             browser's default paper. Seen on a proof: five pages for four. */
          html, body { page: kb-${firstOrientation}; }
          [data-sheet][data-o="portrait"]  { page: kb-portrait; }
          [data-sheet][data-o="landscape"] { page: kb-landscape; }
          [data-sheet] { height: calc(var(--sheet-h) - 0.5mm) !important; }
        }
      `}</style>
  )
}

export function Part2({ measureRef, items }: { measureRef: NonNullable<PagedPreview['measureRef']>; items: NonNullable<PagedPreview['props']['items']> }) {
  return (
    <div ref={measureRef} data-admin-report data-paged-measure>
              {items.map(item => (
                <div key={item.id} data-m={item.id} style={{ display: 'flow-root' }}>
                  {item.kind === 'atom' ? item.node : <TableFragment item={item} />}
                </div>
              ))}
            </div>
  )
}

export function Part3({ footerRef, footer }: { footerRef: NonNullable<PagedPreview['footerRef']>; footer: NonNullable<PagedPreview['props']['footer']> }) {
  return (
    <div ref={footerRef}>
              <div data-sheet-footer>{footer(1, 1)}</div>
            </div>
  )
}

export function Part4({ frameRef, zoom, stackPx, stampVars, cover, orientation, setMenuSheet, menu, sheetRefs, styleOf, geos, sheets, orientOf, setFlips, t, sheetContent }: { frameRef: NonNullable<PagedPreview['frameRef']>; zoom: NonNullable<PagedPreview['zoom']>; stackPx: NonNullable<PagedPreview['stackPx']>; stampVars: NonNullable<PagedPreview['stampVars']>; cover: PagedPreview['props']['cover']; orientation: NonNullable<PagedPreview['props']['orientation']>; setMenuSheet: NonNullable<PagedPreview['setMenuSheet']>; menu: NonNullable<PagedPreview['menu']>; sheetRefs: NonNullable<PagedPreview['sheetRefs']>; styleOf: PagedPreview['styleOf']; geos: NonNullable<PagedPreview['geos']>; sheets: NonNullable<PagedPreview['sheets']>; orientOf: NonNullable<PagedPreview['orientOf']>; setFlips: NonNullable<PagedPreview['setFlips']>; t: NonNullable<PagedPreview['tr']>; sheetContent: PagedPreview['sheetContent'] }) {
  return (
    <div
              ref={frameRef}
              data-sheets-frame
              className="min-w-0 flex-1"
              // The clamp exists only because a `transform` paints smaller without
              // shrinking its box. It is undone in print (`index.css`): a box with a
              // fixed height and `overflow: hidden` is monolithic to the paged
              // engine, which answered with a blank leading page.
              style={zoom !== 1 ? { height: stackPx * zoom, overflow: 'hidden' } : undefined}
            >
              <div
                data-sheets
                style={{
                  ...stampVars,
                  ...(zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: 'top center' } : {}),
                }}
              >
                {cover && (
                  <section
                    data-sheet
                    data-admin-report
                    data-o={orientation}
                    onContextMenu={e => { e.preventDefault(); setMenuSheet(null); menu.openAt(e.clientX, e.clientY) }}
                    ref={el => { sheetRefs.current[0] = el }}
                    style={{
                      ...styleOf(geos.current[orientation]),
                      ['--sheet-h' as string]: `${geos.current[orientation].heightMm}mm`,
                    }}
                  >
                    {cover}
                  </section>
                )}
                {sheets.map((sheet, s) => {
                  const o = orientOf(s)
                  const g = geos.current[o]
                  const page = s + 1 + (cover ? 1 : 0)
                  return (
                    <div key={s} className="relative">
                      {/* ── The sheet's own controls, in a vertical gutter to its
                          RIGHT — on the dark ground, never on the paper. A chip
                          floating above the sheet read as part of the document and
                          pushed the first sheet down; a gutter belongs to the
                          workspace, which is what it is. Icon-only, because a
                          column of words at this width would wrap. ── */}
                      <div className="no-print absolute top-0 z-10 flex flex-col gap-1" style={{ right: -SHEET_PAD_X + 6 }}>
                        <button
                          type="button"
                          onClick={() => setFlips(f => ({
                            ...f,
                            [s]: (f[s] ?? orientation) === 'portrait' ? 'landscape' : 'portrait',
                          }))}
                          className="rounded-lg p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                          title={`${t('admin.rep_sheet_orientation')} — ${t(o === 'portrait' ? 'admin.rep_landscape' : 'admin.rep_portrait')}`}
                          aria-label={t('admin.rep_sheet_orientation')}
                        >
                          <RotateCw size={16} aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={e => { setMenuSheet(s); menu.open(e) }}
                          className="rounded-lg p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                          title={t('admin.rep_menu_sheet', { page })}
                          aria-label={t('admin.rep_menu_sheet', { page })}
                        >
                          <MoreVertical size={16} aria-hidden />
                        </button>
                      </div>
                      <section
                        data-sheet
                        data-admin-report
                        data-o={o}
                        onContextMenu={e => { e.preventDefault(); setMenuSheet(s); menu.openAt(e.clientX, e.clientY) }}
                        ref={el => { sheetRefs.current[page - 1] = el }}
                        style={{ ...styleOf(g), ['--sheet-h' as string]: `${g.heightMm}mm` }}
                      >
                        {sheetContent(sheet, s)}
                      </section>
                    </div>
                  )
                })}
              </div>
            </div>
  )
}

export function Part5({ stampVars, bandHeight, t, cover, thumb, geos, orientation, sheets, orientOf, sheetContent }: { stampVars: NonNullable<PagedPreview['stampVars']>; bandHeight: NonNullable<PagedPreview['bandHeight']>; t: NonNullable<PagedPreview['tr']>; cover: PagedPreview['props']['cover']; thumb: PagedPreview['thumb']; geos: NonNullable<PagedPreview['geos']>; orientation: NonNullable<PagedPreview['props']['orientation']>; sheets: NonNullable<PagedPreview['sheets']>; orientOf: NonNullable<PagedPreview['orientOf']>; sheetContent: PagedPreview['sheetContent'] }) {
  return (
    <aside
                className="no-print no-scrollbar sticky flex shrink-0 flex-col items-center gap-3 overflow-y-auto py-3"
                style={{
                  ...stampVars,
                  width: RAIL_W,
                  // Pinned exactly where it already sits: the band, plus the 16 px
                  // the toolbar leaves under itself, minus the panel's 24 px of top
                  // padding (a sticky top is measured from the padding box). Any
                  // other value makes the rail jump the instant it sticks — the
                  // same defect the band itself had.
                  top: bandHeight - 8,
                  // 64 px of application header, the band, the same 16 px, and a
                  // breath at the bottom: what is left is what the rail may occupy.
                  maxHeight: `calc(100vh - ${64 + bandHeight + 16 + 24}px)`,
                }}
                aria-label={t('admin.rep_thumbnails')}
              >
                {cover && thumb(1, geos.current[orientation], cover, orientation)}
                {sheets.map((sheet, s) =>
                  thumb(s + 1 + (cover ? 1 : 0), geos.current[orientOf(s)], sheetContent(sheet, s), orientOf(s)),
                )}
              </aside>
  )
}

export function Part6({ menuItems, menu_pos, menu }: { menuItems: NonNullable<PagedPreview['menuItems']>; menu_pos: NonNullable<NonNullable<PagedPreview['menu']>['pos']>; menu: NonNullable<PagedPreview['menu']> }) {
  return (
    <MenuDropdown items={menuItems} pos={menu_pos} onClose={menu.close} />
  )
}

export function Part7({ active, total, setActive, goTo, t }: { active: NonNullable<PagedPreview['active']>; total: NonNullable<PagedPreview['total']>; setActive: NonNullable<PagedPreview['setActive']>; goTo: PagedPreview['goTo']; t: NonNullable<PagedPreview['tr']> }) {
  return (
    <input
                type="text"
                inputMode="numeric"
                value={active}
                onChange={e => {
                  const n = parseInt(e.currentTarget.value.replace(/\D/g, ''), 10)
                  if (n >= 1 && n <= total) { setActive(n); goTo(n) }
                }}
                className="w-10 rounded border border-white/25 bg-white/10 px-1 py-0.5 text-center text-white outline-none focus:border-white/60"
                aria-label={t('admin.rep_page_label')}
              />
  )
}
