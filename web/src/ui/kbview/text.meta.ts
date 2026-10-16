/**
 * Text and list-choice elements: `TextField` (`@ui` Input), `TextArea` (Textarea), `Dropdown` and
 * `ComboBox` with their `Option` items, `DatePicker`, `ColorField`, `GradientField`.
 * Names, kinds, defaults and documentation follow the desktop registry (VIEWS-SPEC §2, §9).
 */
import type { ComponentProps } from 'react'
import type { Input } from '../Input'
import type { OutlinedField } from '../OutlinedField'
import type { Textarea } from '../Textarea'
import type { Dropdown, DropdownOption } from '../Dropdown'
import type { Combobox, ComboboxOption } from '../Combobox'
import type { DatePicker } from '../DatePicker'
import type { ColorField } from '../ColorField'
import type { GradientField } from '../GradientPicker'
import type { AlternateBinding, ElementMeta } from './types.ts'
import { FIELD_CLASS, HOST_STRINGS } from './levels.ts'

// Web-only field chrome shared by the `@ui` form fields (label above, hint or error below).
const FIELD_LABEL = {
  name: 'Label', kind: 'String', default: '', category: 'Appearance', localizable: true, webOnly: true,
  doc: 'Web only: label shown above the field.', docFr: 'Web uniquement : libellé affiché au-dessus du champ.',
  to: { prop: 'label' },
} as const
const FIELD_HINT = {
  name: 'Hint', kind: 'String', default: '', category: 'Appearance', localizable: true, webOnly: true,
  doc: 'Web only: help text shown under the field.', docFr: "Web uniquement : texte d'aide affiché sous le champ.",
  to: { prop: 'hint' },
} as const
const FIELD_ERROR = {
  name: 'ErrorText', kind: 'String', default: '', category: 'Behavior', bindable: true, localizable: true, webOnly: true,
  doc: 'Web only: when not empty, shows the field in the error colour with this message under it.',
  docFr: "Web uniquement : si non vide, affiche le champ dans la couleur d'erreur avec ce message dessous.",
  to: { prop: 'error' },
} as const
const FIELD_REQUIRED = {
  name: 'Required', kind: 'Bool', default: 'false', category: 'Behavior', webOnly: true,
  doc: 'Web only: marks the label with an asterisk and announces the field as required.',
  docFr: "Web uniquement : marque le libellé d'un astérisque et annonce le champ comme obligatoire.",
  to: { prop: 'required' },
} as const

const PLACEHOLDER_DOC = {
  doc: 'Hint shown while the field is empty.',
  docFr: 'Indication affichée tant que le champ est vide.',
} as const

const ITEMS_SOURCE = {
  name: 'ItemsSource', kind: 'String', default: '', category: 'Data',
  doc: 'Binding to the list of items to show, instead of Option children.',
  docFr: 'Liaison vers la liste des éléments à afficher, à la place des éléments Option.',
} as const
const DISPLAY_MEMBER = {
  name: 'DisplayMember', kind: 'String', default: 'Label', category: 'Data',
  doc: 'Field of each bound item shown as its text.', docFr: 'Champ de chaque élément lié affiché comme texte.',
  to: { runtime: 'item-state' },
} as const
const VALUE_MEMBER = {
  name: 'ValueMember', kind: 'String', default: 'Value', category: 'Data',
  doc: 'Field of each bound item used as its value.', docFr: 'Champ de chaque élément lié utilisé comme valeur.',
  to: { runtime: 'item-state' },
} as const
const SELECTED_VALUE_DOC = {
  doc: 'Value of the selected option. Empty when nothing is selected.',
  docFr: "Valeur de l'option sélectionnée. Vide quand rien n'est sélectionné.",
} as const
const SELECTED_VALUE_CHANGED = {
  name: 'OnSelectedValueChanged', category: 'Property Changed', args: 'ValueChangedEventArgs', aliases: ['OnChanged'],
  doc: 'Occurs when the selected option changes.', docFr: "Se produit quand l'option sélectionnée change.",
} as const

