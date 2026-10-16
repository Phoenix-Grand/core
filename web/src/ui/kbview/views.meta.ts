/**
 * Layout and runtime elements rendered by the views runtime itself (`@kubuno/views`, WV-5a): `UserControl`,
 * `Panel`, `Stack`, `ScrollArea` and `Repeater`. Names, kinds, defaults and documentation follow the desktop
 * registry (VIEWS-SPEC §2, §5); the web-only members are allowlisted with their reason.
 */
import type { ComponentProps } from 'react'
import type { Panel, ScrollArea, Stack, TableLayoutPanel, UserControl } from '../../views/layout'
import type { ReactHost, Repeater } from '../../views/controls'
import type { ElementMeta, PropertyMeta } from './types.ts'

const CONTAINER_CHAIN = ['ContainerBase', 'ScrollableControl', 'Control', 'Component'] as const

/** `AccessibleRole` → the ARIA role a container renders (`PushButton` → a native `<button>`). */
const ARIA_ROLES = {
  Default: '', None: 'none', TitleBar: 'banner', MenuBar: 'menubar', ScrollBar: 'scrollbar', Grip: 'separator',
  Sound: 'none', Cursor: 'none', Caret: 'none', Alert: 'alert', Window: 'dialog', Client: 'region',
  MenuPopup: 'menu', MenuItem: 'menuitem', ToolTip: 'tooltip', Application: 'application', Document: 'document',
  Pane: 'region', Chart: 'img', Dialog: 'dialog', Border: 'none', Grouping: 'group', Separator: 'separator',
  ToolBar: 'toolbar', StatusBar: 'status', Table: 'table', ColumnHeader: 'columnheader', RowHeader: 'rowheader',
  Column: 'gridcell', Row: 'row', Cell: 'cell', Link: 'link', HelpBalloon: 'tooltip', Character: 'none',
  List: 'list', ListItem: 'listitem', Outline: 'tree', OutlineItem: 'treeitem', PageTab: 'tab',
  PropertyPage: 'tabpanel', Indicator: 'img', Graphic: 'img', StaticText: 'note', Text: 'textbox',
  PushButton: 'button', CheckButton: 'checkbox', RadioButton: 'radio', ComboBox: 'combobox', DropList: 'listbox',
  ProgressBar: 'progressbar', Dial: 'slider', HotkeyField: 'textbox', Slider: 'slider', SpinButton: 'spinbutton',
  Diagram: 'img', Animation: 'img', Equation: 'math', ButtonDropDown: 'button', ButtonMenu: 'button',
  ButtonDropDownGrid: 'button', WhiteSpace: 'none', PageTabList: 'tablist', Clock: 'timer', SplitButton: 'button',
  IpAddress: 'textbox', OutlineButton: 'button',
} as const

const SURFACE: PropertyMeta<{ surface?: 'None' | 'Layer' | 'Card' | 'Raised' | 'Well' }> = {
  name: 'Surface', kind: { Enum: ['None', 'Layer', 'Card', 'Raised', 'Well'] }, default: 'None', category: 'Appearance',
  doc: 'Background painted behind the children: a theme surface.',
  docFr: 'Fond peint derrière les éléments enfants.',
  to: { prop: 'surface', values: { None: 'None', Layer: 'Layer', Card: 'Card', Raised: 'Raised', Well: 'Well' } },
}

const HREF: PropertyMeta<{ href?: string }> = {
  name: 'Href', kind: 'String', default: '', category: 'Behavior', bindable: true, webOnly: true,
  doc: 'Web only: the container is a link to this address. A plain click stays in the app (OnClick decides); a middle or modified click opens the address.',
  docFr: "Web uniquement : le conteneur est un lien vers cette adresse. Un clic simple reste dans l'application (OnClick décide) ; un clic du milieu ou avec une touche de modification ouvre l'adresse.",
  to: { prop: 'href' },
}

