export { cn, clsx, type ClassValue } from './cn'
import type { ComponentType } from 'react'

// Theme override registry - the indirection that lets a theme replace a
// component's markup/behaviour (globally or per module), exposed to modules too.
export { ComponentRegistry, ThemeScopeContext, ThemePreviewContext, themed, useThemeVersion } from './themeRegistry'
// Optional portal host: confine overlay primitives (FloatingWindow / AnchoredPopover)
// to a bounded element instead of <body>. Used by the theme preview.
export { PortalHostContext, usePortalHost } from './portalHost'

import { themed as t } from './themeRegistry'

// Base implementations (raw, pre-theming). Internal `@ui` consumers keep
// importing these from their own files; the host and modules import the
// themeable versions exported below from `@ui`.
import { Button as BaseButton } from './Button'
import { Badge as BaseBadge } from './Badge'
import { Input as BaseInput } from './Input'
import { NumberInput as BaseNumberInput } from './NumberInput'
import { Textarea as BaseTextarea } from './Textarea'
import { Editable as BaseEditable } from './Editable'
import { OutlinedField as BaseOutlinedField } from './OutlinedField'
import { FieldGroup as BaseFieldGroup } from './FieldGroup'
import { PhoneField as BasePhoneField } from './PhoneField'
import { DateField as BaseDateField } from './DateField'
import { AddressField as BaseAddressField } from './AddressField'
import { LabelCombobox as BaseLabelCombobox } from './LabelCombobox'
import { RichText as BaseRichText } from './RichText'
import { Checkbox as BaseCheckbox } from './Checkbox'
import { Radio as BaseRadio } from './Radio'
import { Toggle as BaseToggle } from './Toggle'
import { FloatCheckbox as BaseFloatCheckbox } from './FloatCheckbox'
import { Separator as BaseSeparator } from './Separator'
import { Spinner as BaseSpinner } from './Spinner'
import { RangeSlider as BaseRangeSlider } from './RangeSlider'
import { Dropdown as BaseDropdown } from './Dropdown'
import { DatePicker as BaseDatePicker } from './DatePicker'
import { FontPicker as BaseFontPicker } from './FontPicker'
import { FontSizeField as BaseFontSizeField } from './FontSizeField'
import { MenuDropdown as BaseMenuDropdown } from './MenuDropdown'
import { Tabs as BaseTabs } from './Tabs'
import { Accordion as BaseAccordion } from './Accordion'
import { StartPage as BaseStartPage } from './StartPage'
import { KubunoLogo as BaseKubunoLogo } from './KubunoLogo'
import { LabelIcon as BaseLabelIcon } from './LabelIcon'
import { ColorPicker as BaseColorPicker } from './ColorPicker'
import { ColorField as BaseColorField } from './ColorField'
import { ColorSwatchPicker as BaseColorSwatchPicker } from './ColorSwatchPicker'
import { GradientPicker as BaseGradientPicker, GradientField as BaseGradientField } from './GradientPicker'
import { Card as BaseCard } from './Card'
import { EmptyState as BaseEmptyState } from './EmptyState'
import { Callout as BaseCallout } from './Callout'
import { BreadcrumbBase } from './Breadcrumb'
import { ProgressBar as BaseProgressBar } from './ProgressBar'
import { Combobox as BaseCombobox } from './Combobox'
import { Stepper as BaseStepper } from './Stepper'
import { DataTable as BaseDataTable } from './DataTable'
import { AnchoredPopover as BaseAnchoredPopover } from './AnchoredPopover'
import { FloatingWindow as BaseFloatingWindow } from './FloatingWindow'
import { ResizeHandle as BaseResizeHandle } from './ResizeHandle'
import BaseConfirmDialog from './ConfirmDialog'
import BaseConflictDialog from './ConflictDialog'
import { Label as BaseLabel, LinkLabel as BaseLinkLabel } from './Label'
import { Avatar as BaseAvatar } from './Avatar'
import { IconGlyph as BaseIconGlyph, IconButton as BaseIconButton } from './IconGlyph'
import { GroupBox as BaseGroupBox } from './GroupBox'
import { SettingsRow as BaseSettingsRow } from './SettingsRow'
import { RadioGroup as BaseRadioGroup } from './RadioGroup'
import { PictureBox as BasePictureBox } from './PictureBox'
import { Toolbar as BaseToolbar } from './Toolbar'
import { Sidebar as BaseSidebar } from './Sidebar'
import { StatusBar as BaseStatusBar } from './StatusBar'
import { Splitter as BaseSplitter } from './Splitter'
import { SearchField as BaseSearchField } from './SearchField'
import { MaskedField as BaseMaskedField } from './MaskedField'
import { PaintBox as BasePaintBox } from './PaintBox'
import { ListBox as BaseListBox, CheckedListBox as BaseCheckedListBox } from './ListBox'
import { ListView as BaseListView } from './ListView'
import { TreeView as BaseTreeView } from './TreeView'