/**
 * `TextField Variant="Outlined"` renders the `@ui` OutlinedField (floating label inside the box),
 * the field of the sign-in, setup and database screens. Fewer properties than Input: no hint,
 * error text, right icon or length limit.
 */
export const OutlinedTextFieldWeb = {
  when: { Variant: 'Outlined' },
  module: '@ui',
  export: 'OutlinedField',
  domRoot: 'wrapper',
  propMap: {
    Text: { prop: 'value', change: 'OnTextChanged' },
    Placeholder: { prop: 'placeholder' },
    Label: { prop: 'label' },
    Required: { prop: 'required' },
    LeftIcon: { prop: 'icon', convert: 'icon-node' },
    ReadOnly: { prop: 'readOnly' },
    Variant: { runtime: 'component-variant' },
  },
  eventMap: {
    OnTextChanged: { prop: 'onChange', args: 'value' },
  },
  // The accent follows the module (`[data-module]` redefines the token).
  fixed: { primaryColor: 'var(--color-primary)' },
} as const satisfies AlternateBinding<ComponentProps<typeof OutlinedField>>

export const TextFieldMeta = {
  name: 'TextField',
  doc: 'A single-line text box.',
  docFr: 'Zone de texte sur une ligne.',
  family: 'core',
  baseChain: ['TextField', 'TextBoxBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnTextChanged',
  properties: [
    FIELD_CLASS,
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text in the field.', docFr: 'Texte contenu dans le champ.',
      to: { prop: 'value', change: 'OnTextChanged' } },
    { name: 'Placeholder', kind: 'String', default: '', category: 'Appearance', ...PLACEHOLDER_DOC,
      to: { prop: 'placeholder' } },
    FIELD_LABEL, FIELD_HINT, FIELD_ERROR, FIELD_REQUIRED,
    { name: 'LeftIcon', kind: 'String', default: '', category: 'Icon', editor: 'icon', webOnly: true,
      doc: 'Web only: icon shown inside the field, before the text.',
      docFr: "Web uniquement : icône affichée dans le champ, avant le texte.",
      to: { prop: 'leftIcon', convert: 'icon-node' } },
    { name: 'RightIcon', kind: 'String', default: '', category: 'Icon', editor: 'icon', webOnly: true,
      doc: 'Web only: icon shown inside the field, after the text.',
      docFr: "Web uniquement : icône affichée dans le champ, après le texte.",
      to: { prop: 'rightIcon', convert: 'icon-node' } },
    { name: 'Variant', kind: { Enum: ['Standard', 'Outlined'] }, default: 'Standard', category: 'Appearance', webOnly: true,
      doc: 'Web only: Standard (label above the box) or Outlined (floating label inside the box, the OutlinedField).',
      docFr: 'Web uniquement : Standard (libellé au-dessus du champ) ou Outlined (libellé flottant dans le cadre, OutlinedField).',
      to: { runtime: 'component-variant' } },
    { name: 'InputType', kind: { Enum: ['Text', 'Password', 'Email', 'Url', 'Tel', 'Search', 'Number'] }, default: 'Text', category: 'Behavior', webOnly: true,
      doc: 'Web only: the kind of text the field takes - Password masks it, Email / Url / Tel bring the matching keyboard on a phone.',
      docFr: "Web uniquement : le genre de texte du champ - Password le masque, Email / Url / Tel affichent le clavier adapté sur un téléphone.",
      to: { prop: 'type', values: { Text: 'text', Password: 'password', Email: 'email', Url: 'url', Tel: 'tel', Search: 'search', Number: 'number' } } },
    { name: 'AutoComplete', kind: 'String', default: '', category: 'Behavior', webOnly: true,
      doc: 'Web only: what the browser may fill in the field (an HTML autocomplete token: current-password, new-password, email, off…).',
      docFr: "Web uniquement : ce que le navigateur peut remplir dans le champ (un jeton autocomplete HTML : current-password, new-password, email, off…).",
      to: { prop: 'autoComplete' } },
    { name: 'Bare', kind: 'Bool', default: 'false', category: 'Appearance', webOnly: true,
      doc: 'Web only: no chrome - no frame, no background, just the focus stroke under the text. For a title or search line that must not read as a form field (e.g. the floating search pill of a map).',
      docFr: "Web uniquement : sans chrome - pas de cadre ni de fond, seulement le trait de focus sous le texte. Pour une ligne de titre ou de recherche qui ne doit pas ressembler à un champ de formulaire (ex. la pilule de recherche flottante d'une carte).",
      to: { prop: 'bare' } },
  ],
  events: [
    { name: 'OnTextChanged', category: 'Property Changed', args: 'ValueChangedEventArgs', aliases: ['OnChanged'],
      doc: 'Occurs when the text changes.', docFr: 'Se produit quand le texte change.',
      from: { prop: 'onChange', args: 'target-value' } },
  ],
  inheritedMap: {
    Enabled: { prop: 'disabled', convert: 'invert' },
    ReadOnly: { prop: 'readOnly' },
    MaxLength: { prop: 'maxLength' },
    AccessibleName: { prop: 'aria-label' },
    TabIndex: { prop: 'tabIndex' },
  },
  designDefaults: { size: [200, 36] },
  web: { module: '@ui', export: 'Input', domRoot: 'wrapper', alternates: [OutlinedTextFieldWeb] },
} as const satisfies ElementMeta<ComponentProps<typeof Input>>

