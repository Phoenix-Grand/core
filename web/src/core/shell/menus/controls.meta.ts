/**
 * The core shell's own custom controls, as `.kbview` elements of the core project (WEB-VIEWS §4.5, module
 * isolation rule 2: a project's controls live in its own registry, never in the host's). Built by
 * `npm run build:registry` into `kbview-controls.json` next to this file, which `kubuno.views.json` lists.
 */
import type { ComponentProps } from 'react'
import type { ElementMeta } from '../../../ui/kbview/types.ts'
import type { AppTileGrid } from './AppTileGrid'
import type { MenuLink } from './MenuLink'
import type { WaffleButton } from './WaffleButton'
import type { AccountButton } from './AccountButton'

export const AppTileGridMeta = {
  name: 'AppTileGrid',
  doc: 'The app launcher\'s tiles: the favourites card (its header written as <AppTileGrid.Header>) over every other app, three to a row, with the drag-and-drop edit of the favourites.',
  docFr: "Les tuiles du lanceur d'applis : la carte des favoris (son en-tête écrit dans <AppTileGrid.Header>) au-dessus de toutes les autres applis, trois par ligne, avec la modification des favoris par glisser-déposer.",
  family: 'components',
  baseChain: ['AppTileGrid', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnTileInvoked',
  properties: [
    { name: 'Apps', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'list',
      doc: 'The apps of the launcher (a binding to a list of LauncherApp).', docFr: "Les applis du lanceur (une liaison vers une liste de LauncherApp).",
      to: { prop: 'apps' } },
    { name: 'Favorites', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'list',
      doc: 'The favourites shown on the card, in order (the draft while editing).', docFr: 'Les favoris affichés sur la carte, dans l\'ordre (le brouillon pendant la modification).',
      to: { prop: 'favorites' } },
    { name: 'Editing', kind: 'Bool', default: 'false', category: 'Behavior', bindable: true,
      doc: 'The favourites are being edited: tiles are dragged, a click adds or removes.', docFr: 'Les favoris sont en cours de modification : les tuiles se glissent, un clic ajoute ou retire.',
      to: { prop: 'editing' } },
    { name: 'DropHereText', kind: 'String', default: '', category: 'Appearance', localizable: true,
      doc: 'Text of the empty card while editing.', docFr: 'Texte de la carte vide pendant la modification.',
      to: { prop: 'dropHereText' } },
    { name: 'AllFavoritesText', kind: 'String', default: '', category: 'Appearance', localizable: true,
      doc: 'Text shown when every app is a favourite while editing.', docFr: 'Texte affiché quand toutes les applis sont des favoris pendant la modification.',
      to: { prop: 'allFavoritesText' } },
    { name: 'Header', kind: 'String', default: '', category: 'Appearance', serialization: 'Content', browsable: false,
      doc: 'The card\'s header band, written as a <AppTileGrid.Header> property element.', docFr: "La bande d'en-tête de la carte, écrite dans un élément de propriété <AppTileGrid.Header>.",
      to: { prop: 'header' } },
  ],
  events: [
    { name: 'OnTileInvoked', category: 'Action', args: 'ValueChangedEventArgs',
      doc: 'Occurs when an app\'s tile is clicked outside the edit mode: e.value is its id.', docFr: "Se produit quand on clique sur la tuile d'une appli hors modification : e.value est son identifiant.",
      from: { prop: 'onTileInvoked', args: 'value' } },
    { name: 'OnFavoritesEdited', category: 'Action', args: 'ValueChangedEventArgs',
      doc: 'Occurs when the favourites being edited change: e.value is the new list.', docFr: 'Se produit quand les favoris en cours de modification changent : e.value est la nouvelle liste.',
      from: { prop: 'onFavoritesEdited', args: 'value' } },
  ],
  designDefaults: { size: [342, 400] },
  web: { module: './AppTileGrid', export: 'AppTileGrid', domRoot: 'wrapper', slots: { Header: 'header' } },
} as const satisfies ElementMeta<ComponentProps<typeof AppTileGrid>>

export const MenuLinkMeta = {
  name: 'MenuLink',
  doc: 'A link that is an item of the menu hosting the view (the arrow keys reach it, choosing it closes the menu); a plain link elsewhere.',
  docFr: "Lien qui est un élément du menu qui accueille la vue (les flèches l'atteignent, le choisir ferme le menu) ; un lien ordinaire ailleurs.",
  family: 'components',
  baseChain: ['MenuLink', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance', localizable: true,
      doc: 'Text of the link.', docFr: 'Texte du lien.', to: { prop: 'text' } },
    { name: 'Href', kind: 'String', default: '', category: 'Behavior', bindable: true,
      doc: 'The address of the link (middle click, open in a new tab); a plain click raises OnClick.', docFr: "L'adresse du lien (clic du milieu, ouvrir dans un nouvel onglet) ; un clic simple déclenche OnClick.",
      to: { prop: 'href' } },
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'MouseEventArgs',
      doc: 'Occurs when the link is chosen.', docFr: 'Se produit quand le lien est choisi.',
      from: { prop: 'onClick', args: 'mouse' } },
  ],
  designDefaults: { attributes: { Text: 'Lien' }, size: [200, 36] },
  web: { module: './MenuLink', export: 'MenuLink', domRoot: 'ref' },
} as const satisfies ElementMeta<ComponentProps<typeof MenuLink>>

