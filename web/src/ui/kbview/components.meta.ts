/**
 * Non-visual components and their items: `ContextMenu`/`MenuItem` (rendered with the `@ui`
 * `MenuDropdown` - the "menus = MenuDropdown" rule holds by construction) and `ToolTip`
 * (the options of the `@ui` `Tooltip` every element's `ToolTip` property uses).
 */
import type { ComponentProps } from 'react'
import type { MenuDropdown, MenuItem } from '../MenuDropdown'
import type { Tooltip } from '../Tooltip'
import type { ElementMeta } from './types.ts'
import { ICON_PROPERTIES } from './levels.ts'

const ITEMS_SOURCE_DOC = {
  doc: 'Commands added from a list when the menu opens (fields Text, Key, Icon, ShortcutKeys, Checked, Enabled, Danger, and Kind = Separator or Header); choosing one raises OnItemClicked with its key.',
  docFr: "Commandes ajoutées depuis une liste à l'ouverture du menu (champs Text, Key, Icon, ShortcutKeys, Checked, Enabled, Danger, et Kind = Separator ou Header) ; en choisir une déclenche OnItemClicked avec sa clé.",
} as const

export const ContextMenuMeta = {
  name: 'ContextMenu',
  doc: 'A menu shown when a control that names it in its ContextMenu property is right-clicked, when a button names it in its DropDownMenu property, or from code (show). Add its commands as MenuItem elements; MenuItem children make a sub-menu.',
  docFr: "Menu affiché quand on clique avec le bouton droit sur un contrôle qui le nomme dans sa propriété ContextMenu, quand on clique sur un bouton qui le nomme dans sa propriété DropDownMenu, ou depuis le code (show). Ajoutez ses commandes comme éléments MenuItem enfants ; des MenuItem enfants d'un MenuItem forment un sous-menu.",
  family: 'components',
  baseChain: ['ContextMenu', 'Component'],
  kind: 'component',
  children: 'List',
  allowedChildren: ['MenuItem'],
  defaultEvent: 'OnOpening',
  properties: [
    { name: 'ItemsSource', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'list', ...ITEMS_SOURCE_DOC,
      to: { prop: 'items', convert: 'items-source' } },
  ],
  events: [
    { name: 'OnOpening', category: 'Behavior', args: 'EventArgs',
      doc: 'Occurs when the menu is about to open.', docFr: "Se produit quand le menu va s'ouvrir.",
      from: { runtime: 'menu-open', args: 'none' } },
    { name: 'OnItemClicked', category: 'Action', args: 'ValueChangedEventArgs',
      doc: 'Occurs when a command made from ItemsSource is chosen: its key is the new text.',
      docFr: "Se produit quand une commande issue d'ItemsSource est choisie : sa clé est le nouveau texte.",
      from: { runtime: 'parent-adapter', args: 'value' } },
  ],
  web: { module: '@ui', export: 'MenuDropdown', domRoot: 'portal', childrenToProp: { prop: 'items', item: 'MenuItem', content: 'none', nested: 'items' } },
} as const satisfies ElementMeta<ComponentProps<typeof MenuDropdown>>

