/**
 * Navigation and misc elements (WV-5b): `Toolbar`/`ToolbarItem`, `Sidebar`/`SidebarItem`/`SidebarSection`,
 * `StatusBar`/`StatusLabel`, `Splitter`, `SearchField`, `MaskedField`, `PaintBox` - the desktop's names and members
 * (VIEWS-SPEC §2), rendered by new `@ui` components; the web-only members are allowlisted (`allowlist.nav.ts`).
 */
import type { ComponentProps } from 'react'
import type { Toolbar, ToolbarItemDef } from '../Toolbar'
import type { Sidebar, SidebarItemDef } from '../Sidebar'
import type { StatusBar, StatusLabelDef } from '../StatusBar'
import type { Splitter } from '../Splitter'
import type { SearchField } from '../SearchField'
import type { MaskedField } from '../MaskedField'
import type { PaintBox } from '../PaintBox'
import type { ElementMeta } from './types.ts'
import { ICON_PROPERTIES } from './levels.ts'

const CONTAINER_CHAIN = ['ContainerBase', 'ScrollableControl', 'Control', 'Component'] as const

const ICON_DOC = {
  doc: 'Icon shown before the text: a name of the Kubuno icon set, or an image file (SVG, PNG…) relative to the view.',
  docFr: "Icône affichée avant le texte : un nom du jeu d'icônes Kubuno, ou un fichier image (SVG, PNG…) relatif à la vue.",
} as const

// ── Toolbar ──

export const ToolbarItemMeta = {
  name: 'ToolbarItem',
  doc: 'A command of a Toolbar.',
  docFr: "Commande d'une barre d'outils.",
  family: 'containers',
  baseChain: ['ToolbarItem', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text of the command. Leave empty for an icon-only command.',
      docFr: 'Texte de la commande. Laisser vide pour une commande avec icône seule.',
      to: { prop: 'text' } },
    { name: 'Icon', kind: 'String', default: '', category: 'Icon', editor: 'icon', ...ICON_DOC,
      to: { prop: 'icon', convert: 'icon-node' } },
    ...ICON_PROPERTIES,
    { name: 'ToolTip', kind: 'String', default: '', category: 'Misc', localizable: true, webOnly: true,
      doc: 'Web only: text shown under the pointer; the accessible name of an icon-only command.',
      docFr: "Web uniquement : texte affiché sous le pointeur ; le nom accessible d'une commande avec icône seule.",
      to: { prop: 'tooltip' } },
    { name: 'Enabled', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true, webOnly: true,
      doc: 'Web only: whether the command can be chosen.', docFr: 'Web uniquement : indique si la commande peut être choisie.',
      to: { prop: 'disabled', convert: 'invert' } },
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'ItemEventArgs',
      doc: 'Occurs when the command is clicked.', docFr: 'Se produit quand la commande est cliquée.',
      from: { prop: 'onClick', args: 'item' } },
  ],
  web: { module: null, export: null, domRoot: 'none', itemOf: ['Toolbar'] },
} as const satisfies ElementMeta<ToolbarItemDef>

export const ToolbarMeta = {
  name: 'Toolbar',
  doc: 'A toolbar. Add the commands as ToolbarItem children. One tab stop: the arrow keys move between the commands.',
  docFr: "Barre d'outils. Ajoutez les commandes comme éléments ToolbarItem enfants.",
  family: 'containers',
  baseChain: ['Toolbar', 'Control', 'Component'],
  children: 'List',
  allowedChildren: ['ToolbarItem'],
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Band', kind: 'Bool', default: 'false', category: 'Layout',
      doc: 'Paints a background band behind the commands.', docFr: 'Peint une bande de fond derrière les commandes.',
      to: { prop: 'band' } },
  ],
  events: [],
  inheritedMap: { AccessibleName: { prop: 'aria-label' }, Class: { prop: 'className' } },
  designDefaults: { size: [320, 40] },
  web: { module: '@ui', export: 'Toolbar', domRoot: 'ref', childrenToProp: { prop: 'items', item: 'ToolbarItem', content: 'none', key: 'id' } },
} as const satisfies ElementMeta<ComponentProps<typeof Toolbar>>

// ── Sidebar ──

