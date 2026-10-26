/**
 * `.kbview` elements rendered by the `@ui` `Button`: `Button` and `IconButton`.
 * Names, kinds, defaults and documentation follow the desktop registry (VIEWS-SPEC §2, §9).
 */
import type { ComponentProps } from 'react'
import type { Button } from '../Button'
import type { IconButton } from '../IconGlyph'
import type { ElementMeta } from './types.ts'
import { ICON_PROPERTIES } from './levels.ts'

type ButtonProps = ComponentProps<typeof Button>
type IconButtonProps = ComponentProps<typeof IconButton>

export const ButtonMeta = {
  name: 'Button',
  doc: 'A push button.',
  docFr: 'Bouton poussoir.',
  family: 'core',
  baseChain: ['Button', 'ButtonBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text displayed on the button.', docFr: 'Texte affiché sur le bouton.',
      to: { prop: 'children' } },
    { name: 'Variant', kind: { Enum: ['Primary', 'Secondary', 'Ghost', 'Text', 'Danger', 'TextDanger'] }, default: 'Primary', category: 'Appearance',
      doc: 'Visual style: filled, outlined, ghost, text only or danger.',
      docFr: 'Style visuel : plein, contour, fantôme, texte seul ou danger.',
      to: { prop: 'variant', values: { Primary: 'primary', Secondary: 'secondary', Ghost: 'ghost', Text: 'text', Danger: 'danger', TextDanger: 'textDanger' } } },
    { name: 'Size', kind: { Enum: ['Sm', 'Md', 'Lg'] }, default: 'Md', category: 'Appearance',
      doc: 'Height and horizontal padding of the button.', docFr: 'Hauteur et marges horizontales du bouton.',
      to: { prop: 'size', values: { Sm: 'sm', Md: 'md', Lg: 'lg' } } },
    { name: 'Icon', kind: 'String', default: '', category: 'Icon', editor: 'icon',
      doc: 'Icon shown before the text: a name of the Kubuno icon set, or an image file (SVG, PNG…) relative to the view.',
      docFr: "Icône affichée avant le texte : un nom du jeu d'icônes Kubuno, ou un fichier image (SVG, PNG…) relatif à la vue.",
      to: { prop: 'icon', convert: 'icon-node' } },
    { name: 'Loading', kind: 'Bool', default: 'false', category: 'Behavior',
      doc: 'Shows a spinner instead of the content and disables the button.',
      docFr: 'Affiche un indicateur de chargement à la place du contenu et désactive le bouton.',
      to: { prop: 'loading' } },
    { name: 'DropDownMenu', kind: 'String', default: '', category: 'Behavior', editor: 'reference:ContextMenu',
      doc: 'A ContextMenu of the view that a click opens below the button (a drop-down button).',
      docFr: "ContextMenu de la vue qu'un clic ouvre sous le bouton (bouton déroulant).",
      to: { runtime: 'drop-down-menu' } },
    { name: 'ButtonType', kind: { Enum: ['Button', 'Submit', 'Reset'] }, default: 'Button', category: 'Behavior', webOnly: true,
      doc: 'Web only: Submit sends the form the button is in (a container with HtmlTag="Form", its OnSubmit); Reset clears it.',
      docFr: 'Web uniquement : Submit envoie le formulaire qui contient le bouton (un conteneur HtmlTag="Form", son OnSubmit) ; Reset le vide.',
      to: { prop: 'type', values: { Button: 'button', Submit: 'submit', Reset: 'reset' } } },
    ...ICON_PROPERTIES,
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'MouseEventArgs',
      doc: 'Occurs when the button is clicked or activated with Space or Enter.',
      docFr: 'Se produit quand le bouton est cliqué ou activé avec Espace ou Entrée.',
      from: { prop: 'onClick', args: 'mouse' } },
  ],
  inheritedMap: {
    Enabled: { prop: 'disabled', convert: 'invert' },
    AccessibleName: { prop: 'aria-label' },
    TabIndex: { prop: 'tabIndex' },
  },
  designDefaults: { attributes: { Text: 'Bouton' }, size: [100, 36] },
  web: { module: '@ui', export: 'Button', domRoot: 'ref' },
} as const satisfies ElementMeta<ButtonProps>

export const IconButtonMeta = {
  name: 'IconButton',
  doc: 'A round button showing only an icon.',
  docFr: "Bouton rond qui n'affiche qu'une icône.",
  family: 'choice',
  baseChain: ['IconButton', 'ButtonBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Icon', kind: 'String', default: '', category: 'Icon', editor: 'icon',
      doc: 'The icon: a name of the Kubuno icon set (Check, X, Trash2, Search, Plus, MoreVertical…), or an image file relative to the view.',
      docFr: "L'icône : un nom du jeu d'icônes Kubuno (Check, X, Trash2, Search, Plus, MoreVertical…), ou un fichier image relatif à la vue.",
      to: { prop: 'icon', convert: 'icon-node' } },
    { name: 'DropDownMenu', kind: 'String', default: '', category: 'Behavior', editor: 'reference:ContextMenu',
      doc: 'A ContextMenu of the view that a click opens below the button (a menu button).',
      docFr: "ContextMenu de la vue qu'un clic ouvre sous le bouton (bouton de menu).",
      to: { runtime: 'drop-down-menu' } },
    { name: 'Diameter', kind: 'F32', default: '36', category: 'Layout',
      doc: 'Diameter of the button, in pixels.', docFr: 'Diamètre du bouton, en pixels.',
      to: { prop: 'diameter' } },
    { name: 'Glyph', kind: 'F32', default: '18', category: 'Appearance',
      doc: 'Size of the icon in the button, in pixels.', docFr: "Taille de l'icône dans le bouton, en pixels.",
      to: { prop: 'glyph' } },
    { name: 'Filled', kind: 'Bool', default: 'false', category: 'Appearance',
      doc: 'Gives the button a tinted background.', docFr: 'Donne au bouton un fond teinté.',
      to: { prop: 'filled' } },
    ...ICON_PROPERTIES,
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'MouseEventArgs',
      doc: 'Occurs when the button is clicked or activated with Space or Enter.',
      docFr: 'Se produit quand le bouton est cliqué ou activé avec Espace ou Entrée.',
      from: { prop: 'onClick', args: 'mouse' } },
  ],
  inheritedMap: {
    Enabled: { prop: 'disabled', convert: 'invert' },
    // An icon-only button has no text: its accessible name is required (language-server diagnostic).
    AccessibleName: { prop: 'aria-label' },
    TabIndex: { prop: 'tabIndex' },
    Class: { prop: 'className' },
  },
  designDefaults: { attributes: { Icon: 'Plus', AccessibleName: 'Add' }, size: [36, 36] },
  web: { module: '@ui', export: 'IconButton', domRoot: 'ref' },
} as const satisfies ElementMeta<IconButtonProps>
