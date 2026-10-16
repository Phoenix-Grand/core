/**
 * Workspace elements served by `@kubuno/sdk`: `WorkspaceShell` (an editor's frame) and
 * `DockArea` with its `DockPanel` items - the desktop's `docking` family was ported from these.
 * Names, kinds, defaults and documentation follow the desktop registry (VIEWS-SPEC §2, §9).
 */
import type { ComponentProps } from 'react'
import type { DockArea, DockPanel, WorkspaceShell } from '../../core/shell/workspace'
import type { ElementMeta } from '../../ui/kbview/types.ts'
import { ICON_PROPERTIES } from '../../ui/kbview/levels.ts'

const CONTAINER_CHAIN = ['ContainerBase', 'ScrollableControl', 'Control', 'Component'] as const

export const DockAreaMeta = {
  name: 'DockArea',
  doc: 'A work area surrounded by panels the user can dock left or right, group as tabs, split, float, resize, close and reopen. Add the panels as DockPanel children; one other child is the content of the central area.',
  docFr: "Zone de travail entourée de panneaux que l'utilisateur peut ancrer à gauche ou à droite, regrouper en onglets, empiler, détacher en fenêtres flottantes, redimensionner, fermer et rouvrir. Ajoutez les panneaux comme éléments DockPanel enfants ; un autre élément enfant est le contenu de la zone centrale.",
  family: 'docking',
  baseChain: ['DockArea', ...CONTAINER_CHAIN],
  children: 'List',
  allowedChildren: ['DockPanel'],
  // The desktop's default (OnPanelActivated) is not available on the web yet (WV-5b).
  defaultEvent: null,
  properties: [
    { name: 'StorageKey', kind: 'String', default: '', category: 'Misc',
      doc: "Key under which the user's layout is saved and restored; empty to keep no layout between runs.",
      docFr: "Clé sous laquelle la disposition choisie par l'utilisateur est enregistrée et restaurée ; vide pour ne rien conserver d'une exécution à l'autre.",
      to: { prop: 'storageKey' } },
    { name: 'ViewportColor', kind: 'String', default: '', category: 'Misc',
      doc: "Background colour of the central area (#RRGGBB); empty for the application's background.",
      docFr: "Couleur de fond de la zone centrale (#RRVVBB) ; vide pour le fond de l'application.",
      to: { prop: 'viewportBg' } },
    { name: 'PanelsHidden', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'Hides the panels and shows the central area alone, full size.',
      docFr: 'Masque les panneaux et affiche la zone centrale seule, en pleine taille.',
      to: { prop: 'hidden' } },
  ],
  events: [],
  designDefaults: { size: [800, 480] },
  web: {
    module: '@kubuno/sdk', export: 'DockArea', domRoot: 'wrapper', content: 'children',
    childrenToProp: { prop: 'panels', shape: 'record', item: 'DockPanel', content: { field: 'render' }, key: 'id' },
  },
} as const satisfies ElementMeta<ComponentProps<typeof DockArea>>

export const DockPanelMeta = {
  name: 'DockPanel',
  doc: 'A panel of a DockArea: a tab the user can move, dock, float or close, and one child element as its content.',
  docFr: "Panneau d'une DockArea : un onglet que l'utilisateur peut déplacer, ancrer, détacher ou fermer, et un élément enfant comme contenu.",
  family: 'docking',
  baseChain: ['DockPanel', 'Component'],
  children: 'SingleWidget',
  defaultEvent: null,
  properties: [
    { name: 'Title', kind: 'String', default: '', category: 'Appearance',
      doc: "Text of the panel's tab.", docFr: "Texte de l'onglet du panneau.", to: { prop: 'label' } },
    // The tab's label is composed with the icon by the adapter (`DockPanel.label` is a node).
    { name: 'Icon', kind: 'String', default: '', category: 'Icon', editor: 'icon',
      doc: 'Icon shown before the title: a name of the Kubuno icon set, or an image file (SVG, PNG…) relative to the view.',
      docFr: "Icône affichée avant le titre : un nom du jeu d'icônes Kubuno, ou un fichier image (SVG, PNG…) relatif à la vue.",
      to: { runtime: 'item-state' } },
    // `Side`, `Group` and `Active` build the DockArea's `defaultArrangement`.
    { name: 'Side', kind: { Enum: ['Right', 'Left', 'Float'] }, default: 'Right', category: 'Misc',
      doc: 'Where the panel is docked by default.', docFr: 'Côté où le panneau est ancré par défaut.',
      to: { runtime: 'item-state' } },
    { name: 'Group', kind: 'String', default: '', category: 'Misc',
      doc: 'Panels of the same side with the same group share one tab group; empty for a group of its own.',
      docFr: "Les panneaux d'un même côté ayant le même groupe partagent un groupe d'onglets ; vide pour un groupe à lui seul.",
      to: { runtime: 'item-state' } },
    { name: 'Active', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'Shows this panel first in its tab group.', docFr: "Affiche ce panneau en premier dans son groupe d'onglets.",
      to: { runtime: 'item-state' } },
    ...ICON_PROPERTIES,
  ],
  events: [],
  web: { module: null, export: null, domRoot: 'none', itemOf: ['DockArea'] },
} as const satisfies ElementMeta<DockPanel>