export const SidebarItemMeta = {
  name: 'SidebarItem',
  doc: 'A row of a Sidebar: an icon and a label. SidebarItem children make it a group the user can expand or collapse.',
  docFr: "Ligne d'un Sidebar : une icône et un libellé. Des SidebarItem enfants en font un groupe que l'utilisateur peut développer ou réduire.",
  family: 'navigation',
  baseChain: ['SidebarItem', 'Component'],
  children: 'List',
  allowedChildren: ['SidebarItem'],
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance', bindable: true, localizable: true,
      doc: 'Label of the row.', docFr: 'Libellé de la ligne.', to: { prop: 'text' } },
    { name: 'Icon', kind: 'String', default: '', category: 'Icon', editor: 'icon',
      doc: 'Icon shown before the label: a name of the Kubuno icon set, or an image file (SVG, PNG…) relative to the view.',
      docFr: "Icône affichée avant le libellé : un nom du jeu d'icônes Kubuno, ou un fichier image (SVG, PNG…) relatif à la vue.",
      to: { prop: 'icon', convert: 'icon-node' } },
    { name: 'Key', kind: 'String', default: '', category: 'Data',
      doc: "The value of SelectedItem when the row is active; empty for its x:Name, else its text.",
      docFr: 'Valeur de SelectedItem quand la ligne est active ; vide pour le x:Name, sinon le texte.',
      to: { prop: 'key' } },
    { name: 'Expanded', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'For a row with children: whether they are shown at first.',
      docFr: "Pour une ligne qui a des enfants : indique s'ils sont affichés au départ.",
      to: { prop: 'expanded' } },
    { name: 'Enabled', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
      doc: 'Whether the row can be chosen.', docFr: 'Indique si la ligne peut être choisie.',
      to: { prop: 'disabled', convert: 'invert' } },
    { name: 'Visible', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
      doc: 'Whether the row is shown.', docFr: 'Indique si la ligne est affichée.',
      to: { runtime: 'visible' } },
    ...ICON_PROPERTIES,
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'ItemEventArgs',
      doc: 'Occurs when the row is chosen.', docFr: 'Se produit quand la ligne est choisie.',
      from: { prop: 'onClick', args: 'item' } },
  ],
  web: { module: null, export: null, domRoot: 'none', itemOf: ['Sidebar', 'SidebarItem'], fixed: { kind: 'item' } },
} as const satisfies ElementMeta<SidebarItemDef>

export const SidebarSectionMeta = {
  name: 'SidebarSection',
  doc: 'A section header of a Sidebar: small uppercase text above the rows that follow it.',
  docFr: "En-tête de section d'un Sidebar : un petit texte en majuscules au-dessus des lignes qui le suivent.",
  family: 'navigation',
  baseChain: ['SidebarSection', 'Component'],
  children: 'None',
  defaultEvent: null,
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance', bindable: true, localizable: true,
      doc: 'Text of the header.', docFr: "Texte de l'en-tête.", to: { prop: 'text' } },
    { name: 'Visible', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
      doc: 'Whether the header is shown.', docFr: "Indique si l'en-tête est affiché.",
      to: { runtime: 'visible' } },
  ],
  events: [],
  web: { module: null, export: null, domRoot: 'none', itemOf: ['Sidebar'], fixed: { kind: 'section' } },
} as const satisfies ElementMeta<SidebarItemDef>