// Every visual primitive/complex component is themeable: a theme can replace its
// markup and behaviour, and otherwise it renders its default ("Base")
// implementation unchanged. Hooks, utilities and types stay raw further below.
export const Button = t('ui.Button', BaseButton)
export const Badge = t('ui.Badge', BaseBadge)
export const Input = t('ui.Input', BaseInput)
export const OutlinedField = t('ui.OutlinedField', BaseOutlinedField)
export const FieldGroup = t('ui.FieldGroup', BaseFieldGroup)
export const PhoneField = t('ui.PhoneField', BasePhoneField)
export const DateField = t('ui.DateField', BaseDateField)
export const AddressField = t('ui.AddressField', BaseAddressField)
export const LabelCombobox = t('ui.LabelCombobox', BaseLabelCombobox)
export const NumberInput = t('ui.NumberInput', BaseNumberInput)
export const Textarea = t('ui.Textarea', BaseTextarea)
export const Editable = t('ui.Editable', BaseEditable)
export const RichText = t('ui.RichText', BaseRichText)
export const Checkbox = t('ui.Checkbox', BaseCheckbox)
export const Radio = t('ui.Radio', BaseRadio)
export const Toggle = t('ui.Toggle', BaseToggle)
export const FloatCheckbox = t('ui.FloatCheckbox', BaseFloatCheckbox)
export const Separator = t('ui.Separator', BaseSeparator)
export const Spinner = t('ui.Spinner', BaseSpinner)
export const RangeSlider = t('ui.RangeSlider', BaseRangeSlider)
export const Dropdown = t('ui.Dropdown', BaseDropdown)
export const DatePicker = t('ui.DatePicker', BaseDatePicker)
export const FontPicker = t('ui.FontPicker', BaseFontPicker)
export const FontSizeField = t('ui.FontSizeField', BaseFontSizeField)
export const MenuDropdown = t('ui.MenuDropdown', BaseMenuDropdown)
// `Tabs` is generic (<T extends string>): cast back to its original type so the
// type parameter survives the wrapper (the runtime wrapper forwards props as-is).
export const Tabs = t('ui.Tabs', BaseTabs as ComponentType<unknown>) as unknown as typeof BaseTabs
export const Accordion = t('ui.Accordion', BaseAccordion)
export const StartPage = t('ui.StartPage', BaseStartPage)
export const KubunoLogo = t('ui.KubunoLogo', BaseKubunoLogo)
export const LabelIcon = t('ui.LabelIcon', BaseLabelIcon)
export const ColorPicker = t('ui.ColorPicker', BaseColorPicker)
export const ColorField = t('ui.ColorField', BaseColorField)
export const ColorSwatchPicker = t('ui.ColorSwatchPicker', BaseColorSwatchPicker)
export const GradientPicker = t('ui.GradientPicker', BaseGradientPicker)
export const GradientField = t('ui.GradientField', BaseGradientField)
export const Card = t('ui.Card', BaseCard)
export const EmptyState = t('ui.EmptyState', BaseEmptyState)
export const Callout = t('ui.Callout', BaseCallout)
// One trail for the whole product: the console and the file explorer render this.
export const Breadcrumb = t('ui.Breadcrumb', BreadcrumbBase)
export const ProgressBar = t('ui.ProgressBar', BaseProgressBar)
export const Combobox = t('ui.Combobox', BaseCombobox)
export const Stepper = t('ui.Stepper', BaseStepper)
// `DataTable` is generic (<T>): cast back to its original type so the type
// parameter survives the themeable wrapper (which forwards props untouched),
// exactly as `Tabs` does above.
export const DataTable = t('ui.DataTable', BaseDataTable as ComponentType<unknown>) as unknown as typeof BaseDataTable
export const AnchoredPopover = t('ui.AnchoredPopover', BaseAnchoredPopover)
export const FloatingWindow = t('ui.FloatingWindow', BaseFloatingWindow)
export const ResizeHandle = t('ui.ResizeHandle', BaseResizeHandle)
export const ConfirmDialog = t('ui.ConfirmDialog', BaseConfirmDialog)
export const ConflictDialog = t('ui.ConflictDialog', BaseConflictDialog)
// Text, link, avatar and icon primitives of the `.kbview` element set (vskubuno WEB-VIEWS.md, WV-5a).
export const Label = t('ui.Label', BaseLabel)
export const LinkLabel = t('ui.LinkLabel', BaseLinkLabel)
export const Avatar = t('ui.Avatar', BaseAvatar)
export const IconGlyph = t('ui.IconGlyph', BaseIconGlyph)
export const IconButton = t('ui.IconButton', BaseIconButton)
export const GroupBox = t('ui.GroupBox', BaseGroupBox)
export const SettingsRow = t('ui.SettingsRow', BaseSettingsRow)
export const RadioGroup = t('ui.RadioGroup', BaseRadioGroup)
export const PictureBox = t('ui.PictureBox', BasePictureBox)
export const ListBox = t('ui.ListBox', BaseListBox)
export const CheckedListBox = t('ui.CheckedListBox', BaseCheckedListBox)
export const ListView = t('ui.ListView', BaseListView)
export const TreeView = t('ui.TreeView', BaseTreeView)
export type { ListBoxProps, CheckedListBoxProps } from './ListBox'
export type { ListViewProps, ListColumnDef, ListViewView } from './ListView'
export type { TreeViewProps } from './TreeView'
export type { ListItemDef, SelectionMode, TreeRow } from './listCore'
export type { GroupBoxProps } from './GroupBox'
export type { SettingsRowProps } from './SettingsRow'
export type { RadioGroupProps, RadioOption } from './RadioGroup'
export type { PictureBoxProps, PictureSizeMode } from './PictureBox'
export type { TextWeight, TextStyle } from './Label'
export const Toolbar = t('ui.Toolbar', BaseToolbar)
export const Sidebar = t('ui.Sidebar', BaseSidebar)
export const StatusBar = t('ui.StatusBar', BaseStatusBar)
export const Splitter = t('ui.Splitter', BaseSplitter)
export const SearchField = t('ui.SearchField', BaseSearchField)
export const MaskedField = t('ui.MaskedField', BaseMaskedField)
export const PaintBox = t('ui.PaintBox', BasePaintBox)
export type { ToolbarProps, ToolbarItemDef } from './Toolbar'
export type { SidebarProps, SidebarItemDef } from './Sidebar'
export type { StatusBarProps, StatusLabelDef } from './StatusBar'
export type { SplitterProps } from './Splitter'
export type { SearchFieldProps } from './SearchField'
export type { MaskedFieldProps, MaskSlot } from './MaskedField'
export { parseMask, applyMask, maskPlaceholder } from './MaskedField'
export type { PaintBoxProps, PaintArgs } from './PaintBox'
export type { AvatarPresence } from './Avatar'
export type { PopoverPlacement, PopoverAlign } from './AnchoredPopover'
export { initialsOf } from './Avatar'
export type { AvatarProps } from './Avatar'
export type { LabelProps, LinkLabelProps, TextRole, TextAlign, TextOverflow } from './Label'
export type { IconGlyphProps, IconButtonProps, IconDisc } from './IconGlyph'

