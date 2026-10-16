/**
 * Tailwind classes → `.kbview` properties, **only where the result renders the same pixels** (WEB-VIEWS.md §6.2
 * "Tailwind classes → properties/roles where mapped"); every other class stays in the web-only `Class` attribute and
 * is counted. The host's scales are the core's (`theme.css` / `index.css`): spacing steps of 4 px, `text-xs` /
 * `text-sm` re-pointed at 11.5 / 13.5 px - the `Label` roles `Meta` / `Body` render exactly those classes.
 */

/** Theme tokens of the text and background colour utilities (`views/style.ts` maps them back to the same variables). */
const TEXT_TOKENS: Readonly<Record<string, string>> = {
  'text-text-primary': 'TextPrimary',
  'text-text-secondary': 'TextSecondary',
  'text-text-tertiary': 'TextTertiary',
  'text-primary': 'Primary',
  'text-danger': 'Danger',
  'text-success': 'Success',
  'text-warning': 'Warning',
}
const BG_TOKENS: Readonly<Record<string, string>> = {
  'bg-surface-0': 'Surface',
  'bg-surface-1': 'Surface1',
  'bg-surface-2': 'Surface2',
  'bg-surface-3': 'Surface3',
  'bg-primary': 'Primary',
  'bg-primary-light': 'PrimaryLight',
  'bg-danger-light': 'DangerLight',
  'bg-success-light': 'SuccessLight',
  'bg-warning-light': 'WarningLight',
}

/** `Label` role of a size utility: the role renders that very class. */
const ROLE_OF_SIZE: Readonly<Record<string, string>> = { 'text-xs': 'Meta', 'text-sm': 'Body' }
const WEIGHTS: Readonly<Record<string, string>> = { 'font-normal': 'Regular', 'font-medium': 'Medium', 'font-semibold': 'SemiBold', 'font-bold': 'Bold' }
/** Any font-size utility (a role would add its own size class next to it). */
const SIZE = /^(text-(xs|sm|base|lg|xl|[2-9]xl)|text-\[(length:)?[\d.]+(px|rem|em)\]|text-\[length:)/

export function splitClasses(className: string): string[] {
  return className.split(/\s+/).filter(Boolean)
}

/** Whether a class has a variant prefix (`hover:`, `sm:`, `group-hover:`…). */
function hasVariant(c: string): boolean {
  return /^[^[\]]*:/.test(c.replace(/\[[^\]]*\]/g, ''))
}

export interface ClassMapping {
  /** `.kbview` properties replacing some classes (property → value). */
  props: Record<string, string>
  /** The classes kept in `Class`. */
  rest: string[]
}

/**
 * Colours: a token utility becomes `ForeColor` / `BackColor` when no other class touches the same property (a
 * `hover:` / `dark:` variant, a second colour, an opacity) - the inline colour the runtime writes would override them.
 */
function mapColours(classes: string[], props: Record<string, string>): string[] {
  const textColours = classes.filter((c) => /^(\w+:)*text-(?!(xs|sm|base|lg|xl|[2-9]xl|left|right|center|start|end|justify|wrap|nowrap|balance|pretty|ellipsis|clip)\b)/.test(c) && !SIZE.test(c.replace(/^(\w+:)+/, '')))
  const bgColours = classes.filter((c) => /^(\w+:)*bg-/.test(c))
  const rest = [...classes]
  const take = (list: string[], table: Readonly<Record<string, string>>, prop: string): void => {
    if (list.length !== 1) return
    const c = list[0]
    if (hasVariant(c) || !table[c]) return
    props[prop] = table[c]
    rest.splice(rest.indexOf(c), 1)
  }
  take(textColours, TEXT_TOKENS, 'ForeColor')
  take(bgColours, BG_TOKENS, 'BackColor')
  return rest
}

/** Classes of a text element (`Label`): role, weight, style, alignment, overflow, colours. */
export function mapLabelClasses(className: string): ClassMapping & { hasSize: boolean } {
  let classes = splitClasses(className)
  const props: Record<string, string> = {}
  const plain = classes.filter((c) => !hasVariant(c))
  const sizes = plain.filter((c) => SIZE.test(c))
  // A role renders its own size class: only a lone `text-xs` / `text-sm` becomes the role.
  if (sizes.length === 1 && ROLE_OF_SIZE[sizes[0]] && !classes.some((c) => hasVariant(c) && SIZE.test(c.replace(/^(\w+:)+/, '')))) {
    props.Role = ROLE_OF_SIZE[sizes[0]]
    classes = classes.filter((c) => c !== sizes[0])
  }
  const weights = plain.filter((c) => WEIGHTS[c])
  if (weights.length === 1 && !classes.some((c) => hasVariant(c) && /font-(normal|medium|semibold|bold)/.test(c))) {
    props.FontWeight = WEIGHTS[weights[0]]
    classes = classes.filter((c) => c !== weights[0])
  }
  if (plain.includes('italic') && !classes.some((c) => hasVariant(c) && c.endsWith('italic'))) {
    props.FontStyle = 'Italic'
    classes = classes.filter((c) => c !== 'italic')
  }
  if (plain.includes('text-center') && !classes.some((c) => hasVariant(c) && /text-(left|right|center|start|end)$/.test(c))) {
    props.TextAlign = 'TopCenter'
    classes = classes.filter((c) => c !== 'text-center')
  }
  // `truncate` is the Label's own default (Ellipsis); anything else wraps as the original did.
  if (plain.includes('truncate')) classes = classes.filter((c) => c !== 'truncate')
  else props.Overflow = 'Wrap'
  const rest = mapColours(classes, props)
  return { props, rest, hasSize: sizes.length > 0 || !!props.Role }
}