export const TextAreaMeta = {
  name: 'TextArea',
  doc: 'A multi-line text box.',
  docFr: 'Zone de texte multiligne.',
  family: 'text',
  baseChain: ['TextArea', 'TextBoxBase', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnTextChanged',
  properties: [
    FIELD_CLASS,
    { name: 'Text', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text in the field.', docFr: 'Texte contenu dans le champ.',
      to: { prop: 'value', change: 'OnTextChanged' } },
    { name: 'Placeholder', kind: 'String', default: '', category: 'Appearance', ...PLACEHOLDER_DOC,
      to: { prop: 'placeholder' } },
    { name: 'WordWrap', kind: 'Bool', default: 'true', category: 'Behavior',
      doc: 'Wraps long lines at the edge of the field.', docFr: 'Renvoie les longues lignes à la ligne au bord du champ.',
      to: { prop: 'wrap', values: { true: 'soft', false: 'off' } } },
    FIELD_LABEL, FIELD_HINT, FIELD_ERROR, FIELD_REQUIRED,
  ],
  events: [
    { name: 'OnTextChanged', category: 'Property Changed', args: 'ValueChangedEventArgs', aliases: ['OnChanged'],
      doc: 'Occurs when the text changes.', docFr: 'Se produit quand le texte change.',
      from: { prop: 'onChange', args: 'target-value' } },
  ],
  inheritedMap: {
    Enabled: { prop: 'disabled', convert: 'invert' },
    ReadOnly: { prop: 'readOnly' },
    MaxLength: { prop: 'maxLength' },
    AccessibleName: { prop: 'aria-label' },
    TabIndex: { prop: 'tabIndex' },
  },
  designDefaults: { size: [200, 120] },
  web: { module: '@ui', export: 'Textarea', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof Textarea>>

export const DropdownMeta = {
  name: 'Dropdown',
  doc: 'A drop-down list for choosing one option. Add the options as Option children.',
  docFr: 'Liste déroulante pour choisir une option. Ajoutez les options comme éléments Option enfants.',
  family: 'text',
  baseChain: ['Dropdown', 'ListControl', 'Control', 'Component'],
  children: 'List',
  allowedChildren: ['Option'],
  defaultEvent: 'OnSelectedValueChanged',
  properties: [
    { name: 'SelectedValue', kind: 'String', default: '', category: 'Data', ...SELECTED_VALUE_DOC,
      to: { prop: 'value', change: 'OnSelectedValueChanged' } },
    { name: 'Placeholder', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text shown when nothing is selected.', docFr: "Texte affiché quand rien n'est sélectionné.",
      to: { prop: 'placeholder' } },
    { name: 'Variant', kind: { Enum: ['Default', 'Ghost'] }, default: 'Default', category: 'Appearance',
      doc: 'Look of the list: with a border, or borderless for a toolbar.',
      docFr: 'Aspect de la liste : avec bordure, ou sans bordure pour une barre d\'outils.',
      to: { prop: 'variant', values: { Default: 'default', Ghost: 'ghost' } } },
    { ...ITEMS_SOURCE, to: { prop: 'options', convert: 'items-source' } },
    DISPLAY_MEMBER, VALUE_MEMBER,
  ],
  events: [
    { ...SELECTED_VALUE_CHANGED, from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: { Enabled: { prop: 'disabled', convert: 'invert' } },
  designDefaults: { size: [200, 36] },
  web: { module: '@ui', export: 'Dropdown', domRoot: 'wrapper', childrenToProp: { prop: 'options', item: 'Option', content: 'none' } },
} as const satisfies ElementMeta<ComponentProps<typeof Dropdown>>

export const ComboBoxMeta = {
  name: 'ComboBox',
  doc: 'A list box that drops down, for choosing one option. Add the options as Option children.',
  docFr: 'Liste déroulante pour choisir une option. Ajoutez les options comme éléments Option enfants.',
  family: 'text',
  baseChain: ['ComboBox', 'ListControl', 'Control', 'Component'],
  children: 'List',
  allowedChildren: ['Option'],
  defaultEvent: 'OnSelectedValueChanged',
  properties: [
    { name: 'SelectedValue', kind: 'String', default: '', category: 'Data', ...SELECTED_VALUE_DOC,
      to: { prop: 'value', change: 'OnSelectedValueChanged' } },
    { ...ITEMS_SOURCE, to: { prop: 'options', convert: 'items-source' } },
    DISPLAY_MEMBER, VALUE_MEMBER,
    { name: 'Placeholder', kind: 'String', default: '', category: 'Appearance', localizable: true, webOnly: true,
      doc: 'Web only: text shown when nothing is selected.', docFr: "Web uniquement : texte affiché quand rien n'est sélectionné.",
      to: { prop: 'placeholder' } },
    HOST_STRINGS,
  ],
  events: [
    { ...SELECTED_VALUE_CHANGED, from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: { Enabled: { prop: 'disabled', convert: 'invert' }, AccessibleName: { prop: 'aria-label' } },
  designDefaults: { size: [200, 36] },
  web: { module: '@ui', export: 'Combobox', domRoot: 'wrapper', childrenToProp: { prop: 'options', item: 'Option', content: 'none' } },
} as const satisfies ElementMeta<ComponentProps<typeof Combobox>>

/** `Option` items feed `Dropdown.options` and `Combobox.options`: checked against both item types. */
export const OptionMeta = ({
  name: 'Option',
  doc: 'An item of a Dropdown or ComboBox list, or a choice of a RadioGroup.',
  docFr: "Élément de la liste d'un Dropdown ou d'une ComboBox.",
  family: 'text',
  baseChain: ['Option', 'Component'],
  children: 'None',
  defaultEvent: null,
  properties: [
    { name: 'Value', kind: 'String', default: '', category: 'Data',
      doc: 'Value of the item.', docFr: "Valeur de l'élément.", to: { prop: 'value' } },
    { name: 'Label', kind: 'String', default: '', category: 'Appearance',
      doc: 'Text shown for the item. Defaults to Value.', docFr: "Texte affiché pour l'élément. Par défaut, Value.",
      to: { prop: 'label' } },
  ],
  events: [],
  web: { module: null, export: null, domRoot: 'none', itemOf: ['Dropdown', 'ComboBox', 'RadioGroup'] },
} as const satisfies ElementMeta<DropdownOption>) satisfies ElementMeta<ComboboxOption>

export const DatePickerMeta = {
  name: 'DatePicker',
  doc: 'A date field with a drop-down calendar.',
  docFr: 'Champ de date avec un calendrier déroulant.',
  family: 'text',
  baseChain: ['DatePicker', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnValueChanged',
  properties: [
    { name: 'Date', kind: 'String', default: '', category: 'Data',
      doc: 'Selected date, in the form YYYY-MM-DD.', docFr: 'Date sélectionnée, au format AAAA-MM-JJ.',
      to: { prop: 'value', change: 'OnValueChanged' } },
    { name: 'Format', kind: { Enum: ['Long', 'Short', 'Time'] }, default: 'Long', category: 'Appearance',
      doc: 'How the date is shown: long date, short date, or a time. On the web Long and Short both show the locale\'s date.',
      docFr: "Affichage de la date : date longue, date courte ou heure. Sur le web, Long et Short affichent tous deux la date de la langue.",
      to: { prop: 'mode', values: { Long: 'date', Short: 'date', Time: 'time' } } },
    { name: 'Placeholder', kind: 'String', default: '', category: 'Appearance', localizable: true, webOnly: true,
      doc: 'Web only: hint shown while no date is chosen.', docFr: "Web uniquement : indication affichée tant qu'aucune date n'est choisie.",
      to: { prop: 'placeholder' } },
    FIELD_LABEL, FIELD_HINT, FIELD_ERROR, FIELD_REQUIRED,
  ],
  events: [
    { name: 'OnValueChanged', category: 'Action', args: 'ValueChangedEventArgs', aliases: ['OnChanged'],
      doc: 'Occurs when the date changes.', docFr: 'Se produit quand la date change.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  inheritedMap: { Enabled: { prop: 'disabled', convert: 'invert' } },
  designDefaults: { size: [200, 36] },
  web: { module: '@ui', export: 'DatePicker', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof DatePicker>>

export const ColorFieldMeta = {
  name: 'ColorField',
  doc: 'A colour swatch that opens a colour picker.',
  docFr: 'Pastille de couleur qui ouvre un sélecteur de couleur.',
  family: 'text',
  baseChain: ['ColorField', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnValueChanged',
  properties: [
    { name: 'Color', kind: 'String', default: '#000000', category: 'Appearance',
      doc: 'Colour shown, as #rrggbb.', docFr: 'Couleur affichée, au format #rrggbb.',
      to: { prop: 'color', change: 'OnValueChanged' } },
  ],
  events: [
    { name: 'OnClick', category: 'Action', args: 'ValueChangedEventArgs',
      doc: 'Occurs when the swatch is clicked, which opens or closes its colour picker.',
      docFr: 'Se produit quand la pastille est cliquée, ce qui ouvre ou ferme son sélecteur de couleur.',
      from: { dom: 'click', args: 'none' } },
    { name: 'OnValueChanged', category: 'Action', args: 'ValueChangedEventArgs', aliases: ['OnChanged'],
      doc: 'Occurs when the colour is changed in the picker.', docFr: 'Se produit quand la couleur est modifiée dans le sélecteur.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  designDefaults: { size: [32, 24] },
  web: { module: '@ui', export: 'ColorField', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof ColorField>>

export const GradientFieldMeta = {
  name: 'GradientField',
  doc: 'A gradient swatch that opens a gradient picker.',
  docFr: 'Pastille de dégradé qui ouvre un sélecteur de dégradé.',
  family: 'text',
  baseChain: ['GradientField', 'Control', 'Component'],
  children: 'None',
  defaultEvent: 'OnValueChanged',
  properties: [
    { name: 'Value', kind: 'String', default: '', category: 'Data',
      doc: 'Gradient shown, as a CSS linear-gradient(...) or radial-gradient(circle, ...).',
      docFr: 'Dégradé affiché, au format CSS linear-gradient(...) ou radial-gradient(circle, ...).',
      to: { prop: 'value', convert: 'gradient-css', change: 'OnValueChanged' } },
  ],
  events: [
    { name: 'OnValueChanged', category: 'Action', args: 'ValueChangedEventArgs', aliases: ['OnChanged'],
      doc: 'Occurs when the gradient is changed in the picker.', docFr: 'Se produit quand le dégradé est modifié dans le sélecteur.',
      from: { prop: 'onChange', args: 'value' } },
  ],
  designDefaults: { size: [32, 24] },
  web: { module: '@ui', export: 'GradientField', domRoot: 'wrapper' },
} as const satisfies ElementMeta<ComponentProps<typeof GradientField>>