export const SidebarMeta = {
  name: 'Sidebar',
  doc: 'A navigation pane: rows with an icon and a label, section headers and expandable groups. The active row is SelectedItem. On the web, the rows are links of a <nav> (aria-current marks the active one).',
  docFr: 'Volet de navigation : lignes avec une icône et un libellé, en-têtes de section et groupes dépliables. La ligne active est SelectedItem.',
  family: 'navigation',
  baseChain: ['Sidebar', 'Control', 'Component'],
  children: 'List',
  allowedChildren: ['SidebarItem', 'SidebarSection'],
  defaultEvent: 'OnItemInvoked',
  properties: [
    { name: 'SelectedItem', kind: 'String', default: '', category: 'Behavior', bindable: true,
      doc: 'Key of the active row (its x:Name, or its text when it has no Key).',
      docFr: "Clé (Key) de la ligne active (son x:Name, ou son texte si elle n'a pas de Key).",
      to: { prop: 'value', change: 'OnSelectionChanged' } },
    { name: 'DisplayMode', kind: { Enum: ['Expanded', 'Compact'] }, default: 'Expanded', category: 'Appearance', bindable: true,
      doc: 'Expanded shows the labels; Compact shows a rail of icons.',
      docFr: 'Expanded affiche les libellés ; Compact affiche un rail d\'icônes.',
      to: { prop: 'collapsed', values: { Expanded: false, Compact: true } } },
    { name: 'ItemsSource', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'list',
      doc: 'Rows from a list (fields Text, Icon, Key, Level, and Kind="Section" for a header), instead of the rows written inside.',
      docFr: "Lignes issues d'une liste (champs Text, Icon, Key, Level, et Kind=\"Section\" pour un en-tête), à la place des lignes écrites dedans.",
      to: { prop: 'source', convert: 'items-source-icons' } },
  ],
  events: [
    { name: 'OnItemInvoked', category: 'Action', args: 'ValueChangedEventArgs',
      doc: 'Occurs when a row is chosen (click, Enter or Space): its key is the new text.',
      docFr: 'Se produit quand une ligne est choisie (clic ou Entrée) : sa clé est le nouveau texte.',
      from: { prop: 'onItemInvoked', args: 'value' } },
    { name: 'OnSelectionChanged', category: 'Property Changed', args: 'ValueChangedEventArgs',
      doc: 'Occurs when the active row changes.', docFr: 'Se produit quand la ligne active change.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: { AccessibleName: { prop: 'aria-label' }, Class: { prop: 'className' } },
  designDefaults: { size: [256, 360] },
  web: {
    module: '@ui', export: 'Sidebar', domRoot: 'ref',
    childrenToProp: { prop: 'items', item: ['SidebarItem', 'SidebarSection'], content: 'none', key: 'id', nested: 'items' },
  },
} as const satisfies ElementMeta<ComponentProps<typeof Sidebar>>

// ── StatusBar ──

export const StatusLabelMeta = {
  name: 'StatusLabel',
  doc: 'A cell of a StatusBar: a text, an optional icon. Spring makes it share the leftover width; a Text of a single dash makes a separator; Clickable makes it a button.',
  docFr: "Cellule d'une barre d'état : un texte, une icône facultative. Spring lui fait prendre la largeur restante ; un texte fait d'un seul tiret crée un séparateur ; Clickable en fait un bouton.",
  family: 'navigation',
  baseChain: ['StatusLabel', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance', bindable: true, localizable: true,
      doc: 'Text of the cell. A single dash makes a separator.', docFr: 'Texte de la cellule. Un seul tiret crée un séparateur.',
      to: { prop: 'text' } },
    { name: 'Icon', kind: 'String', default: '', category: 'Icon', editor: 'icon',
      doc: 'Icon shown before the text (a clickable cell): a name of the Kubuno icon set, or an image file relative to the view.',
      docFr: "Icône affichée avant le texte (cellule cliquable) : un nom du jeu d'icônes Kubuno, ou un fichier image (SVG, PNG…) relatif à la vue.",
      to: { prop: 'icon', convert: 'icon-node' } },
    { name: 'Spring', kind: 'Bool', default: 'false', category: 'Layout',
      doc: 'The cell takes the width the other cells leave.', docFr: 'La cellule prend la largeur que les autres cellules laissent.',
      to: { prop: 'spring' } },
    { name: 'Clickable', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'The cell is a button: it lights up under the pointer and raises OnClick.',
      docFr: "La cellule est un bouton : elle s'éclaire sous la souris et déclenche OnClick.",
      to: { prop: 'clickable' } },
    { name: 'Enabled', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
      doc: 'Whether a clickable cell can be clicked.', docFr: 'Indique si une cellule cliquable peut être cliquée.',
      to: { prop: 'disabled', convert: 'invert' } },
    { name: 'Visible', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
      doc: 'Whether the cell is shown.', docFr: 'Indique si la cellule est affichée.',
      to: { runtime: 'visible' } },
    ...ICON_PROPERTIES,
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'ItemEventArgs',
      doc: 'Occurs when a clickable cell is clicked.', docFr: 'Se produit quand on clique sur une cellule cliquable.',
      from: { prop: 'onClick', args: 'item' } },
  ],
  web: { module: null, export: null, domRoot: 'none', itemOf: ['StatusBar'] },
} as const satisfies ElementMeta<StatusLabelDef>

