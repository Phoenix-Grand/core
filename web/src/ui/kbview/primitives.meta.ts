/**
 * Text, link, avatar and icon elements (WV-5a): `Label`, `LinkLabel`, `Avatar`, `Icon`. Names, kinds,
 * defaults and documentation follow the desktop registry (VIEWS-SPEC §2, §7).
 */
import type { ComponentProps } from 'react'
import type { Label, LinkLabel } from '../Label'
import type { Avatar } from '../Avatar'
import type { IconGlyph } from '../IconGlyph'
import type { PictureBox } from '../PictureBox'
import type { ElementMeta } from './types.ts'

const ROLE_VALUES = { Micro: 'Micro', Meta: 'Meta', Body: 'Body', Heading: 'Heading', Title: 'Title', Badge: 'Badge', Caption: 'Caption', Subtitle: 'Subtitle', Display: 'Display' } as const

/** Web-only text weight and style (WV-5a), proposed for the desktop Label (which takes them from Font today). */
const FONT_WEIGHT = {
  name: 'FontWeight', kind: { Enum: ['Default', 'Regular', 'Medium', 'SemiBold', 'Bold'] }, default: 'Default', category: 'Appearance', webOnly: true,
  doc: "Web only: weight of the text. Default keeps the running text's weight; Medium is the host's emphasised step (rendered at 600).",
  docFr: "Web uniquement : graisse du texte. Default garde celle du texte courant ; Medium est le palier d'emphase de l'hôte (rendu en 600).",
  to: { prop: 'weight', values: { Regular: 'Regular', Medium: 'Medium', SemiBold: 'SemiBold', Bold: 'Bold' } },
} as const
const FONT_STYLE = {
  name: 'FontStyle', kind: { Enum: ['Normal', 'Italic'] }, default: 'Normal', category: 'Appearance', webOnly: true,
  doc: 'Web only: upright or italic text.',
  docFr: 'Web uniquement : texte droit ou italique.',
  to: { prop: 'fontStyle', values: { Normal: 'Normal', Italic: 'Italic' } },
} as const

