/**
 * Choice elements: `CheckBox` (`@ui` Checkbox), `RadioButton` (Radio), `Switch` (Toggle),
 * `Slider` (RangeSlider), `NumericField` (NumberInput).
 * Names, kinds, defaults and documentation follow the desktop registry (VIEWS-SPEC §2, §9).
 */
import type { ComponentProps } from 'react'
import type { Checkbox } from '../Checkbox'
import type { Radio } from '../Radio'
import type { Toggle } from '../Toggle'
import type { RangeSlider } from '../RangeSlider'
import type { NumberInput } from '../NumberInput'
import type { ElementMeta } from './types.ts'
import { FIELD_CLASS } from './levels.ts'

const SECONDARY_TEXT = {
  doc: 'Secondary text displayed under the label.',
  docFr: 'Texte secondaire affiché sous le libellé.',
} as const

export const CheckBoxMeta = {
  name: 'CheckBox',
  doc: 'A check box.',
  docFr: 'Case à cocher.',
  family: 'choice',
  baseChain: ['CheckBox', 'ButtonBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnCheckedChanged',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text displayed next to the check box.', docFr: 'Texte affiché à côté de la case.',
      to: { prop: 'label' } },
    { name: 'Description', kind: 'String', default: '', category: 'Appearance', ...SECONDARY_TEXT,
      to: { prop: 'description' } },
    { name: 'Checked', kind: 'Bool', default: 'false', category: 'Data',
      doc: 'Whether the box is checked.', docFr: 'Indique si la case est cochée.',
      to: { prop: 'checked', change: 'OnCheckedChanged' } },
    { name: 'CheckState', kind: { Enum: ['Unchecked', 'Checked', 'Indeterminate'] }, default: 'Unchecked', category: 'Appearance', bindable: true,
      doc: 'State of the box, including the indeterminate state of a three-state box.',
      docFr: "État de la case, y compris l'état indéterminé d'une case à trois états.",
      to: { prop: 'indeterminate', values: { Unchecked: false, Checked: false, Indeterminate: true } } },
  ],
  events: [
    { name: 'OnCheckedChanged', category: 'Property Changed', args: 'ValueChangedEventArgs',
      doc: 'Occurs when the box is checked or unchecked.', docFr: 'Se produit quand la case est cochée ou décochée.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: { Enabled: { prop: 'disabled', convert: 'invert' } },
  designDefaults: { attributes: { Text: 'Checkbox' }, size: [140, 24] },
  web: { module: '@ui', export: 'Checkbox', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof Checkbox>>

export const RadioButtonMeta = {
  name: 'RadioButton',
  doc: 'An option button: only one option of a group can be selected.',
  docFr: "Bouton d'option : une seule option d'un groupe peut être sélectionnée.",
  family: 'choice',
  baseChain: ['RadioButton', 'ButtonBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnCheckedChanged',
  properties: [
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text displayed next to the option.', docFr: "Texte affiché à côté de l'option.",
      to: { prop: 'label' } },
    { name: 'Description', kind: 'String', default: '', category: 'Appearance', ...SECONDARY_TEXT,
      to: { prop: 'description' } },
    { name: 'Value', kind: 'String', default: '', category: 'Data',
      doc: 'Value this option stands for.', docFr: 'Valeur que représente cette option.',
      to: { runtime: 'item-state' } },
    { name: 'Group', kind: 'String', default: '', category: 'Misc',
      doc: 'Name of the group this option belongs to.', docFr: 'Nom du groupe auquel appartient cette option.',
      to: { runtime: 'item-state' } },
    { name: 'SelectedValue', kind: 'String', default: '', category: 'Data',
      doc: 'Value of the selected option of the group, usually bound in both directions. The option is selected when it equals Value.',
      docFr: "Valeur de l'option sélectionnée du groupe, généralement liée dans les deux sens. L'option est sélectionnée quand elle est égale à Value.",
      to: { prop: 'checked', convert: 'equals-value', change: 'OnCheckedChanged' } },
  ],
  events: [
    { name: 'OnCheckedChanged', category: 'Property Changed', args: 'ValueChangedEventArgs',
      doc: 'Occurs when this option is selected.', docFr: 'Se produit quand cette option est sélectionnée.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: { Enabled: { prop: 'disabled', convert: 'invert' } },
  designDefaults: { attributes: { Text: 'Option' }, size: [140, 24] },
  web: { module: '@ui', export: 'Radio', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof Radio>>

export const SwitchMeta = {
  name: 'Switch',
  doc: 'An on/off switch.',
  docFr: 'Interrupteur marche/arrêt.',
  family: 'core',
  baseChain: ['Switch', 'ButtonBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnCheckedChanged',
  properties: [
    { name: 'On', kind: 'Bool', default: 'false', category: 'Data',
      doc: 'Whether the switch is on.', docFr: "Indique si l'interrupteur est activé.",
      to: { prop: 'checked', change: 'OnCheckedChanged' } },
    { name: 'Label', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text displayed next to the switch.', docFr: "Texte affiché à côté de l'interrupteur.",
      to: { prop: 'label' } },
    { name: 'Description', kind: 'String', default: '', category: 'Appearance', ...SECONDARY_TEXT,
      to: { prop: 'description' } },
    { name: 'Size', kind: { Enum: ['Sm', 'Md'] }, default: 'Md', category: 'Appearance',
      doc: 'Size of the switch.', docFr: "Taille de l'interrupteur.",
      to: { prop: 'size', values: { Sm: 'sm', Md: 'md' } } },
  ],
  events: [
    { name: 'OnCheckedChanged', category: 'Property Changed', args: 'ValueChangedEventArgs', aliases: ['OnToggled'],
      doc: 'Occurs when the switch is turned on or off.', docFr: "Se produit quand l'interrupteur est activé ou désactivé.",
      from: { prop: 'onChange', args: 'target-checked' } },
  ],
  inheritedMap: { Enabled: { prop: 'disabled', convert: 'invert' }, TabIndex: { prop: 'tabIndex' } },
  designDefaults: { attributes: { Label: 'Interrupteur' }, size: [140, 24] },
  web: { module: '@ui', export: 'Toggle', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof Toggle>>

export const SliderMeta = {
  name: 'Slider',
  doc: 'A slider for choosing a value in a range.',
  docFr: 'Curseur pour choisir une valeur dans une plage.',
  family: 'choice',
  baseChain: ['Slider', 'RangeBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnValueChanged',
  properties: [
    { name: 'Minimum', kind: 'F32', default: '0', category: 'Data', aliases: ['Min'],
      doc: 'Lowest value.', docFr: 'Valeur minimale.', to: { prop: 'min' } },
    { name: 'Maximum', kind: 'F32', default: '10', category: 'Data', aliases: ['Max'],
      doc: 'Highest value.', docFr: 'Valeur maximale.', to: { prop: 'max' } },
    { name: 'Value', kind: 'F32', default: '0', category: 'Data',
      doc: 'Current value, between Minimum and Maximum.', docFr: 'Valeur actuelle, entre Minimum et Maximum.',
      to: { prop: 'value', change: 'OnValueChanged' } },
    { name: 'SmallChange', kind: 'F32', default: '1', category: 'Data', aliases: ['Step'],
      doc: 'Amount the value changes with an arrow key.', docFr: 'Pas de variation avec une touche fléchée.',
      to: { prop: 'step' } },
    { name: 'ShowValue', kind: 'Bool', default: 'false', category: 'Appearance', webOnly: true,
      doc: 'Web only: always shows the value bubble, not only while dragging.',
      docFr: 'Web uniquement : affiche toujours la bulle de valeur, pas seulement pendant le glissement.',
      to: { prop: 'showValue' } },
  ],
  events: [
    { name: 'OnValueChanged', category: 'Action', args: 'ValueChangedEventArgs',
      doc: 'Occurs when the value changes.', docFr: 'Se produit quand la valeur change.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: { Enabled: { prop: 'disabled', convert: 'invert' }, AccessibleName: { prop: 'aria-label' } },
  designDefaults: { size: [200, 24] },
  web: { module: '@ui', export: 'RangeSlider', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof RangeSlider>>

export const NumericFieldMeta = {
  name: 'NumericField',
  doc: 'A number box with up and down buttons.',
  docFr: 'Champ numérique avec des boutons haut et bas.',
  family: 'choice',
  baseChain: ['NumericField', 'RangeBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnValueChanged',
  properties: [
    FIELD_CLASS,
    { name: 'Minimum', kind: 'F32', default: '0', category: 'Data', aliases: ['Min'],
      doc: 'Lowest value.', docFr: 'Valeur minimale.', to: { prop: 'min' } },
    { name: 'Maximum', kind: 'F32', default: '100', category: 'Data', aliases: ['Max'],
      doc: 'Highest value.', docFr: 'Valeur maximale.', to: { prop: 'max' } },
    { name: 'Value', kind: 'F32', default: '0', category: 'Data',
      doc: 'Current value, between Minimum and Maximum.', docFr: 'Valeur actuelle, entre Minimum et Maximum.',
      to: { prop: 'value', change: 'OnValueChanged' } },
    { name: 'Increment', kind: 'F32', default: '1', category: 'Misc', aliases: ['Step'],
      doc: 'Amount added or removed by the up and down buttons.', docFr: 'Valeur ajoutée ou retirée par les boutons haut et bas.',
      to: { prop: 'step' } },
    { name: 'Label', kind: 'String', default: '', category: 'Appearance', localizable: true, webOnly: true,
      doc: 'Web only: label shown above the field.', docFr: 'Web uniquement : libellé affiché au-dessus du champ.',
      to: { prop: 'label' } },
    { name: 'Hint', kind: 'String', default: '', category: 'Appearance', localizable: true, webOnly: true,
      doc: 'Web only: help text shown under the field.', docFr: "Web uniquement : texte d'aide affiché sous le champ.",
      to: { prop: 'hint' } },
    { name: 'ErrorText', kind: 'String', default: '', category: 'Behavior', bindable: true, localizable: true, webOnly: true,
      doc: 'Web only: when not empty, shows the field in the error colour with this message under it.',
      docFr: "Web uniquement : si non vide, affiche le champ dans la couleur d'erreur avec ce message dessous.",
      to: { prop: 'error' } },
    { name: 'Required', kind: 'Bool', default: 'false', category: 'Behavior', webOnly: true,
      doc: 'Web only: marks the label with an asterisk and announces the field as required.',
      docFr: "Web uniquement : marque le libellé d'un astérisque et annonce le champ comme obligatoire.",
      to: { prop: 'required' } },
  ],
  events: [
    { name: 'OnValueChanged', category: 'Action', args: 'ValueChangedEventArgs',
      doc: 'Occurs when the value changes.', docFr: 'Se produit quand la valeur change.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: { Enabled: { prop: 'disabled', convert: 'invert' } },
  designDefaults: { size: [200, 36] },
  web: { module: '@ui', export: 'NumberInput', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof NumberInput>>