export const StatusBarMeta = {
  name: 'StatusBar',
  doc: 'A status bar: a row of StatusLabel cells along the bottom of a window. On the web, role="status" (changes are announced politely).',
  docFr: "Barre d'état : une rangée de cellules StatusLabel en bas d'une fenêtre.",
  family: 'navigation',
  baseChain: ['StatusBar', 'Control', 'Component'],
  children: 'List',
  allowedChildren: ['StatusLabel'],
  defaultEvent: 'OnItemClicked',
  properties: [],
  events: [
    { name: 'OnItemClicked', category: 'Action', args: 'ItemEventArgs',
      doc: 'Occurs when a clickable cell is clicked (its index is in the event).',
      docFr: "Se produit quand on clique sur une cellule cliquable (son index est dans l'événement).",
      from: { prop: 'onItemClick', args: 'row' } },
  ],
  inheritedMap: { AccessibleName: { prop: 'aria-label' }, Class: { prop: 'className' } },
  designDefaults: { size: [480, 24] },
  web: { module: '@ui', export: 'StatusBar', domRoot: 'ref', childrenToProp: { prop: 'items', item: 'StatusLabel', content: 'none', key: 'id' } },
} as const satisfies ElementMeta<ComponentProps<typeof StatusBar>>

// ── Splitter ──