/** Web-only: the HTML element of a text (WV-11, the migration keeps the screens' semantics: headings, inline runs). */
const TEXT_TAGS = ['P', 'Span', 'Div', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Strong', 'Em', 'Small', 'Label', 'Code', 'Li'] as const
const HTML_TAG = {
  name: 'HtmlTag', kind: { Enum: TEXT_TAGS }, default: 'P', category: 'Accessibility', webOnly: true,
  doc: 'Web only: the HTML element of the text - a paragraph, a heading level (H1–H6, announced as such by screen readers), an inline run (Span)…',
  docFr: "Web uniquement : l'élément HTML du texte - un paragraphe, un niveau de titre (H1–H6, annoncé comme tel par les lecteurs d'écran), un passage en ligne (Span)…",
  to: { prop: 'as', values: { P: 'p', Span: 'span', Div: 'div', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6', Strong: 'strong', Em: 'em', Small: 'small', Label: 'label', Code: 'code', Li: 'li' } },
} as const
const INHERIT_FONT_SIZE = {
  name: 'InheritFontSize', kind: 'Bool', default: 'false', category: 'Appearance', webOnly: true,
  doc: "Web only: the text keeps its parent's font size instead of its role's (a run inside a sentence).",
  docFr: "Web uniquement : le texte garde la taille de police de son parent au lieu de celle de son rôle (un passage dans une phrase).",
  to: { prop: 'inheritSize' },
} as const

export const LabelMeta = {
  name: 'Label',
  doc: 'A line or paragraph of text, in one of the shared typographic roles.',
  docFr: 'Ligne ou paragraphe de texte, dans un des rôles typographiques partagés.',
  family: 'display',
  baseChain: ['Label', 'LabelBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text shown.', docFr: 'Texte affiché.', to: { prop: 'text' } },
    { name: 'Role', kind: { Enum: ['Micro', 'Meta', 'Body', 'Heading', 'Title', 'Badge', 'Caption', 'Subtitle', 'Display'] }, default: 'Body', category: 'Appearance',
      doc: 'Text style: small, caption, body, heading or title, and the badge (10), caption (11), subtitle (16) and display (24) steps (the same sizes on the web and the desktop).',
      docFr: 'Style du texte : petit, légende, corps, intertitre ou titre, et les paliers pastille (10), légende fine (11), sous-titre (16) et affichage (24).',
      to: { prop: 'role', values: ROLE_VALUES } },
    { name: 'TextAlign', kind: { Enum: ['TopLeft', 'TopCenter', 'TopRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'BottomLeft', 'BottomCenter', 'BottomRight'] }, default: 'TopLeft', category: 'Misc', aliases: ['Align'],
      doc: 'Position of the text in the label. On the web the horizontal part applies (Left = start, Right = end of the reading direction).',
      docFr: "Position du texte dans l'étiquette.",
      to: { prop: 'textAlign' } },
    { name: 'Overflow', kind: { Enum: ['Ellipsis', 'Clip', 'Wrap'] }, default: 'Ellipsis', category: 'Layout',
      doc: 'What a text too long for the label does: ellipsis, clipped, or wrapped onto the next lines.',
      docFr: 'Traitement du texte trop long : points de suspension, coupé, ou renvoyé à la ligne.',
      to: { prop: 'overflow', values: { Ellipsis: 'Ellipsis', Clip: 'Clip', Wrap: 'Wrap' } } },
    FONT_WEIGHT,
    FONT_STYLE,
    HTML_TAG,
    INHERIT_FONT_SIZE,
  ],
  events: [],
  inheritedMap: { AccessibleName: { prop: 'aria-label' }, TabIndex: { prop: 'tabIndex' }, Class: { prop: 'className' } },
  designDefaults: { attributes: { Text: 'Étiquette' }, size: [120, 20] },
  web: { module: '@ui', export: 'Label', domRoot: 'ref' },
} as const satisfies ElementMeta<ComponentProps<typeof Label>>

export const LinkLabelMeta = {
  name: 'LinkLabel',
  doc: 'A link. Its OnClick decides where to go; on the web, Href also gives it an address (middle click, open in a new tab).',
  docFr: "Lien. Son OnClick décide où aller ; sur le web, Href lui donne aussi une adresse (clic du milieu, ouvrir dans un nouvel onglet).",
  family: 'display',
  baseChain: ['LinkLabel', 'LabelBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text of the link.', docFr: 'Texte du lien.', to: { prop: 'text' } },
    { name: 'Role', kind: { Enum: ['Micro', 'Meta', 'Body', 'Heading', 'Title', 'Badge', 'Caption', 'Subtitle', 'Display'] }, default: 'Body', category: 'Appearance',
      doc: 'Text style: small, caption, body, heading or title.',
      docFr: 'Style du texte : petit, légende, corps, intertitre ou titre, et les paliers pastille (10), légende fine (11), sous-titre (16) et affichage (24).',
      to: { prop: 'role', values: ROLE_VALUES } },
    { name: 'Href', kind: 'String', default: '', category: 'Behavior', bindable: true, webOnly: true,
      doc: 'Web only: the address of the link. A plain click stays in the app (OnClick decides); a middle or modified click opens the address.',
      docFr: "Web uniquement : l'adresse du lien. Un clic simple reste dans l'application (OnClick décide) ; un clic du milieu ou avec une touche de modification ouvre l'adresse.",
      to: { prop: 'href' } },
    FONT_WEIGHT,
    FONT_STYLE,
    INHERIT_FONT_SIZE,
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'MouseEventArgs',
      doc: 'Occurs when the link is clicked.', docFr: 'Se produit quand le lien est cliqué.',
      from: { prop: 'onClick', args: 'mouse' } },
  ],
  inheritedMap: { AccessibleName: { prop: 'aria-label' }, TabIndex: { prop: 'tabIndex' }, Class: { prop: 'className' } },
  designDefaults: { attributes: { Text: 'Lien' }, size: [120, 20] },
  web: { module: '@ui', export: 'LinkLabel', domRoot: 'ref' },
} as const satisfies ElementMeta<ComponentProps<typeof LinkLabel>>

export const AvatarMeta = {
  name: 'Avatar',
  doc: "A person's photo, or their initials on a disc while there is none.",
  docFr: "Photo d'une personne, ou ses initiales sur un disque tant qu'il n'y en a pas.",
  family: 'display',
  baseChain: ['Avatar', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'DisplayName', kind: 'String', default: '', category: 'Appearance', bindable: true, localizable: true,
      doc: "The person's name: its initials show when there is no photo; it is also the photo's alternative text.",
      docFr: "Nom de la personne : ses initiales sont affichées quand il n'y a pas de photo, et il choisit la couleur.",
      to: { prop: 'displayName' } },
    { name: 'Initials', kind: 'String', default: '', category: 'Appearance', bindable: true,
      doc: "Letters shown instead of the name's initials.", docFr: 'Lettres affichées à la place des initiales du nom.',
      to: { prop: 'initials' } },
    { name: 'Image', kind: 'String', default: '', category: 'Appearance', bindable: true, editor: 'image',
      doc: 'The photo: an image address (web) or a file relative to the view.',
      docFr: "Photo : le chemin d'un fichier image, relatif à la vue.",
      to: { prop: 'image' } },
    { name: 'Tint', kind: { Enum: ['Auto', 'Accent'] }, default: 'Auto', category: 'Appearance',
      doc: 'Auto: a neutral disc, the initials in the secondary text colour (web). Accent: the accent colour, white initials.',
      docFr: "Auto : une couleur choisie d'après le nom, initiales en blanc. Accent : la couleur d'accent pâle, initiales dans la couleur d'accent.",
      to: { prop: 'tint', values: { Auto: 'auto', Accent: 'accent' } } },
    { name: 'Shape', kind: { Enum: ['Circle', 'Rounded'] }, default: 'Circle', category: 'Appearance',
      doc: 'A circle, or a square with rounded corners.', docFr: 'Un cercle, ou un carré aux coins arrondis.',
      to: { prop: 'shape', values: { Circle: 'circle', Rounded: 'rounded' } } },
    { name: 'Presence', kind: { Enum: ['None', 'Online', 'Away', 'Busy', 'Offline'] }, default: 'None', category: 'Appearance', bindable: true,
      doc: "A dot at the bottom end corner: the person's availability.",
      docFr: 'Pastille affichée en bas à droite : la disponibilité de la personne.',
      to: { prop: 'presence', values: { None: 'none', Online: 'online', Away: 'away', Busy: 'busy', Offline: 'offline' } } },
    { name: 'AvatarSize', kind: 'F32', default: '36', category: 'Layout',
      doc: 'Diameter of the avatar, in pixels.', docFr: "Diamètre de l'avatar, en DIP (la boîte de l'élément est remplie si elle est plus petite).",
      to: { prop: 'size' } },
  ],
  events: [],
  inheritedMap: { Class: { prop: 'className' } },
  designDefaults: { attributes: { DisplayName: 'Camille Martin' }, size: [36, 36] },
  web: { module: '@ui', export: 'Avatar', domRoot: 'ref' },
} as const satisfies ElementMeta<ComponentProps<typeof Avatar>>

export const IconMeta = {
  name: 'Icon',
  doc: 'An icon of the Kubuno icon set, alone or on a coloured disc.',
  docFr: "Icône du jeu d'icônes Kubuno, seule ou sur un disque coloré.",
  family: 'display',
  baseChain: ['Icon', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Name', kind: 'String', default: '', category: 'Icon', editor: 'icon',
      doc: 'The icon: a name of the Kubuno icon set.',
      docFr: "L'icône : un nom du jeu d'icônes Kubuno, ou un fichier image (SVG, PNG…) relatif à la vue.",
      to: { prop: 'icon', convert: 'icon-component' } },
    { name: 'Size', kind: 'F32', default: '20', category: 'Appearance',
      doc: 'Size of the icon, in pixels.', docFr: "Taille de l'icône, en pixels.", to: { prop: 'size' } },
    { name: 'Disc', kind: { Enum: ['None', 'Neutral', 'Info', 'Warning', 'Danger', 'Success'] }, default: 'None', category: 'Misc',
      doc: 'Draws the icon on a coloured disc twice its size, like the icons of Kubuno message boxes.',
      docFr: 'Dessine l\'icône sur un disque coloré, comme les icônes des boîtes de message et des confirmations de Kubuno.',
      to: { prop: 'disc', values: { None: 'None', Neutral: 'Neutral', Info: 'Info', Warning: 'Warning', Danger: 'Danger', Success: 'Success' } } },
  ],
  events: [],
  inheritedMap: { Class: { prop: 'className' } },
  designDefaults: { attributes: { Name: 'Star' }, size: [20, 20] },
  web: { module: '@ui', export: 'IconGlyph', domRoot: 'ref' },
} as const satisfies ElementMeta<ComponentProps<typeof IconGlyph>>