/** How every runtime container maps the inherited members it renders itself. */
const CONTAINER_INHERITED = {
  Enabled: { prop: 'disabled', convert: 'invert' },
  AccessibleName: { prop: 'aria-label' },
  AccessibleRole: { prop: 'role', values: ARIA_ROLES },
  TabIndex: { prop: 'tabIndex' },
  // Given to the element as its className (kept by React across renders, merged with its own classes).
  Class: { prop: 'className' },
  // A container clips its children to its corners (a card of hoverable rows).
  CornerRadius: { prop: 'cornerRadius' },
} as const

const DIVIDER: PropertyMeta<{ dividerColor?: string }> = {
  name: 'DividerColor', kind: 'String', default: '', category: 'Appearance', editor: 'color', typeConverter: 'Color', bindable: true, webOnly: true,
  doc: 'Web only: draws a line of this colour between two children (under each child but the last; between them across a row). Leave empty for none.',
  docFr: "Web uniquement : trace une ligne de cette couleur entre deux enfants (sous chaque enfant sauf le dernier ; entre eux dans une rangée). Laisser vide pour aucune.",
  to: { prop: 'dividerColor' },
}

/** Web-only: the HTML element of a container (WV-11: a migrated screen keeps its sections, forms and lists - the accessibility tree reads them). */
const CONTAINER_TAGS = ['Div', 'Section', 'Nav', 'Header', 'Footer', 'Main', 'Aside', 'Article', 'Form', 'Fieldset', 'Figure', 'Ul', 'Ol', 'Li', 'Label', 'Span', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'] as const
const CONTAINER_TAG: PropertyMeta<{ as?: string }> = {
  name: 'HtmlTag', kind: { Enum: CONTAINER_TAGS }, default: 'Div', category: 'Accessibility', webOnly: true,
  doc: 'Web only: the HTML element of the container - a section, a navigation, a form (OnSubmit), a list and its items… Screen readers announce it.',
  docFr: "Web uniquement : l'élément HTML du conteneur - une section, une navigation, un formulaire (OnSubmit), une liste et ses éléments… Les lecteurs d'écran l'annoncent.",
  to: { prop: 'as', values: Object.fromEntries(CONTAINER_TAGS.map((t) => [t, t.toLowerCase()])) as Record<(typeof CONTAINER_TAGS)[number], string> },
}

/** Web `DataAttributes`: the container's `data-*` attributes (the shell's styles and scripts find it by them). */
const DATA_ATTRIBUTES: PropertyMeta<{ dataAttributes?: string }> = {
  name: 'DataAttributes', kind: 'String', default: '', category: 'Behavior', bindable: true, webOnly: true,
  doc: 'Web only: data-* attributes of the element, separated by semicolons - a name (app-chrome) or name=value (panel=right). Styles and scripts of the page find the element by them.',
  docFr: "Web uniquement : attributs data-* de l'élément, séparés par des points-virgules - un nom (app-chrome) ou nom=valeur (panel=right). Les styles et scripts de la page retrouvent l'élément par eux.",
  to: { prop: 'dataAttributes' },
}

/** `AutoSize` of a container: sized to its content (a push-button container like a native button) instead of filling its line. */
const AUTO_SIZE: PropertyMeta<{ autoSize?: boolean }> = {
  name: 'AutoSize', kind: 'Bool', default: 'false', category: 'Layout',
  doc: 'Sizes the container to its content instead of filling its line (a container with AccessibleRole="PushButton" then sizes like a native button).',
  docFr: 'Dimensionne le conteneur selon son contenu au lieu de remplir sa ligne (un conteneur AccessibleRole="PushButton" se dimensionne alors comme un bouton natif).',
  to: { prop: 'autoSize' },
}

/** Web-only: `aria-modal` of a dialog container. */
const ACCESSIBLE_MODAL: PropertyMeta<{ 'aria-modal'?: boolean }> = {
  name: 'AccessibleModal', kind: 'Bool', default: 'false', category: 'Accessibility', webOnly: true,
  doc: 'Web only: the container is a modal dialog (with AccessibleRole="Dialog"): screen readers stay inside it.',
  docFr: "Web uniquement : le conteneur est un dialogue modal (avec AccessibleRole=\"Dialog\") : les lecteurs d'écran restent à l'intérieur.",
  to: { prop: 'aria-modal' },
}

/** Web-only: a container that is a form (`HtmlTag="Form"`) raises OnSubmit (Enter in one of its fields, a Submit button). */
const ON_SUBMIT = {
  name: 'OnSubmit', category: 'Action', args: 'EventArgs',
  doc: 'Web only: occurs when the form is submitted (HtmlTag="Form": Enter in one of its fields, a button with ButtonType="Submit"). The handler calls e.native.preventDefault() to stay on the page.',
  docFr: 'Web uniquement : se produit quand le formulaire est envoyé (HtmlTag="Form" : Entrée dans un de ses champs, un bouton ButtonType="Submit"). Le gestionnaire appelle e.native.preventDefault() pour rester sur la page.',
  from: { dom: 'submit', args: 'dom' },
} as const

const DOCK_LAYOUT: PropertyMeta<{ layout?: 'Dock' | 'Absolute' }> = {
  name: 'Layout', kind: { Enum: ['Dock', 'Absolute'] }, default: 'Dock', category: 'Layout', webOnly: true,
  doc: 'Web: Dock lays the children out as bands (Dock), Absolute places them by X and Y (the desktop designer\'s free positioning).',
  docFr: 'Web : Dock dispose les enfants en bandes (Dock), Absolute les place par X et Y (le placement libre du concepteur desktop).',
  to: { prop: 'layout', values: { Dock: 'Dock', Absolute: 'Absolute' } },
}

export const UserControlMeta = {
  name: 'UserControl',
  doc: 'The root of a user control (.kbcontrol): a composite control designed as a view and used as an element of other views. Its children are docked like a Panel\'s.',
  docFr: "Racine d'un contrôle utilisateur (.kbcontrol) : un contrôle composite conçu comme une vue et utilisé comme élément d'autres vues. Ses enfants sont ancrés comme ceux d'un Panel.",
  family: 'containers',
  baseChain: ['UserControl', 'ContainerControl', 'ScrollableControl', 'Control', 'Component'],
  children: 'List',
  layoutKind: 'DockAnchor',
  defaultEvent: 'OnClick',
  properties: [SURFACE, DOCK_LAYOUT],
  events: [],
  inheritedMap: CONTAINER_INHERITED,
  designDefaults: { size: [320, 240] },
  web: { module: '@kubuno/views', export: 'UserControl', domRoot: 'ref', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof UserControl>>

export const PanelMeta = {
  name: 'Panel',
  doc: 'A container whose children are docked as bands (Dock: Top, Bottom, Left, Right, then Fill takes the rest), or placed by X and Y with Layout="Absolute".',
  docFr: 'Conteneur dont les enfants sont ancrés en bandes (Dock : Top, Bottom, Left, Right, puis Fill prend le reste), ou placés par X et Y avec Layout="Absolute".',
  family: 'containers',
  baseChain: ['Panel', ...CONTAINER_CHAIN],
  children: 'List',
  layoutKind: 'DockAnchor',
  defaultEvent: 'OnClick',
  properties: [SURFACE, DOCK_LAYOUT, HREF, DIVIDER, CONTAINER_TAG, ACCESSIBLE_MODAL, AUTO_SIZE, DATA_ATTRIBUTES],
  events: [ON_SUBMIT],
  inheritedMap: CONTAINER_INHERITED,
  designDefaults: { size: [200, 100] },
  web: { module: '@kubuno/views', export: 'Panel', domRoot: 'ref', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof Panel>>

export const StackMeta = {
  name: 'Stack',
  doc: 'Places its children one after the other along a direction, Gap pixels apart; a child with Stack.Fill="true" takes the room left.',
  docFr: "Place ses enfants les uns après les autres dans une direction, espacés de Gap pixels ; un enfant avec Stack.Fill=\"true\" prend la place restante.",
  family: 'core',
  baseChain: ['Stack', ...CONTAINER_CHAIN],
  children: 'List',
  layoutKind: 'Flow',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Direction', kind: { Enum: ['LeftToRight', 'TopDown', 'RightToLeft', 'BottomUp'] }, default: 'TopDown', category: 'Layout',
      doc: 'Direction in which the children are placed. On the web LeftToRight follows the reading direction (it mirrors in Arabic and Hebrew).',
      docFr: 'Sens dans lequel les éléments enfants sont placés.',
      to: { prop: 'direction' } },
    { name: 'Gap', kind: 'F32', default: '8', category: 'Layout',
      doc: 'Space between two children, in pixels.', docFr: 'Espace entre deux éléments enfants, en pixels.',
      to: { prop: 'gap' } },
    SURFACE,
    { name: 'WrapContents', kind: 'Bool', default: 'false', category: 'Layout',
      doc: 'Wraps the children onto several lines (or columns) when they do not fit, like a FlowLayoutPanel.',
      docFr: 'Renvoie les enfants sur plusieurs lignes (ou colonnes) quand ils ne tiennent pas, comme un FlowLayoutPanel.',
      to: { prop: 'wrap' } },
    { name: 'CrossAlign', kind: { Enum: ['Stretch', 'Start', 'Center', 'End'] }, default: 'Stretch', category: 'Layout',
      doc: 'Places the children across the flow: stretched over the line (or column), or at their own size at its start, centre or end.',
      docFr: 'Place les enfants en travers du flux : étirés sur la ligne (ou la colonne), ou à leur propre taille au début, au centre ou à la fin.',
      to: { prop: 'crossAlign' } },
    { name: 'Justify', kind: { Enum: ['Start', 'Center', 'End', 'SpaceBetween'] }, default: 'Start', category: 'Layout', webOnly: true,
      doc: 'Web only: where the children sit along the flow when they leave room: at its start, centred, at its end, or spread with the room between them.',
      docFr: "Web uniquement : place des enfants le long du flux quand ils laissent de la place : au début, centrés, à la fin, ou répartis avec la place entre eux.",
      to: { prop: 'justify' } },
    HREF,
    DIVIDER,
    CONTAINER_TAG,
    ACCESSIBLE_MODAL,
    AUTO_SIZE,
    DATA_ATTRIBUTES,
  ],
  events: [ON_SUBMIT],
  inheritedMap: CONTAINER_INHERITED,
  designDefaults: { size: [200, 100] },
  web: { module: '@kubuno/views', export: 'Stack', domRoot: 'ref', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof Stack>>

export const ScrollAreaMeta = {
  name: 'ScrollArea',
  doc: 'Shows its single child in a scrolling viewport.',
  docFr: 'Affiche son élément enfant dans une zone qui défile.',
  family: 'containers',
  baseChain: ['ScrollArea', 'ScrollableControl', 'Control', 'Component'],
  children: 'SingleWidget',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Corner', kind: 'F32', default: '0', category: 'Appearance',
      doc: 'Radius of the rounded corners, in pixels. 0 for square corners.',
      docFr: 'Rayon des coins arrondis, en pixels. 0 pour des coins carrés.',
      to: { prop: 'corner' } },
    { name: 'ScrollBars', kind: { Enum: ['Vertical', 'Horizontal', 'Both'] }, default: 'Vertical', category: 'Behavior', webOnly: true,
      doc: 'Web only: the directions the content scrolls in.',
      docFr: 'Web uniquement : les directions dans lesquelles le contenu défile.',
      to: { prop: 'scrollBars', values: { Vertical: 'Vertical', Horizontal: 'Horizontal', Both: 'Both' } } },
    { name: 'ScrollbarGutter', kind: { Enum: ['Auto', 'Stable', 'StableBothEdges'] }, default: 'Auto', category: 'Layout', webOnly: true,
      doc: 'Web only: room kept for the scroll bar whether it shows or not (Stable), on both edges so the content stays centred (StableBothEdges).',
      docFr: "Web uniquement : place réservée à la barre de défilement qu'elle soit affichée ou non (Stable), des deux côtés pour que le contenu reste centré (StableBothEdges).",
      to: { prop: 'gutter', values: { Auto: 'Auto', Stable: 'Stable', StableBothEdges: 'StableBothEdges' } } },
    { name: 'ScrollBarStyle', kind: { Enum: ['Default', 'Inset'] }, default: 'Default', category: 'Appearance', webOnly: true,
      doc: 'Web only: the look of the scroll bar. Inset: a thin bar that starts and ends inside rounded corners (menus, popovers).',
      docFr: 'Web uniquement : aspect de la barre de défilement. Inset : une barre fine qui commence et finit à l\'intérieur des coins arrondis (menus, panneaux surgissants).',
      to: { prop: 'scrollBarStyle', values: { Default: 'Default', Inset: 'Inset' } } },
  ],
  events: [],
  inheritedMap: { AccessibleName: { prop: 'aria-label' }, AccessibleRole: { prop: 'role', values: ARIA_ROLES }, TabIndex: { prop: 'tabIndex' }, Class: { prop: 'className' }, CornerRadius: { prop: 'corner' } },
  designDefaults: { size: [240, 160] },
  web: { module: '@kubuno/views', export: 'ScrollArea', domRoot: 'ref', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof ScrollArea>>

export const RepeaterMeta = {
  name: 'Repeater',
  doc: 'Repeats its child element once per item of ItemsSource; bindings inside it read the item first. On the web the items are laid out by the Repeater\'s container.',
  docFr: "Répète son élément enfant une fois par élément d'ItemsSource ; les liaisons à l'intérieur lisent d'abord l'élément. Sur le web, les éléments sont disposés par le conteneur du Repeater.",
  family: 'data',
  baseChain: ['Repeater', 'Control', 'Component'],
  children: 'SingleWidget',
  defaultEvent: null,
  properties: [
    { name: 'ItemsSource', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'list',
      doc: 'The items shown, one element each: a binding to a list.',
      docFr: 'Lignes affichées, un élément chacune : une liaison vers une liste.',
      to: { runtime: 'item-state' } },
    { name: 'ItemKey', kind: 'String', default: '', category: 'Data',
      doc: 'Field of an item that identifies it when the list changes (an id); empty for the position.',
      docFr: "Champ de la ligne qui identifie un élément quand la liste change (un identifiant) ; vide pour la position.",
      to: { runtime: 'item-state' } },
    { name: 'DesignItemCount', kind: 'F32', default: '3', category: 'Design', designTime: true,
      doc: 'Number of sample items the designer shows when the list has no rows at design time.',
      docFr: "Nombre d'éléments d'exemple que le concepteur affiche quand la liste n'a pas de lignes à la conception.",
      to: { runtime: 'design' } },
  ],
  events: [],
  designDefaults: { size: [240, 160] },
  web: { module: '@kubuno/views', export: 'Repeater', domRoot: 'none', content: 'children', template: true },
} as const satisfies ElementMeta<ComponentProps<typeof Repeater>>

/**
 * `ReactHost` (web only): any React component, rendered as it is - the migration's escape hatch for what is not a
 * view yet (WEB-VIEWS §2.3): the codemod cuts such parts out with their values as `Props`.
 */
export const ReactHostMeta = {
  name: 'ReactHost',
  doc: 'Web only: renders a React component given by a binding (Component), with the props of another binding (Props). The migration keeps there what is not a view yet.',
  docFr: "Web uniquement : affiche un composant React donné par une liaison (Component), avec les props d'une autre liaison (Props). La migration y garde ce qui n'est pas encore une vue.",
  family: 'data',
  baseChain: ['ReactHost', 'Control', 'Component'],
  children: 'None',
  defaultEvent: null,
  properties: [
    { name: 'Component', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'object',
      doc: 'The React component rendered: a binding to a field or getter of the code-behind holding it.',
      docFr: 'Le composant React affiché : une liaison vers un champ ou un accesseur du code-behind qui le contient.',
      to: { prop: 'component' } },
    { name: 'Props', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'object',
      doc: 'The props given to the component: a binding to an object (memoize it: a new object on every read re-renders the component).',
      docFr: 'Les props données au composant : une liaison vers un objet (à mémoïser : un nouvel objet à chaque lecture redessine le composant).',
      to: { prop: 'props' } },
  ],
  events: [],
  inheritedMap: {},
  designDefaults: { size: [240, 120] },
  web: { module: '@kubuno/views', export: 'ReactHost', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof ReactHost>>

export const TableLayoutPanelMeta = {
  name: 'TableLayoutPanel',
  doc: 'A grid: its children are placed in rows and columns sized in pixels, in shares of the room left, or to their content. On the web, a CSS grid whose columns follow the reading direction.',
  docFr: 'Grille : ses enfants sont placés en lignes et en colonnes dimensionnées en pixels, en parts de la place restante, ou selon leur contenu.',
  family: 'containers',
  baseChain: ['TableLayoutPanel', ...CONTAINER_CHAIN],
  children: 'List',
  layoutKind: 'Flow',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'ColumnCount', kind: 'F32', default: '2', category: 'Layout',
      doc: 'The number of columns.', docFr: 'Nombre de colonnes.', to: { prop: 'columnCount' } },
    { name: 'RowCount', kind: 'F32', default: '2', category: 'Layout',
      doc: 'The number of rows (more are added when the children need them, with GrowStyle AddRows).',
      docFr: "Nombre de lignes (d'autres sont ajoutées quand les enfants en ont besoin, avec GrowStyle AddRows).",
      to: { prop: 'rowCount' } },
    { name: 'ColumnStyles', kind: 'String', default: '', category: 'Layout',
      doc: 'How each column is sized, separated by semicolons: Absolute 120, Percent 50 or AutoSize. A missing one is Percent 1 (an equal share).',
      docFr: 'Dimensionnement de chaque colonne, séparé par des points-virgules : Absolute 120, Percent 50 ou AutoSize. Une colonne sans style reçoit Percent 1 (une part égale).',
      to: { prop: 'columnStyles' } },
    { name: 'RowStyles', kind: 'String', default: '', category: 'Layout',
      doc: 'How each row is sized, separated by semicolons: Absolute 40, Percent 50 or AutoSize. A missing one is AutoSize.',
      docFr: 'Dimensionnement de chaque ligne, séparé par des points-virgules : Absolute 40, Percent 50 ou AutoSize. Une ligne sans style est AutoSize.',
      to: { prop: 'rowStyles' } },
    { name: 'GrowStyle', kind: { Enum: ['AddRows', 'AddColumns', 'FixedSize'] }, default: 'AddRows', category: 'Layout',
      doc: 'What happens when the children do not fit the declared grid.',
      docFr: 'Ce qui se passe quand les enfants ne tiennent pas dans la grille déclarée.',
      to: { prop: 'growStyle', values: { AddRows: 'AddRows', AddColumns: 'AddColumns', FixedSize: 'FixedSize' } } },
    { name: 'CellBorderStyle', kind: { Enum: ['None', 'Single'] }, default: 'None', category: 'Appearance',
      doc: 'Lines drawn around and between the cells.', docFr: 'Lignes dessinées autour des cellules et entre elles.',
      to: { prop: 'cellBorderStyle', values: { None: 'None', Single: 'Single' } } },
    { name: 'CellSpacing', kind: 'F32', default: '0', category: 'Layout',
      doc: 'Space between two cells, in pixels.', docFr: 'Espace entre deux cellules, en DIP.',
      to: { prop: 'cellSpacing' } },
  ],
  events: [],
  inheritedMap: CONTAINER_INHERITED,
  designDefaults: { size: [320, 160] },
  web: { module: '@kubuno/views', export: 'TableLayoutPanel', domRoot: 'ref', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof TableLayoutPanel>>