// ── Raw exports: hooks, utilities, types (not components) ──
export { CaretDown } from './CaretDown'
export { RollingNumber } from './RangeSlider'
export type { RangeSliderProps } from './RangeSlider'
export type { EditableProps } from './Editable'
export type { OutlinedFieldProps } from './OutlinedField'
export type { FieldGroupProps, GroupField } from './FieldGroup'
export type { PhoneFieldProps, PhoneValue } from './PhoneField'
export type { DateFieldProps, DateValue } from './DateField'
export type { AddressFieldProps, AddressValue } from './AddressField'
export type { LabelComboboxProps } from './LabelCombobox'
export { COUNTRIES, flagEmoji, countryOf } from './countries'
export type { Country } from './countries'
export type { DropdownOption } from './Dropdown'
export type { AccordionItemDef, AccordionProps } from './Accordion'
export type { FontPickerProps } from './FontPicker'
export type { FontSizeFieldProps } from './FontSizeField'
export { FONT_UI_THEME } from './FontPicker'
export type { UITheme } from './FontPicker'
export { parseFontMeta, dedupeFontFamilies } from './fontFamily'
export type { FontMeta } from './fontFamily'
export { useMenuDropdown } from './MenuDropdown'
export type { MenuItem, MenuDropdownPos, MenuTheme } from './MenuDropdown'
export { SpinnerOverlay } from './Spinner'
// Project-wide tooltip: modules use this instead of the native `title`.
export { Tooltip, TOOLTIP_STYLE } from './Tooltip'
export type { TooltipProps, TooltipSide } from './Tooltip'
// Project-wide help bubble: the filled, arrow-pointing answer behind a "?".
export { HelpBubble } from './HelpBubble'
export type { HelpBubbleProps, HelpBubbleSide } from './HelpBubble'
// Cross-module labels, as a form field (the data stays the caller's business).
export { LabelField } from './LabelField'
export type { LabelFieldProps, LabelOption } from './LabelField'
export type { DatePickerProps, DatePickerMode } from './DatePicker'
export type { TabsProps, TabDef } from './Tabs'
export type { StartPageProps, StartPageRecentItem, StartPageTab, StartPageRecentAction } from './StartPage'
export { useResizableWidth } from './ResizeHandle'
export { harmonyColors, DEFAULT_PICKER_THEME, LIGHT_PICKER_THEME, appPickerTheme, useAppPickerTheme } from './ColorPicker'
export type { Scheme, PickerTheme, PickerTool } from './ColorPicker'
export type { ConfirmVariant, ConfirmOptions } from './ConfirmDialog'
export type { ConflictChoice } from './ConflictDialog'
export { useWindowZStore } from './windowZStore'
export {
  hexToRgb, rgbToHex, rgbToHsl, hslToRgb, rgbToHsv, hsvToRgb, rgbToCmyk, cmykToRgb,
} from './color'
export { gradientToCss, rgbaFromHex, DEFAULT_GRADIENT } from './gradient'
export type { Gradient, GradientStop } from './gradient'
export { isCoarsePointer, openable, useLongPress, useIsMobile, useIsLandscape, MOBILE_MAX_WIDTH } from './interaction'
export { useSaveShortcut } from './useSaveShortcut'
export { MobileSheet, MobileSheetItem, MobileSheetSeparator } from './MobileSheet'