export const WorkspaceShellMeta = {
  name: 'WorkspaceShell',
  doc: "The frame of an editor: a top bar with the title, the editor's name and the document's details, an optional status bar, and one child element as its body (typically a DockArea).",
  docFr: "Cadre d'un éditeur : une barre supérieure avec le titre, le nom de l'éditeur et les détails du document, une barre d'état facultative, et un élément enfant comme corps (en général une DockArea).",
  family: 'docking',
  baseChain: ['WorkspaceShell', ...CONTAINER_CHAIN],
  children: 'SingleWidget',
  defaultEvent: 'OnBack',
  properties: [
    { name: 'Title', kind: 'String', default: '', category: 'Appearance',
      doc: "Title shown in the top bar (the document's name).", docFr: 'Titre affiché dans la barre supérieure (le nom du document).',
      to: { prop: 'title' } },
    { name: 'Icon', kind: 'String', default: '', category: 'Icon', editor: 'icon',
      doc: 'Icon shown before the title: a name of the Kubuno icon set, or an image file (SVG, PNG…) relative to the view.',
      docFr: "Icône affichée avant le titre : un nom du jeu d'icônes Kubuno, ou un fichier image (SVG, PNG…) relatif à la vue.",
      to: { prop: 'titleIcon', convert: 'icon-node' } },
    { name: 'Subtitle', kind: 'String', default: '', category: 'Appearance',
      doc: "Name of the editor, shown after the title in the accent colour.",
      docFr: "Nom de l'éditeur, affiché après le titre dans la couleur d'accent.",
      to: { prop: 'subtitle' } },
    { name: 'DocInfo', kind: 'String', default: '', category: 'Misc',
      doc: 'Details of the document shown after the subtitle (dimensions, page count…).',
      docFr: 'Détails du document affichés après le sous-titre (dimensions, nombre de pages…).',
      to: { prop: 'docInfo' } },
    { name: 'StatusText', kind: 'String', default: '', category: 'Misc',
      doc: 'Texts of the status bar, separated by a vertical bar (|); empty for no status bar.',
      docFr: "Textes de la barre d'état, séparés par « | » ; vide pour ne pas afficher de barre d'état.",
      to: { prop: 'statusBar', convert: 'status-text' } },
    { name: 'Theme', kind: { Enum: ['Default', 'Dark', 'Light', 'Office'] }, default: 'Default', category: 'Misc',
      doc: "Colours of the frame: the application's (light or dark), or a fixed palette.",
      docFr: 'Couleurs du cadre.',
      to: { prop: 'theme', convert: 'workspace-theme' } },
    { name: 'ShowBack', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'Shows the back arrow.', docFr: 'Affiche la flèche de retour.',
      to: { runtime: 'item-state' } },
    { name: 'ShowSearch', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'Shows the search button.', docFr: 'Affiche le bouton de recherche.',
      to: { prop: 'showSearch' } },
    { name: 'ShowDelete', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'Shows the delete button.', docFr: 'Affiche le bouton de suppression.',
      to: { runtime: 'item-state' } },
    ...ICON_PROPERTIES,
    { name: 'Chromeless', kind: 'Bool', default: 'false', category: 'Behavior', webOnly: true,
      doc: "Web only: hides the host's global header while the editor is shown and hosts its actions in the top bar.",
      docFr: "Web uniquement : masque l'en-tête global de l'hôte pendant l'affichage de l'éditeur et accueille ses actions dans la barre supérieure.",
      to: { prop: 'chromeless' } },
  ],
  events: [
    { name: 'OnBack', category: 'Action', args: 'EventArgs',
      doc: 'Occurs when the back arrow is clicked.', docFr: 'Se produit quand on clique sur la flèche de retour.',
      from: { prop: 'onBack', args: 'none' } },
    { name: 'OnDelete', category: 'Action', args: 'EventArgs',
      doc: 'Occurs when the delete button is clicked.', docFr: 'Se produit quand on clique sur le bouton de suppression.',
      from: { prop: 'onDelete', args: 'none' } },
  ],
  designDefaults: { size: [960, 600] },
  web: { module: '@kubuno/sdk', export: 'WorkspaceShell', domRoot: 'wrapper', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof WorkspaceShell>>
