#!/usr/bin/env node
// Keyboard, ARIA and event checks of the WV-5a gallery pages in headless Chrome (its own profile and port, one
// tab, Chrome quit at the end): RadioGroup arrow keys and two-way SelectedValue, Accordion two-way Open and
// OnToggled, ContextMenu check marks, RadioGroup and ItemsSource commands, Panel hover, PanelAbsolute anchors.
//
//   npx vite build --config vite.gallery.config.ts && node scripts/verify-wv5a.mjs
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fe = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const dist = resolve(fe, arg('--dist', 'dist-gallery'))
const chromePath = arg('--chrome', process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome')
const debugPort = Number(arg('--port', '9343'))

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const file = join(dist, path === '/' ? 'gallery.html' : path)
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const profile = join(tmpdir(), `kbview-verify-chrome-${process.pid}`)
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let up = false
for (let i = 0; i < 100 && !up; i++) { try { await fetch(`http://127.0.0.1:${debugPort}/json/version`); up = true } catch { await sleep(200) } }
const target = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
const listeners = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } else if (m.method) for (const l of listeners) l(m)
})
const send = (method, params = {}) => new Promise((resolve_, reject) => { const id = ++seq; pending.set(id, { resolve: resolve_, reject }); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
await send('Page.enable')
await send('Runtime.enable')
await send('Accessibility.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
const open = async (page, extra = '') => {
  const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r() } }; listeners.push(l) })
  await send('Page.navigate', { url: `${base}/gallery.html?el=${page}${extra}` })
  await loaded
  for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector('[data-gallery-page] > :nth-child(2)')`)) break; await sleep(100) }
  await sleep(300)
}
const key = async (k, code, keyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode })
  await sleep(150)
}
const text = (needle) => evaluate(`[...document.querySelectorAll('p')].map((p) => p.textContent).find((t) => t.startsWith(${JSON.stringify(needle)})) ?? ''`)
// Clicks the innermost element whose text is exactly `needle` (a button whose text sits next to its icon included).
const clickText = (needle) => evaluate(`(() => { const all = [...document.querySelectorAll('body *')].filter((x) => !(x instanceof SVGElement) && x.textContent.trim() === ${JSON.stringify(needle)}); const e = all.find((x) => ![...x.children].some((c) => c.textContent.trim() === ${JSON.stringify(needle)})); if (!e) return false; e.click(); return true })()`)
const axRoles = async () => {
  const { nodes } = await send('Accessibility.getFullAXTree')
  return nodes.filter((n) => !n.ignored).map((n) => `${n.role?.value}|${n.name?.value ?? ''}|${(n.properties ?? []).filter((p) => ['checked', 'expanded', 'disabled'].includes(p.name)).map((p) => `${p.name}=${p.value?.value}`).join(',')}`)
}

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`) }

for (const dir of ['ltr', 'rtl']) {
  // ── RadioGroup ──
  await open('RadioGroup', `&dir=${dir}`)
  const ax = await axRoles()
  check(`RadioGroup ${dir}: role radiogroup named "Density"`, ax.some((l) => l.startsWith('radiogroup|Density')))
  check(`RadioGroup ${dir}: three radios per group, the bound one checked`, ax.filter((l) => l.startsWith('radio|Comfortable|checked=true')).length === 2, ax.filter((l) => l.startsWith('radio|')).length + ' radios')
  await evaluate(`document.querySelector('[role=radiogroup] input:checked').focus(); true`)
  // ArrowDown and ArrowRight move to the next option in both directions of reading (native radio group).
  await key('ArrowDown', 'ArrowDown', 40)
  check(`RadioGroup ${dir}: ArrowDown selects the next option, two-way to the second group`, (await text('SelectedValue')) === 'SelectedValue: spacious' && (await axRoles()).filter((l) => l.startsWith('radio|Spacious|checked=true')).length === 2, await text('SelectedValue'))
  await key('ArrowUp', 'ArrowUp', 38)
  await key('ArrowUp', 'ArrowUp', 38)
  check(`RadioGroup ${dir}: ArrowUp twice → Compact`, (await text('SelectedValue')) === 'SelectedValue: compact', await text('SelectedValue'))
  check(`RadioGroup ${dir}: the disabled group is disabled`, (await axRoles()).some((l) => l.startsWith('radio|Disabled group|') && l.includes('disabled=true')))
}

// ── Accordion: Open two-way, OnToggled ──
await open('Accordion')
check('Accordion: bound section open at load (first = true)', (await text('first:')).startsWith('first: true - toggles: 0'), await text('first:'))
await clickText('Bound: Open two-way')
await sleep(300)
check('Accordion: closing the bound section writes Open back and raises OnToggled(false)', (await text('first:')) === 'first: false - toggles: 1 (closed)', await text('first:'))
await clickText('Bound: Open two-way')
await sleep(300)
check('Accordion: reopening raises OnToggled(true)', (await text('first:')) === 'first: true - toggles: 2 (opened)', await text('first:'))
await clickText('Literal: Open=true')
await sleep(300)
check('Accordion: an unbound section raises OnToggled too', (await text('first:')) === 'first: true - toggles: 3 (closed)', await text('first:'))