// ── Admin/data primitives (Card, EmptyState, Callout, ProgressBar, Combobox,
//    Stepper, Toast, DataTable) - types, hooks and helpers. The components
//    themselves are exported as themeable wrappers above. ──
export type { CardProps } from './Card'
export type { EmptyStateProps, EmptyStateVariant, EmptyStateAction } from './EmptyState'
export type { CalloutProps, CalloutVariant } from './Callout'
export type { BreadcrumbProps, Crumb } from './Breadcrumb'
export type { ProgressBarProps, ProgressVariant } from './ProgressBar'
export type { ComboboxProps, ComboboxOption } from './Combobox'
export { useStepper } from './Stepper'
export type { StepperProps, StepDef, StepStatus, UseStepperResult } from './Stepper'
// Toast is a provider + hook pair, not a themeable leaf component.
export { ToastProvider, useToast } from './Toast'
export type { ToastApi, ToastOptions, ToastVariant, ToastProviderProps } from './Toast'
export { DataTableSkeleton, Pagination } from './DataTable'
export type {
  DataTableProps, DataTableColumn, DataTableSort, DataTableBulkAction,
  DataTableRowAction, SortDirection, SortableValue, PaginationProps,
} from './DataTable'
// Text folding used by the Combobox filter - reusable by any module that needs
// accent-insensitive local search.
export { foldText, foldIncludes, uiT, UI_FALLBACK } from './uiText'

// ── @mention infrastructure (opt-in on Input / Textarea / RichText) ──
// Contract types (also re-exported by `@kubuno/sdk` alongside the extension
// point), the headless engine, the dropdown, and the chip helpers.
export type { MentionItem, MentionProvider, MentionsConfig, MentionMatch } from './mention/types'
export { setMentionProviderSource, defaultMentionProviders } from './mention/providerSource'
export { useMentionAutocomplete } from './mention/useMentionAutocomplete'
export type { UseMentionAutocompleteOptions, MentionCaretContext } from './mention/useMentionAutocomplete'
export { useContentEditableMention } from './mention/useContentEditableMention'
export { MentionList } from './mention/MentionList'
export type { MentionListProps } from './mention/MentionList'
export { MentionInput } from './mention/MentionInput'
export type { MentionInputProps, MentionModel } from './mention/MentionInput'
export { MentionEditable } from './mention/MentionEditable'
export type { MentionEditableProps } from './mention/MentionEditable'
export { detectMention, highlightMatch } from './mention/foldHighlight'
export type { HighlightSegment } from './mention/foldHighlight'
export {
  ensureMentionStyles, buildMentionChipHtml, replaceMentionQueryWithChip,
  bindMentionChipRemoval, serializeMentions, MENTION_REMOVE_ATTR,
} from './mention/mentionChip'
