/**
 * `AppTileGrid` - the irreducible part of the `WaffleMenu` user control: the favourites card (with the
 * header the view gives it, `<AppTileGrid.Header>`) over every other app, three tiles to a row, and the
 * drag-and-drop edit of the favourites (reorder, add, remove). A designable custom control (WEB-VIEWS §10):
 * registered in the core's project registry (`kbview-controls.json`), placed and configured from the view.
 *
 * Same name and events as the desktop's `kubuno_header::AppTileGrid`: `TileInvoked` (a tile clicked outside
 * the edit mode) and `FavoritesEdited` (the list being edited changed: the list an « OK » would save).
 * Outside the edit mode the tiles are links, made items of the hosting menu by `MenuItemHostContext`.
 */
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { Cloud } from 'lucide-react'

import { defineControl } from '@kubuno/views'
import { findIcon } from '../../utils/iconMap'
import { FAVORITES_MAX, type LauncherApp } from './model'
import { useMenuItemHost } from './menuItemHost'

/** Truncates to `FAVORITES_MAX`: inserting a tenth tile evicts the last one. */
const capFavorites = (ids: string[]) => ids.slice(0, FAVORITES_MAX)

// Where a drag started: 'fav' = a favourite being reordered, 'all' = an app being added.
type DragSource = 'fav' | 'all'

export interface AppTileGridProps {
  /** Every app of the launcher. */
  apps?: LauncherApp[]
  /** The favourites shown on the card, in order (the saved ones; the draft while editing). */
  favorites?: string[]
  editing?: boolean
  /** The card's header band (`<AppTileGrid.Header>`). */
  header?: ReactNode
  /** « Faites glisser vos applis ici » (an empty card while editing). */
  dropHereText?: string
  /** « Toutes les apps sont dans vos favoris » (every app is a favourite while editing). */
  allFavoritesText?: string
  /** `TileInvoked`: an app's tile was clicked outside the edit mode. */
  onTileInvoked?: (id: string) => void
  /** `FavoritesEdited`: the favourites being edited changed (the new list). */
  onFavoritesEdited?: (favorites: string[]) => void
}

/** The icon of an app: its registered component, else its logo, else its Kubuno icon name (`Cloud` when unknown). */
function TileIcon({ app }: { app: LauncherApp }): ReactNode {
  if (app.Icon) return <app.Icon size={48} className="text-text-secondary" />
  if (app.logo) return <img src={app.logo} alt="" width={48} height={48} />
  const Glyph = findIcon(app.icon) ?? Cloud
  return <Glyph size={48} className="text-text-secondary" />
}

const plainClick = (e: MouseEvent) => e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey

function AppTileGridImpl({
  apps = [], favorites = [], editing = false, header, dropHereText, allFavoritesText, onTileInvoked, onFavoritesEdited,
}: AppTileGridProps): ReactNode {
  const asItem = useMenuItemHost()
  const cardRef = useRef<HTMLDivElement>(null)

  const [dragId, setDragId]           = useState<string | null>(null)
  const [dragSrc, setDragSrc]         = useState<DragSource | null>(null)
  const [favDropOver, setFavDropOver] = useState<string | null>(null) // the favourite being hovered
  const [favZoneOver, setFavZoneOver] = useState(false)               // hovering the favourites card
  const [allZoneOver, setAllZoneOver] = useState(false)               // hovering the other apps

  const byId = new Map(apps.map((a) => [a.id, a]))
  const displayed = favorites.map((id) => byId.get(id)).filter(Boolean) as LauncherApp[]
  const edit = (next: string[]) => onFavoritesEdited?.(next)

  /* Auto-scroll while a dragged tile nears an edge of the scrolling panel, and the scroll bar's gutter.
   *
   * The scrolling element is the view's ScrollArea around the grid. A NATIVE listener in the CAPTURE
   * phase: the favourite tiles stop the propagation of their `dragover`, which would keep an ancestor's
   * handler from firing above the card - at the top edge, exactly where it is needed. The speed is kept and
   * replayed in an animation loop: `dragover` only fires on movement, and the list must keep scrolling
   * while the pointer rests against the edge.
   *
   * The gutter: the scroll area reserves one on BOTH edges (`ScrollbarGutter="StableBothEdges"`): 0 where
   * scroll bars overlay, a few pixels where they take room. The card must look framed by the same 10px on
   * every side, so its side margin is 10px MINUS that gutter while the top keeps a plain 10px; the zone
   * below reads the matching inset so its tiles stay on the card's columns. Published as variables on the
   * scrolling element, measured again on resize. */
  useLayoutEffect(() => {
    const card = cardRef.current
    const el = (card?.closest('[data-kb-scroll]') as HTMLElement | null) ?? card?.parentElement ?? null
    if (!el) return

    // A wide sensitive band with a FLOOR speed: a ramp from zero left three quarters of the band inert.
    const ZONE = 120 // band height, px
    const MIN  = 6   // speed at the band's outer edge, px per frame
    const MAX  = 28  // speed against the panel's edge
    let vy = 0
    let raf: number | null = null
    const stop = () => {
      if (raf !== null) cancelAnimationFrame(raf)
      raf = null
      vy = 0
    }
    const step = () => {
      if (!vy) { stop(); return }
      el.scrollTop += vy
      raf = requestAnimationFrame(step)
    }
    const onDragOver = (e: globalThis.DragEvent) => {
      const r = el.getBoundingClientRect()
      // On a short panel two 120px bands would overlap.
      const zone = Math.min(ZONE, r.height * 0.35)
      const speed = (d: number) => MIN + (MAX - MIN) * (1 - Math.max(d, 0) / zone)
      const top = e.clientY - r.top
      const bottom = r.bottom - e.clientY
      if (top < zone)        vy = -speed(top)
      else if (bottom < zone) vy = speed(bottom)
      else                    vy = 0
      if (vy && raf === null) raf = requestAnimationFrame(step)
      else if (!vy) stop()
    }
    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('drop', stop, true)
    document.addEventListener('dragend', stop, true)

    const measureGutter = () => {
      const g = Math.max(0, (el.offsetWidth - el.clientWidth) / 2)
      const side = Math.max(0, 10 - g)
      el.style.setProperty('--kb-waffle-side', `${side}px`)
      // The card's side margin plus the 16px padding of its grid.
      el.style.setProperty('--kb-waffle-inset', `${side + 16}px`)
    }
    measureGutter()
    const ro = new ResizeObserver(measureGutter)
    ro.observe(el)
    return () => {
      ro.disconnect()
      stop()
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('drop', stop, true)
      document.removeEventListener('dragend', stop, true)
    }
  }, [])

  // ── Edits ──

  const toggle = (id: string) =>
    edit(favorites.includes(id) ? favorites.filter((x) => x !== id) : capFavorites([...favorites, id]))

  const resetDrag = () => {
    setDragId(null)
    setDragSrc(null)
    setFavDropOver(null)
    setFavZoneOver(false)
    setAllZoneOver(false)
  }

  const onFavDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
    setDragSrc('fav')
  }

  const onAllDragStart = (e: DragEvent, id: string) => {
    e.dataTransfer.effectAllowed = 'copy'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
    setDragSrc('all')
  }

  // Over a favourite: the reorder marker.
  const onFavItemDragOver = (e: DragEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = dragSrc === 'fav' ? 'move' : 'copy'
    setFavDropOver(id)
    setFavZoneOver(true)
  }

  // Over the card's empty space.
  const onFavContainerDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = dragSrc === 'fav' ? 'move' : 'copy'
    setFavZoneOver(true)
  }

  const onFavContainerDragLeave = (e: DragEvent) => {
    // Only when the card is left for good (not when entering a child).
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setFavZoneOver(false)
      setFavDropOver(null)
    }
  }

  // Dropped ON a favourite: lands in front of it.
  const onFavItemDrop = (e: DragEvent, toId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const fromId = dragId ?? e.dataTransfer.getData('text/plain')
    if (!fromId) { resetDrag(); return }
    if (dragSrc === 'fav' && fromId !== toId) {
      const arr = [...favorites]
      const fi = arr.indexOf(fromId), ti = arr.indexOf(toId)
      if (fi >= 0 && ti >= 0) {
        arr.splice(fi, 1)
        arr.splice(ti, 0, fromId)
        edit(arr)
      }
    } else if (dragSrc === 'all' && !favorites.includes(fromId)) {
      const arr = [...favorites]
      const ti = arr.indexOf(toId)
      if (ti < 0) edit([...arr, fromId])
      else {
        arr.splice(ti, 0, fromId)
        edit(capFavorites(arr))
      }
    }
    resetDrag()
  }

  // Dropped on the card, not on a favourite: appended.
  const onFavContainerDrop = (e: DragEvent) => {
    e.preventDefault()
    const fromId = dragId ?? e.dataTransfer.getData('text/plain')
    if (!fromId) { resetDrag(); return }
    if (dragSrc === 'all' && !favorites.includes(fromId)) edit(capFavorites([...favorites, fromId]))
    resetDrag()
  }

  // A favourite dropped on the other apps leaves the favourites.
  const onAllContainerDragOver = (e: DragEvent) => {
    if (dragSrc !== 'fav') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setAllZoneOver(true)
  }

  const onAllContainerDragLeave = (e: DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setAllZoneOver(false)
  }

  const onAllContainerDrop = (e: DragEvent) => {
    e.preventDefault()
    const fromId = dragId ?? e.dataTransfer.getData('text/plain')
    if (!fromId) { resetDrag(); return }
    if (dragSrc === 'fav') edit(favorites.filter((x) => x !== fromId))
    resetDrag()
  }

  // ── The other apps, grouped ──
  // Apps of a module exposing SEVERAL apps (sub-modules: Office, PaintSharp…) are GROUPED under their
  // module, sorted alphabetically inside; standalone apps are listed apart, sorted alphabetically.
  const others = apps.filter((a) => !favorites.includes(a.id))
  const byLabel = (x: LauncherApp, y: LauncherApp) => x.label.localeCompare(y.label)
  const moduleAppCount = apps.reduce<Record<string, number>>((acc, a) => {
    const mid = a.module ?? a.id
    acc[mid] = (acc[mid] ?? 0) + 1
    return acc
  }, {})
  const groups: { module: string; label: string; apps: LauncherApp[] }[] = []
  const standalone: LauncherApp[] = []
  for (const a of others) {
    const mid = a.module ?? a.id
    if ((moduleAppCount[mid] ?? 1) > 1) {
      let g = groups.find((x) => x.module === mid)
      if (!g) { g = { module: mid, label: a.moduleLabel ?? mid, apps: [] }; groups.push(g) }
      g.apps.push(a)
    } else {
      standalone.push(a)
    }
  }
  groups.forEach((g) => g.apps.sort(byLabel))
  groups.sort((a, b) => a.label.localeCompare(b.label))
  standalone.sort(byLabel)

  const placeholder = editing && displayed.length === 0

  // A tile outside the edit mode: a link (the host's menu item), whose plain click raises TileInvoked.
  const link = (app: LauncherApp) => (
    <Fragment key={app.id}>
      {asItem(
        <a
          href={app.href ?? '#'}
          draggable={false}
          onClick={(e) => {
            if (plainClick(e)) e.preventDefault()
            onTileInvoked?.(app.id)
          }}
          className="flex flex-col items-center gap-2 px-2 py-4 rounded-[16px] select-none
                     hover:bg-black/[0.06] transition-colors outline-none"
        >
          <TileIcon app={app} />
          <span className="text-xs text-text-secondary text-center leading-tight">{app.label}</span>
        </a>,
      )}
    </Fragment>
  )

  // A cell of the other apps: draggable to the favourites while editing, else a link.
  const otherCell = (app: LauncherApp) => (
    editing ? (
      <div
        key={app.id}
        draggable
        onDragStart={(e) => onAllDragStart(e, app.id)}
        onDragEnd={resetDrag}
        onClick={() => toggle(app.id)}
        className={`flex flex-col items-center gap-2 px-2 py-4 rounded-[16px] select-none
                    hover:bg-white/60 cursor-grab active:cursor-grabbing transition-colors
                    ${dragId === app.id ? 'opacity-40' : ''}`}
      >
        <TileIcon app={app} />
        <span className="text-xs text-text-secondary text-center leading-tight">{app.label}</span>
      </div>
    ) : link(app)
  )

  const inset: CSSProperties = { paddingInline: 'var(--kb-waffle-inset, 26px)' }

  return (
    <>
      {/* The favourites card (white): the header lives INSIDE it, the panel's tint only showing as a
          margin around the card and below it. Side margins in explicit pixels: the global scale shrinks
          Tailwind's spacing steps. 10px on every side as SEEN: the side margin is net of the scroll bar's
          gutter (see `measureGutter`). */}
      <div
        ref={cardRef}
        className="mt-[10px] mb-[15px] bg-white rounded-[20px] overflow-hidden"
        style={{ marginInline: 'var(--kb-waffle-side, 10px)' }}
        onDragOver={editing ? onFavContainerDragOver : undefined}
        onDragLeave={editing ? onFavContainerDragLeave : undefined}
        onDrop={editing ? onFavContainerDrop : undefined}
      >
        {header}

        {placeholder ? (
          // The empty drop zone: only while editing with no favourite.
          <div
            className={`flex items-center justify-center py-8 px-4 rounded-2xl border-2 border-dashed
                         transition-colors text-center text-xs leading-relaxed
                         ${favZoneOver && dragSrc === 'all'
                           ? 'border-primary text-primary bg-primary/5'
                           : 'border-border text-text-tertiary'}`}
          >
            {dropHereText}
          </div>
        ) : (
          <div className="grid grid-cols-3 p-4 gap-1">
            {displayed.map((app) => (
              editing ? (
                <div
                  key={app.id}
                  draggable
                  onDragStart={(e) => onFavDragStart(e, app.id)}
                  onDragEnd={resetDrag}
                  onDragOver={(e) => onFavItemDragOver(e, app.id)}
                  onDrop={(e) => onFavItemDrop(e, app.id)}
                  onClick={() => toggle(app.id)}
                  className={`relative flex flex-col items-center gap-2 px-2 py-4 rounded-[16px] select-none
                              cursor-grab active:cursor-grabbing transition-colors
                              ${dragId === app.id ? 'opacity-40' : 'hover:bg-black/[0.06]'}`}
                >
                  {/* The insertion bar: the tile lands IN FRONT of this one, so the bar sits in its
                      left gutter. */}
                  {favDropOver === app.id && dragId !== app.id && (
                    <span aria-hidden className="absolute -left-0.5 top-3 bottom-3 w-[3px] rounded-full bg-text-secondary" />
                  )}
                  <TileIcon app={app} />
                  <span className="text-xs text-text-secondary text-center leading-tight">{app.label}</span>
                </div>
              ) : link(app)
            ))}
          </div>
        )}
      </div>

      {/* The other apps (on the tint): inset by `--kb-waffle-inset`, the card's side margin plus its grid's
          16px padding - what puts these tiles on the SAME columns, at the same width, as the card's. */}
      <div
        className={`pb-4 rounded-b-[28px] transition-colors
          ${editing && allZoneOver && dragSrc === 'fav' ? 'bg-danger/5 ring-2 ring-inset ring-danger/30' : ''}`}
        onDragOver={editing ? onAllContainerDragOver : undefined}
        onDragLeave={editing ? onAllContainerDragLeave : undefined}
        onDrop={editing ? onAllContainerDrop : undefined}
      >
        {others.length === 0 && editing ? (
          <p className="text-xs text-text-tertiary text-center py-6 px-4">{allFavoritesText}</p>
        ) : (
          <>
            {standalone.length > 0 && (
              <div className="grid grid-cols-3 gap-1" style={inset}>
                {standalone.map(otherCell)}
              </div>
            )}
            {groups.map((group) => (
              <div key={group.module} className="mt-1">
                <div style={inset} className="pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                  {group.label}
                </div>
                <div className="grid grid-cols-3 gap-1" style={inset}>
                  {group.apps.map(otherCell)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

export const AppTileGrid = defineControl(AppTileGridImpl, {
  category: 'Kubuno',
  icon: 'LayoutGrid',
  defaultEvent: 'OnTileInvoked',
  props: {
    Apps: { kind: 'object', bindable: true, prop: 'apps' },
    Favorites: { kind: 'object', bindable: true, prop: 'favorites' },
    Editing: { kind: 'Bool', default: false, bindable: true, prop: 'editing' },
    DropHereText: { kind: 'String', prop: 'dropHereText' },
    AllFavoritesText: { kind: 'String', prop: 'allFavoritesText' },
  },
  events: {
    OnTileInvoked: { prop: 'onTileInvoked', args: 'ValueChangedEventArgs<string>' },
    OnFavoritesEdited: { prop: 'onFavoritesEdited', args: 'ValueChangedEventArgs<string[]>' },
  },
  children: 'None',
})