/** Gap / padding steps → px (the core keeps Tailwind's 4 px spacing step). */
function spacingPx(step: string): number | undefined {
  if (step === 'px') return 1
  const n = Number(step)
  return Number.isFinite(n) ? n * 4 : undefined
}

/**
 * Classes of a `div` that is a plain flex box: `Stack` (`Direction`, `Gap`, `CrossAlign`, `Justify`, `WrapContents`)
 * when nothing else redefines the flex layout (a responsive or state variant of it). `undefined` when not a Stack.
 */
export function mapStackClasses(className: string): ClassMapping | undefined {
  const classes = splitClasses(className)
  if (!classes.includes('flex')) return undefined
  const layoutClass = (c: string): boolean => /^(flex|inline-flex|grid|block|hidden|flex-(row|col|wrap|nowrap|row-reverse|col-reverse)|gap(-[xy])?-|items-|justify-|space-[xy]-)/.test(c)
  if (classes.some((c) => hasVariant(c) && layoutClass(c.replace(/^(\w+:)+/, '')))) return undefined
  if (classes.some((c) => /^(gap-[xy]-|space-[xy]-|inline-flex|grid)/.test(c))) return undefined
  const props: Record<string, string> = {}
  let rest = classes.filter((c) => c !== 'flex')
  const col = rest.includes('flex-col')
  const rowRev = rest.includes('flex-row-reverse')
  const colRev = rest.includes('flex-col-reverse')
  props.Direction = col ? 'TopDown' : colRev ? 'BottomUp' : rowRev ? 'RightToLeft' : 'LeftToRight'
  rest = rest.filter((c) => !['flex-col', 'flex-row', 'flex-row-reverse', 'flex-col-reverse'].includes(c))
  const gap = rest.find((c) => /^gap-/.test(c))
  if (gap) {
    const px = spacingPx(gap.slice(4))
    if (px === undefined) return undefined
    props.Gap = String(px)
    rest = rest.filter((c) => c !== gap)
  } else props.Gap = '0'
  const cross: Record<string, string> = { 'items-start': 'Start', 'items-center': 'Center', 'items-end': 'End', 'items-stretch': 'Stretch' }
  const items = rest.filter((c) => /^items-/.test(c))
  if (items.length > 1 || (items.length === 1 && !cross[items[0]])) return undefined
  if (items.length === 1) {
    if (items[0] !== 'items-stretch') props.CrossAlign = cross[items[0]]
    rest = rest.filter((c) => c !== items[0])
  }
  const just: Record<string, string> = { 'justify-start': 'Start', 'justify-center': 'Center', 'justify-end': 'End', 'justify-between': 'SpaceBetween' }
  const js = rest.filter((c) => /^justify-/.test(c))
  if (js.length > 1 || (js.length === 1 && !just[js[0]])) return undefined
  if (js.length === 1) {
    if (js[0] !== 'justify-start') props.Justify = just[js[0]]
    rest = rest.filter((c) => c !== js[0])
  }
  if (rest.includes('flex-wrap')) {
    props.WrapContents = 'true'
    rest = rest.filter((c) => c !== 'flex-wrap')
  }
  if (rest.includes('flex-nowrap')) rest = rest.filter((c) => c !== 'flex-nowrap')
  rest = mapColours(rest, props)
  return { props, rest }
}

/** Classes of any other container: only the colours. */
export function mapContainerClasses(className: string): ClassMapping {
  const props: Record<string, string> = {}
  const rest = mapColours(splitClasses(className), props)
  return { props, rest }
}

/** Static `style={{…}}` entries → properties or Tailwind arbitrary properties (`[background:#202124]`). */
export function mapStaticStyle(style: Record<string, string | number>): { props: Record<string, string>; classes: string[] } | undefined {
  const props: Record<string, string> = {}
  const classes: string[] = []
  const VAR_TOKENS: Record<string, string> = {
    'var(--body-bg)': 'Background', 'var(--color-surface-0)': 'Surface', 'var(--color-surface-1)': 'Surface1',
    'var(--color-surface-2)': 'Surface2', 'var(--color-surface-3)': 'Surface3', 'var(--color-primary)': 'Primary',
    'var(--color-border)': 'Border', 'var(--color-text-primary)': 'TextPrimary', 'var(--color-text-secondary)': 'TextSecondary',
    'var(--color-text-tertiary)': 'TextTertiary',
  }
  for (const [k, raw] of Object.entries(style)) {
    const v = typeof raw === 'number' ? (/^(opacity|zIndex|flex|flexGrow|flexShrink|order|lineHeight|fontWeight)$/.test(k) ? String(raw) : `${raw}px`) : raw
    if ((k === 'background' || k === 'backgroundColor') && VAR_TOKENS[v.trim()]) {
      props.BackColor = VAR_TOKENS[v.trim()]
      continue
    }
    if (k === 'color' && VAR_TOKENS[v.trim()]) {
      props.ForeColor = VAR_TOKENS[v.trim()]
      continue
    }
    const css = k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
    if (/[\s_]/.test(v) && /[[\]]/.test(v)) return undefined
    classes.push(`[${css}:${v.replace(/ /g, '_')}]`)
  }
  return { props, classes }
}