export const MenuItemMeta = {
  name: 'MenuItem',
  doc: 'A command of a menu. MenuItem children make it a sub-menu; a Text of a single dash (or Kind Separator) makes a separator line.',
  docFr: "Commande d'un menu. Des MenuItem enfants en font un sous-menu ; un texte fait d'un seul tiret (ou Kind Separator) crée une ligne de séparation.",
  family: 'components',
  baseChain: ['MenuItem', 'Component'],
  children: 'List',
  allowedChildren: ['MenuItem'],
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance', bindable: true, localizable: true,
      doc: 'Text of the command. An ampersand before a letter makes it its keyboard shortcut in the menu.',
      docFr: 'Texte de la commande. Une esperluette devant une lettre en fait le raccourci clavier dans le menu.',
      to: { prop: 'label' } },
    { name: 'Icon', kind: 'String', default: '', category: 'Icon', editor: 'icon',
      doc: 'Icon shown before the text: a name of the Kubuno icon set, or an image file (SVG, PNG…) relative to the view.',
      docFr: "Icône affichée avant le texte : un nom du jeu d'icônes Kubuno, ou un fichier image (SVG, PNG…) relatif à la vue.",
      to: { prop: 'icon', convert: 'icon-node' } },
    { name: 'Kind', kind: { Enum: ['Command', 'Separator', 'Header'] }, default: 'Command', category: 'Appearance',
      doc: 'A command, a separator line, or a section title.', docFr: 'Une commande, une ligne de séparation ou un titre de section.',
      to: { prop: 'type', values: { Command: 'action', Separator: 'separator', Header: 'label' } } },
    { name: 'Danger', kind: 'Bool', default: 'false', category: 'Appearance',
      doc: 'A destructive command, shown in the danger colour.', docFr: 'Commande destructrice, affichée dans la couleur de danger.',
      to: { prop: 'danger' } },
    { name: 'Enabled', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
      doc: 'Whether the command can be chosen.', docFr: 'Indique si la commande peut être choisie.',
      to: { prop: 'disabled', convert: 'invert' } },
    { name: 'Visible', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
      doc: 'Whether the command is shown.', docFr: 'Indique si la commande est affichée.',
      to: { runtime: 'visible' } },
    { name: 'Checked', kind: 'Bool', default: 'false', category: 'Appearance', bindable: true,
      doc: 'Shows a check mark before the command.', docFr: 'Affiche une coche devant la commande.',
      to: { prop: 'checked', change: 'OnCheckedChanged' } },
    { name: 'CheckOnClick', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'Choosing the command toggles its check mark.', docFr: 'Choisir la commande inverse sa coche.',
      to: { runtime: 'item-state' } },
    { name: 'RadioGroup', kind: 'String', default: '', category: 'Behavior',
      doc: 'Commands with the same group are exclusive: choosing one checks it and unchecks the others.',
      docFr: "Les commandes d'un même groupe s'excluent : en choisir une la coche et décoche les autres.",
      to: { runtime: 'item-state' } },
    { name: 'ShortcutKeys', kind: 'String', default: '', category: 'Misc',
      doc: 'Keyboard shortcut shown next to the command, for example Ctrl+C.',
      docFr: 'Raccourci clavier affiché à côté de la commande, par exemple Ctrl+C.',
      to: { prop: 'shortcut' } },
    { name: 'ItemsSource', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'list',
      doc: "Sub-menu commands added from a list when it opens (see the ContextMenu's ItemsSource).",
      docFr: "Commandes du sous-menu ajoutées depuis une liste à son ouverture (voir l'ItemsSource du ContextMenu).",
      to: { prop: 'items', convert: 'items-source' } },
    ...ICON_PROPERTIES,
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'MouseEventArgs',
      doc: 'Occurs when the command is chosen.', docFr: 'Se produit quand la commande est choisie.',
      from: { prop: 'onClick', args: 'none' } },
    { name: 'OnCheckedChanged', category: 'Property Changed', args: 'ValueChangedEventArgs',
      doc: 'Occurs when choosing the command changed its check mark (CheckOnClick, RadioGroup).',
      docFr: 'Se produit quand choisir la commande a changé sa coche (CheckOnClick, RadioGroup).',
      from: { runtime: 'parent-adapter', args: 'value' } },
  ],
  web: { module: null, export: null, domRoot: 'none', itemOf: ['ContextMenu', 'MenuItem'] },
} as const satisfies ElementMeta<MenuItem>

export const ToolTipMeta = {
  name: 'ToolTip',
  doc: "A component that sets how the tooltips of the view appear. Each control's tooltip text is its ToolTip property.",
  docFr: "Composant qui règle l'apparition des info-bulles de la vue. Le texte de l'info-bulle de chaque contrôle est sa propriété ToolTip.",
  family: 'components',
  baseChain: ['ToolTip', 'Component'],
  kind: 'component',
  children: 'None',
  defaultEvent: null,
  properties: [
    { name: 'InitialDelay', kind: 'F32', default: '500', category: 'Behavior',
      doc: 'How long the mouse must rest on a control before its tooltip appears, in milliseconds.',
      docFr: "Temps pendant lequel la souris doit rester sur un contrôle avant que son info-bulle apparaisse, en millisecondes.",
      to: { prop: 'delay' } },
    { name: 'Active', kind: 'Bool', default: 'true', category: 'Behavior',
      doc: 'Whether the tooltips are shown at all.', docFr: 'Indique si les info-bulles sont affichées.',
      to: { prop: 'disabled', convert: 'invert' } },
  ],
  events: [],
  web: { module: '@ui', export: 'Tooltip', domRoot: 'none' },
} as const satisfies ElementMeta<ComponentProps<typeof Tooltip>>