export const SplitterMeta = {
  name: 'Splitter',
  doc: 'Two panes separated by a bar that can be dragged. On the web the bar is a focusable separator: the arrow keys move it (Shift: by 50 px), Home / End.',
  docFr: 'Deux volets séparés par une barre que l\'on peut faire glisser.',
  family: 'containers',
  baseChain: ['Splitter', ...CONTAINER_CHAIN],
  children: 'List',
  layoutKind: 'Split',
  defaultEvent: 'OnDistanceChanged',
  properties: [
    { name: 'Orientation', kind: { Enum: ['Vertical', 'Horizontal'] }, default: 'Vertical', category: 'Layout',
      doc: 'Vertical: panes side by side. Horizontal: panes one above the other.',
      docFr: "Vertical : volets côte à côte. Horizontal : volets l'un au-dessus de l'autre.",
      to: { prop: 'orientation', values: { Vertical: 'vertical', Horizontal: 'horizontal' } } },
    { name: 'Distance', kind: 'F32', default: '200', category: 'Layout',
      doc: 'Size of the first pane, in pixels. Updated when the bar is moved.',
      docFr: 'Taille du premier volet, en pixels. Mise à jour quand la barre est déplacée.',
      to: { prop: 'distance', change: 'OnDistanceChanged' } },
  ],
  events: [
    { name: 'OnDistanceChanged', category: 'Behavior', args: 'ValueChangedEventArgs',
      doc: 'Occurs when the bar is moved.', docFr: 'Se produit quand la barre est déplacée.',
      from: { prop: 'onDistanceChange', args: 'value' } },
  ],
  inheritedMap: { AccessibleName: { prop: 'aria-label' }, Class: { prop: 'className' } },
  designDefaults: { size: [480, 240] },
  web: { module: '@ui', export: 'Splitter', domRoot: 'ref', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof Splitter>>

// ── Text fields ──

export const SearchFieldMeta = {
  name: 'SearchField',
  doc: 'A search box with a clear button. On the web, Escape clears it and Enter raises OnSearch.',
  docFr: 'Champ de recherche avec un bouton pour l\'effacer.',
  family: 'text',
  baseChain: ['SearchField', 'TextBoxBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnTextChanged',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'The searched text.', docFr: 'Texte recherché.', to: { prop: 'value', change: 'OnTextChanged' } },
    { name: 'Placeholder', kind: 'String', default: '', category: 'Appearance',
      doc: 'Hint shown while the field is empty.', docFr: 'Indication affichée tant que le champ est vide.',
      to: { prop: 'placeholder' } },
  ],
  events: [
    { name: 'OnTextChanged', category: 'Property Changed', args: 'ValueChangedEventArgs', aliases: ['OnChanged'],
      doc: 'Occurs when the searched text changes.', docFr: 'Se produit quand le texte recherché change.',
      from: { prop: 'onChange', args: 'value' } },
    { name: 'OnSearch', category: 'Action', args: 'ValueChangedEventArgs',
      doc: 'Web only: occurs when Enter asks for the search now (the text is the value).',
      docFr: 'Web uniquement : se produit quand Entrée demande la recherche tout de suite (le texte est la valeur).',
      from: { prop: 'onSearch', args: 'value' } },
  ],
  inheritedMap: {
    Enabled: { prop: 'disabled', convert: 'invert' },
    ReadOnly: { prop: 'readOnly' },
    MaxLength: { prop: 'maxLength' },
    AccessibleName: { prop: 'aria-label' },
    Class: { prop: 'className' },
  },
  designDefaults: { attributes: { Placeholder: 'Rechercher' }, size: [240, 36] },
  web: { module: '@ui', export: 'SearchField', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof SearchField>>

export const MaskedFieldMeta = {
  name: 'MaskedField',
  doc: 'A text box that follows an input mask, for example 00/00/0000 (0 digit, 9 optional digit, L letter, ? optional letter, A / a letter or digit, & / C any character, \\ before a literal).',
  docFr: 'Zone de texte qui suit un masque de saisie, par exemple 00/00/0000.',
  family: 'text',
  baseChain: ['MaskedField', 'TextBoxBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnTextChanged',
  properties: [
    { name: 'Mask', kind: 'String', default: '', category: 'Appearance',
      doc: 'Input mask, for example 00/00/0000 for a date.', docFr: 'Masque de saisie, par exemple 00/00/0000 pour une date.',
      to: { prop: 'mask' } },
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text in the field (with the mask\'s literals).', docFr: 'Texte contenu dans le champ.',
      to: { prop: 'value', change: 'OnTextChanged' } },
    { name: 'Invalid', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'Shows the field in the error colour.', docFr: "Affiche le champ dans la couleur d'erreur.",
      to: { prop: 'invalid' } },
  ],
  events: [
    { name: 'OnTextChanged', category: 'Property Changed', args: 'ValueChangedEventArgs', aliases: ['OnChanged'],
      doc: 'Occurs when the text changes.', docFr: 'Se produit quand le texte change.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: {
    Enabled: { prop: 'disabled', convert: 'invert' },
    ReadOnly: { prop: 'readOnly' },
    AccessibleName: { prop: 'aria-label' },
    Class: { prop: 'className' },
  },
  designDefaults: { attributes: { Mask: '00/00/0000' }, size: [160, 36] },
  web: { module: '@ui', export: 'MaskedField', domRoot: 'ref' },
} as const satisfies ElementMeta<ComponentProps<typeof MaskedField>>

// ── PaintBox ──

export const PaintBoxMeta = {
  name: 'PaintBox',
  doc: 'A drawing surface: your OnPaint handler draws on it. On the web a <canvas>: e.ctx is its 2D context in CSS pixels (e.width, e.height, e.dpr); it is repainted on resize, on a pixel-ratio change and when PaintData changes.',
  docFr: 'Surface de dessin : votre gestionnaire OnPaint y dessine.',
  family: 'display',
  baseChain: ['PaintBox', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnPaint',
  properties: [
    { name: 'PaintData', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'object', webOnly: true,
      doc: 'Web only: what the drawing depends on (a binding); a new value repaints the surface, and it is e.data in OnPaint.',
      docFr: 'Web uniquement : ce dont dépend le dessin (une liaison) ; une nouvelle valeur redessine la surface, et elle est e.data dans OnPaint.',
      to: { prop: 'data' } },
  ],
  events: [
    { name: 'OnPaint', category: 'Appearance', args: 'PaintEventArgs',
      doc: 'Occurs when the surface is drawn: draw with e.ctx (CSS pixels) in e.width × e.height.',
      docFr: 'Se produit quand la surface est dessinée : dessinez avec e.graphics() dans e.clip_rectangle.',
      from: { prop: 'onPaint', args: 'paint' } },
  ],
  inheritedMap: { AccessibleName: { prop: 'aria-label' }, Class: { prop: 'className' } },
  designDefaults: { size: [240, 150] },
  web: { module: '@ui', export: 'PaintBox', domRoot: 'ref' },
} as const satisfies ElementMeta<ComponentProps<typeof PaintBox>>