export const PictureBoxMeta = {
  name: 'PictureBox',
  doc: 'An image, fitted into the control by SizeMode. On the web an <img>: its AccessibleName is the alternative text (none = a decorative picture).',
  docFr: "Image : le chemin d'un fichier image, relatif à la vue, ajustée au contrôle selon SizeMode.",
  family: 'display',
  baseChain: ['PictureBox', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Image', kind: 'String', default: '', category: 'Appearance', bindable: true, editor: 'image',
      doc: 'The image: an image address (web) or the path of an image file, relative to the view.',
      docFr: "Image : le chemin d'un fichier image, relatif à la vue.",
      to: { prop: 'src' } },
    { name: 'SizeMode', kind: { Enum: ['Normal', 'Stretch', 'Zoom', 'Center', 'Cover'] }, default: 'Normal', category: 'Behavior',
      doc: "Normal: at its size, top left. Stretch: to the control's size. Zoom: as large as fits, keeping its proportions. Center: at its size, centred. Cover: fills the control, keeping its proportions (cropped).",
      docFr: 'Normal : à sa taille, en haut à gauche. Stretch : à la taille du contrôle. Zoom : aussi grande que possible en gardant ses proportions. Center : à sa taille, centrée. Cover : remplit le contrôle en gardant ses proportions (rognée).',
      to: { prop: 'sizeMode', values: { Normal: 'Normal', Stretch: 'Stretch', Zoom: 'Zoom', Center: 'Center', Cover: 'Cover' } } },
    { name: 'CornerRadius', kind: 'F32', default: '0', category: 'Appearance',
      doc: 'Rounds the corners of the image, in pixels.', docFr: "Arrondit les coins de l'image, en DIP.",
      to: { prop: 'cornerRadius' } },
    { name: 'BorderStyle', kind: { Enum: ['None', 'FixedSingle'] }, default: 'None', category: 'Appearance',
      doc: 'A line drawn around the control.', docFr: 'Ligne dessinée autour du contrôle.',
      to: { prop: 'borderStyle', values: { None: 'None', FixedSingle: 'FixedSingle' } } },
  ],
  events: [],
  inheritedMap: { AccessibleName: { prop: 'alt' }, Class: { prop: 'className' } },
  designDefaults: { size: [160, 120] },
  web: { module: '@ui', export: 'PictureBox', domRoot: 'ref' },
} as const satisfies ElementMeta<ComponentProps<typeof PictureBox>>
