/**
 * Form structure elements (WV-5a): `GroupBox`, `SettingsRow` and `RadioGroup` - the shared versions of the
 * section, settings row and radio list every module's settings page defined locally. `GroupBox` has the
 * desktop's name and members; `SettingsRow` and `RadioGroup` are new on both targets (WEB-VIEWS §3), web
 * first: the conformance allowlist says so until the desktop registry has them.
 */
import type { ComponentProps } from 'react'
import type { GroupBox } from '../GroupBox'
import type { SettingsRow } from '../SettingsRow'
import type { RadioGroup } from '../RadioGroup'
import type { ElementMeta } from './types.ts'

const CONTAINER_CHAIN = ['ContainerBase', 'ScrollableControl', 'Control', 'Component'] as const

export const GroupBoxMeta = {
  name: 'GroupBox',
  doc: 'A titled group around one child. On the web: a heading, an optional help line, then the content, like the sections of the settings pages.',
  docFr: 'Cadre avec un titre autour d\'un élément enfant.',
  family: 'containers',
  baseChain: ['GroupBox', ...CONTAINER_CHAIN],
  children: 'SingleWidget',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Title', kind: 'String', default: '', category: 'Appearance',
      doc: 'Title shown at the top of the frame.', docFr: 'Titre affiché en haut du cadre.',
      to: { prop: 'title' } },
    { name: 'Padding', kind: 'F32', default: '0', category: 'Layout',
      doc: 'Space around the child, on all four sides, in pixels.',
      docFr: "Espace autour de l'élément enfant, sur les quatre côtés, en pixels.",
      to: { prop: 'padding' } },
    { name: 'Description', kind: 'String', default: '', category: 'Appearance', localizable: true, webOnly: true,
      doc: 'Web only: a help line under the title.', docFr: 'Web uniquement : une ligne d\'aide sous le titre.',
      to: { prop: 'description' } },
  ],
  events: [],
  inheritedMap: { Class: { prop: 'className' } },
  designDefaults: { attributes: { Title: 'Group' }, size: [320, 160] },
  web: { module: '@ui', export: 'GroupBox', domRoot: 'ref', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof GroupBox>>

export const SettingsRowMeta = {
  name: 'SettingsRow',
  doc: 'One line of a settings page: the setting\'s name and help line, then the control that changes it (its child). Beside each other on a wide screen, stacked on a phone.',
  docFr: "Ligne d'une page de réglages : le nom du réglage et sa ligne d'aide, puis le contrôle qui le modifie (son enfant). Côte à côte sur un grand écran, l'un au-dessus de l'autre sur un téléphone.",
  family: 'containers',
  baseChain: ['SettingsRow', 'Control', 'Component'],
  children: 'SingleWidget',
  defaultEvent: 'OnClick',
  properties: [
    { name: 'Label', kind: 'String', default: '', category: 'Appearance', bindable: true, localizable: true,
      doc: 'Name of the setting.', docFr: 'Nom du réglage.', to: { prop: 'label' } },
    { name: 'Description', kind: 'String', default: '', category: 'Appearance', bindable: true, localizable: true,
      doc: 'A help line under the name.', docFr: "Ligne d'aide sous le nom.", to: { prop: 'description' } },
    { name: 'Orientation', kind: { Enum: ['Auto', 'Horizontal', 'Vertical'] }, default: 'Auto', category: 'Layout',
      doc: 'Auto: the name beside the control, above it on a phone. Horizontal or Vertical forces one of the two.',
      docFr: "Auto : le nom à côté du contrôle, au-dessus sur un téléphone. Horizontal ou Vertical impose l'une des deux dispositions.",
      to: { prop: 'layout', values: { Auto: 'auto', Horizontal: 'inline', Vertical: 'stacked' } } },
    { name: 'ShowDivider', kind: 'Bool', default: 'true', category: 'Appearance',
      doc: 'Draws the line under the row (the last row of a list never draws one).',
      docFr: "Trace la ligne sous la rangée (la dernière rangée d'une liste n'en trace jamais).",
      to: { prop: 'divider' } },
  ],
  events: [],
  inheritedMap: { Class: { prop: 'className' } },
  designDefaults: { attributes: { Label: 'Setting' }, size: [640, 64] },
  web: { module: '@ui', export: 'SettingsRow', domRoot: 'ref', content: 'children' },
} as const satisfies ElementMeta<ComponentProps<typeof SettingsRow>>

export const RadioGroupMeta = {
  name: 'RadioGroup',
  doc: 'Exclusive options: choosing one unchecks the others. Add the options as Option children, or bind ItemsSource. The arrow keys move the choice.',
  docFr: "Options exclusives : en choisir une décoche les autres. Ajoutez les options comme éléments Option enfants, ou liez ItemsSource. Les flèches déplacent le choix.",
  family: 'choice',
  baseChain: ['RadioGroup', 'ListControl', 'Control', 'Component'],
  children: 'List',
  allowedChildren: ['Option'],
  defaultEvent: 'OnSelectedValueChanged',
  properties: [
    { name: 'SelectedValue', kind: 'String', default: '', category: 'Data', bindable: true,
      doc: 'Value of the chosen option. Empty when none is chosen.',
      docFr: "Valeur de l'option choisie. Vide quand aucune n'est choisie.",
      to: { prop: 'value', change: 'OnSelectedValueChanged' } },
    { name: 'Orientation', kind: { Enum: ['Vertical', 'Horizontal'] }, default: 'Vertical', category: 'Layout',
      doc: 'One option per line, or the options side by side (wrapping).',
      docFr: 'Une option par ligne, ou les options côte à côte (renvoyées à la ligne).',
      to: { prop: 'orientation', values: { Vertical: 'vertical', Horizontal: 'horizontal' } } },
    { name: 'ItemsSource', kind: 'String', default: '', category: 'Data', bindable: true, editor: 'list',
      doc: 'A binding to the list of options to show, instead of Option children.',
      docFr: 'Liaison vers la liste des options à afficher, à la place des éléments Option.',
      to: { prop: 'options', convert: 'items-source' } },
    { name: 'DisplayMember', kind: 'String', default: 'Label', category: 'Data',
      doc: 'Field of each bound item shown as its text.', docFr: 'Champ de chaque élément lié affiché comme texte.',
      to: { runtime: 'item-state' } },
    { name: 'ValueMember', kind: 'String', default: 'Value', category: 'Data',
      doc: 'Field of each bound item used as its value.', docFr: 'Champ de chaque élément lié utilisé comme valeur.',
      to: { runtime: 'item-state' } },
  ],
  events: [
    { name: 'OnSelectedValueChanged', category: 'Property Changed', args: 'ValueChangedEventArgs',
      doc: 'Occurs when another option is chosen.', docFr: 'Se produit quand une autre option est choisie.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: {
    Enabled: { prop: 'disabled', convert: 'invert' },
    AccessibleName: { prop: 'aria-label' },
    Class: { prop: 'className' },
  },
  designDefaults: { size: [200, 80] },
  web: { module: '@ui', export: 'RadioGroup', domRoot: 'ref', childrenToProp: { prop: 'options', item: 'Option', content: 'none' } },
} as const satisfies ElementMeta<ComponentProps<typeof RadioGroup>>