export const WaffleButtonMeta = {
  name: 'WaffleButton',
  doc: 'The header\'s app-launcher button: opens the WaffleMenu in a popover above the page, anchored to the button.',
  docFr: "Le bouton du lanceur d'applis de l'en-tête : ouvre le WaffleMenu dans une fenêtre surgissante au-dessus de la page, ancrée au bouton.",
  family: 'components',
  baseChain: ['WaffleButton', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnOpenChanged',
  properties: [
    { name: 'Apps', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'list',
      doc: 'The apps of the active modules.', docFr: 'Les applis des modules actifs.', to: { prop: 'allApps' } },
    { name: 'Dark', kind: 'Bool', default: 'false', category: 'Appearance',
      doc: 'For a dark title bar: a light glyph and a translucent hover.', docFr: 'Pour une barre de titre sombre : un glyphe clair et un survol translucide.',
      to: { prop: 'dark' } },
    { name: 'Fab', kind: 'Bool', default: 'false', category: 'Appearance',
      doc: 'The mobile floating action button (bottom-right, opening upwards).', docFr: "Le bouton d'action flottant mobile (en bas à droite, s'ouvrant vers le haut).",
      to: { prop: 'fab' } },
  ],
  events: [
    { name: 'OnOpenChanged', category: 'Behavior', args: 'ValueChangedEventArgs',
      doc: 'Occurs when the launcher opens or closes: e.value says which.', docFr: "Se produit quand le lanceur s'ouvre ou se ferme : e.value dit lequel.",
      from: { prop: 'onOpenChange', args: 'value' } },
  ],
  designDefaults: { size: [36, 36] },
  web: { module: './WaffleButton', export: 'WaffleButton', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof WaffleButton>>

export const AccountButtonMeta = {
  name: 'AccountButton',
  doc: 'The header\'s avatar button: opens the AccountMenu in a popover above the page, anchored to the button.',
  docFr: "Le bouton d'avatar de l'en-tête : ouvre l'AccountMenu dans une fenêtre surgissante au-dessus de la page, ancrée au bouton.",
  family: 'components',
  baseChain: ['AccountButton', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnAddAccount',
  properties: [],
  events: [
    { name: 'OnAddAccount', category: 'Action', args: 'EventArgs',
      doc: 'Occurs when Add account (or Sign in on an expired session) asks for the add-account dialog.',
      docFr: "Se produit quand « Ajouter un compte » (ou « Connexion » sur une session expirée) demande la boîte d'ajout de compte.",
      from: { prop: 'onAddAccount', args: 'none' } },
  ],
  designDefaults: { size: [36, 36] },
  web: { module: './AccountButton', export: 'AccountButton', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof AccountButton>>

export const SHELL_CONTROLS = [AppTileGridMeta, MenuLinkMeta, WaffleButtonMeta, AccountButtonMeta] as const