// ── ContextMenu: CheckOnClick, RadioGroup, ItemsSource, hidden item ──
await open('ContextMenu')
const openMenu = async () => { await clickText('Open the menu'); await sleep(300) }
await openMenu()
const items = await evaluate(`[...document.querySelectorAll('[data-kb-menu] button, [data-kb-menu] div')].filter((e) => e.childElementCount === 0 || e.tagName === 'BUTTON').map((e) => (e.tagName === 'BUTTON' ? e.children[1]?.textContent : e.textContent)?.trim()).filter(Boolean)`)
check('ContextMenu: MenuItem children then ItemsSource commands, the hidden one left out', items.includes('Rename') && items.includes('Move to trash') && !items.includes('Not shown') && items.indexOf('Delete') < items.indexOf('Rename'), items.join(' / '))
await clickText('Show hidden files')
await sleep(200)
check('ContextMenu: CheckOnClick toggles, writes Checked back, raises OnCheckedChanged(true)', (await text('Last:')) === 'Last: OnCheckedChanged true - hidden files: true', await text('Last:'))
await openMenu()
await clickText('Grid')
await sleep(200)
await openMenu()
const marks = await evaluate(`(() => { const has = (t) => [...document.querySelectorAll('[data-kb-menu] button')].some((b) => b.children[1]?.textContent.trim() === t && b.children[0]?.textContent.trim() === '✓'); return { list: has('List'), grid: has('Grid'), hidden: has('Show hidden files') } })()`)
check('ContextMenu: RadioGroup moves the check mark (Grid on, List off), CheckOnClick kept', marks.grid && !marks.list && marks.hidden, JSON.stringify(marks))
await clickText('Rename')
await sleep(200)
check('ContextMenu: an ItemsSource command raises OnItemClicked with its key', (await text('Last:')).startsWith('Last: OnItemClicked rename'), await text('Last:'))

// ── Panel: hover background on a push-button row ──
await open('Panel')
const row = await evaluate(`(() => { const e = document.querySelector('[aria-description="gallery-hover"]'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, before: getComputedStyle(e).backgroundColor, tag: e.tagName, width: r.width, parent: e.parentElement.getBoundingClientRect().width } })()`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y })
await sleep(300)
const hovered = await evaluate(`getComputedStyle(document.querySelector('[aria-description="gallery-hover"]')).backgroundColor`)
check('Panel: a PushButton container is a <button> filling its card', row.tag === 'BUTTON' && Math.abs(row.width - row.parent) < 1, `${row.tag} ${row.width}/${row.parent}`)
check('Panel: HoverBackColor paints under the mouse', hovered !== row.before, `${row.before} → ${hovered}`)

// ── PanelAbsolute: anchors after the resize ──
for (const dir of ['ltr', 'rtl']) {
  await open('PanelAbsolute', `&dir=${dir}`)
  await sleep(300)
  const g = await evaluate(`(() => { const board = [...document.querySelectorAll('[data-kb-anchor]')][0].parentElement; const b = board.getBoundingClientRect(); const at = (t) => { const e = [...board.querySelectorAll('button, p')].find((x) => x.textContent.trim() === t); const r = e.getBoundingClientRect(); return { l: Math.round(r.left - b.left - board.clientLeft), r: Math.round(b.right - board.clientLeft - r.right), t: Math.round(r.top - b.top - board.clientTop), bo: Math.round(b.bottom - board.clientTop - r.bottom), w: Math.round(r.width) } }; return { w: board.clientWidth, h: board.clientHeight, tl: at('Top, Left'), tr: at('Top, Right'), br: at('Bottom, Right'), st: at('Left, Right: stretched') } })()`)
  const startOf = (x) => (dir === 'ltr' ? x.l : x.r)
  const endOf = (x) => (dir === 'ltr' ? x.r : x.l)
  check(`PanelAbsolute ${dir}: Top, Left keeps X=8 from the start`, startOf(g.tl) === 8, JSON.stringify(g.tl))
  check(`PanelAbsolute ${dir}: Top, Right keeps 8 px from the end`, endOf(g.tr) === 8, JSON.stringify(g.tr))
  check(`PanelAbsolute ${dir}: Bottom, Right keeps 8 px from the end and 12 px from the bottom`, endOf(g.br) === 8 && g.br.bo === 12, JSON.stringify(g.br))
  check(`PanelAbsolute ${dir}: Left, Right stretches (8 px from both edges)`, g.st.l === 8 && g.st.r === 8 && g.st.w === g.w - 16, JSON.stringify(g.st))
}

await send('Browser.close').catch(() => {})
ws.close()
server.close()
setTimeout(() => { try { chrome.kill() } catch { /* gone */ } rmSync(profile, { recursive: true, force: true }); process.exit(results.every((r) => r.ok) ? 0 : 1) }, 500)
console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`)
