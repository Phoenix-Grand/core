/**
 * The accepted differences between the web and desktop element registries (VIEWS-SPEC §10).
 *
 * Every entry says WHY the web differs. An entry that no longer matches any difference fails the
 * conformance test (remove it); a difference no entry accepts fails it too (fix the metadata, or
 * add an entry with a reason). Entries tagged "WV-…" name the lot that is expected to close them.
 */
import type { AllowEntry } from './conformance.ts'
import { NAV_ALLOWLIST } from './allowlist.nav.ts'
import { LISTS_ALLOWLIST } from './allowlist.lists.ts'

const WINDOW_CHROME = 'Window chrome and window behaviour (title bar, caption buttons, backdrop, taskbar, MDI, opacity…): a web view is a page or a dialog inside the host shell, never a top-level window. The web keeps Title only.'
const NOT_YET = (lot: string, what: string) => `Not implemented by the @ui component yet (${lot}): ${what}`

export const KBVIEW_ALLOWLIST: readonly AllowEntry[] = [
  // ── The view's root (View level) ──
  { kind: 'property-missing-on-web', element: '*', level: 'View', reason: WINDOW_CHROME },
  { kind: 'event-missing-on-web', element: '*', level: 'View', reason: 'Window lifecycle events (activation, closing, resize begin/end, DPI, caption buttons, MDI) have no web counterpart. OnLoad and OnShown are kept; OnUnload covers a page leaving the screen.' },
  { kind: 'event-web-only', element: '*', level: 'View', member: 'OnUnload', reason: 'Web only: a page leaves the screen (route change, panel closed) without a window closing. Desktop counterpart: OnFormClosed.' },

  // ── Control level ──
  { kind: 'property-web-only', element: '*', level: 'Control', member: 'Class', reason: 'Decision 3 (WEB-VIEWS §10): Tailwind classes tolerated during the migration, flagged by the language server, with a per-repository budget that must reach zero.' },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'Font', reason: 'Typography comes from theme tokens on the web (Label Role, element sizes); a free font family/size would bypass the design system.' },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'BackgroundImage', reason: 'No background images on web elements (tokens only); pictures are PictureBox elements (WV-5a).' },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'BackgroundImageLayout', reason: 'Goes with BackgroundImage (not on the web).' },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'CausesValidation', reason: 'No focus-change validation model on the web yet (forms validate on submit); to decide with the runtime (WV-3).' },
  { kind: 'event-missing-on-web', element: '*', level: 'Control', member: 'OnValidating', reason: 'No focus-change validation model on the web yet (WV-3).' },
  { kind: 'event-missing-on-web', element: '*', level: 'Control', member: 'OnValidated', reason: 'No focus-change validation model on the web yet (WV-3).' },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'AutoSize', reason: 'Web layout is flow by default: elements already size to their content; Width/Height fix a size.' },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'AutoSizeMode', reason: 'Goes with AutoSize (implicit on the web).' },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'TitleBar.Region', reason: WINDOW_CHROME },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'TitleBar.Drag', reason: WINDOW_CHROME },
  { kind: 'property-missing-on-web', element: '*', level: 'Control', member: 'ActionBar.Region', reason: 'Dialog footers on the web are the FloatingWindow actions; a view-level action bar region is a desktop window feature.' },
  { kind: 'event-missing-on-web', element: '*', level: 'Control', member: 'OnMove', reason: 'Flow layout: positions are not notified on the web (ResizeObserver gives sizes only).' },
  { kind: 'event-missing-on-web', element: '*', level: 'Control', member: 'OnLocationChanged', reason: 'Flow layout: positions are not notified on the web.' },
  { kind: 'event-missing-on-web', element: '*', level: 'Control', member: 'OnPaint', reason: 'DOM elements are not painted by handlers; the web PaintBox (WV-5b) brings OnPaint on a canvas.' },

  // ── Intermediate levels not implemented on the web ──
  { kind: 'property-missing-on-web', element: '*', level: 'ButtonBase', reason: 'WinForms text/image placement (TextAlign, Image, ImageAlign, TextImageRelation, IconSpacing) is fixed by the @ui buttons\' design; mnemonics (UseMnemonic) would fight browser access keys; UseVisualStyleBackColor has no meaning with theme tokens.' },
  { kind: 'property-missing-on-web', element: '*', level: 'LabelBase', reason: 'Badge is a fixed design-system pill: no WinForms label border, image or alignment.' },
  { kind: 'property-missing-on-web', element: '*', level: 'ContainerBase', member: 'BorderStyle', reason: 'Web containers draw their surface from tokens (Card, Surface), not WinForms border styles.' },
  { kind: 'property-missing-on-web', element: '*', level: 'ScrollableControl', member: 'AutoScroll', reason: 'Scrolling on the web is the ScrollArea element (WV-5a); containers do not scroll on their own.' },
  { kind: 'property-missing-on-web', element: '*', level: 'ListControl', member: 'Sorted', reason: NOT_YET('WV-5b', 'the list is shown in the order the code provides.') },
  { kind: 'property-missing-on-web', element: '*', level: 'TextBoxBase', reason: NOT_YET('WV-5a', 'AcceptsTab, CharacterCasing, HideSelection, PasswordChar (a password TextField), TextAlign. ReadOnly and MaxLength are supported.') },

  // ── Element level ──
  { kind: 'element-mismatch', element: 'DockArea', member: 'default_event', reason: 'The desktop default event (OnPanelActivated) does not exist on the web yet (WV-5b): no default event until it does.' },

  // ── Own members: web-only field chrome ──
  { kind: 'property-web-only', element: '*', member: 'Label', reason: 'Web form fields carry their label above them (@ui Input, Textarea, NumberInput, DatePicker). Proposed for the desktop fields (desktop forms use a separate Label).' },
  { kind: 'property-web-only', element: '*', member: 'Hint', reason: 'Web form fields carry a help line under them. Proposed for the desktop fields.' },
  { kind: 'property-web-only', element: '*', member: 'ErrorText', reason: 'Web form fields show an error message under them; it replaces Invalid (see below). Proposed for the desktop fields.' },
  { kind: 'property-web-only', element: '*', member: 'Required', reason: 'Web form fields mark the label with an asterisk and set aria-required. Proposed for the desktop fields.' },
  { kind: 'property-missing-on-web', element: '*', member: 'Invalid', reason: NOT_YET('WV-5a', 'the @ui fields turn red only with an error message (ErrorText); a message-less invalid state needs an `invalid` prop.') },
  { kind: 'property-web-only', element: 'TextField', member: 'Variant', reason: 'Web only: Outlined selects the @ui OutlinedField (floating label), used by the sign-in, setup and database screens of the core. Proposed for the desktop TextField.' },
  { kind: 'property-web-only', element: 'TextField', member: 'LeftIcon', reason: 'Web Input icon inside the field. To add on the desktop (WEB-VIEWS §3).' },
  { kind: 'property-web-only', element: 'TextField', member: 'RightIcon', reason: 'Web Input icon inside the field. To add on the desktop (WEB-VIEWS §3).' },
  { kind: 'property-web-only', element: 'ComboBox', member: 'Placeholder', reason: 'The web Combobox shows a placeholder; the desktop Dropdown has one, its ComboBox not yet.' },
  { kind: 'property-web-only', element: 'DatePicker', member: 'Placeholder', reason: 'The web DatePicker shows a placeholder while empty. Proposed for the desktop.' },

  // ── Own members: per element ──
  { kind: 'property-missing-on-web', element: 'Card', member: 'Surface', reason: NOT_YET('WV-5a', 'the @ui Card has one surface (Card); Layer and Raised come with the Surface tokens of the layout elements.') },
  { kind: 'property-web-only', element: 'Card', member: 'Actions', reason: 'Property element slot <Card.Actions> (header controls) of the @ui Card. To add on the desktop with the property-element slots.' },
  { kind: 'property-web-only', element: 'Card', member: 'Footer', reason: 'Property element slot <Card.Footer> of the @ui Card. To add on the desktop.' },
  { kind: 'property-mismatch', element: 'Card', member: 'Icon', level: 'View', reason: 'The web Card has its own Icon (header glyph, web only); on the desktop a root Card only has the view\'s window Icon. An own property hides the view\'s one on both targets.' },
  ...['IconSize', 'IconScaling', 'IconColor'].map((member) => ({ kind: 'property-web-only' as const, element: 'Card', member, reason: "Size and colour of the web Card's header glyph (its Icon is web only)." })),
  { kind: 'property-mismatch', element: 'DataTable', member: 'Title', level: 'View', reason: 'The web DataTable has its own Title (toolbar title, web only), which hides the view\'s window Title on a root DataTable.' },
  { kind: 'property-missing-on-web', element: 'ProgressBar', member: 'Minimum', reason: 'The @ui ProgressBar always starts at 0 (value/max).' },
  { kind: 'property-missing-on-web', element: 'CheckBox', member: 'AutoCheck', reason: NOT_YET('WV-5a', 'a click always toggles the box.') },
  { kind: 'property-missing-on-web', element: 'CheckBox', member: 'ThreeState', reason: NOT_YET('WV-5a', 'the indeterminate state is set by code (CheckState), not cycled by clicks.') },
  { kind: 'property-missing-on-web', element: 'RadioButton', member: 'AutoCheck', reason: NOT_YET('WV-5a', 'a click always selects the option.') },
  { kind: 'property-missing-on-web', element: 'Slider', member: 'LargeChange', reason: NOT_YET('WV-5a', 'Page Up / Page Down step of the slider.') },
  { kind: 'property-web-only', element: 'Slider', member: 'ShowValue', reason: 'The web RangeSlider can keep its value bubble visible. Proposed for the desktop.' },
  { kind: 'property-missing-on-web', element: 'NumericField', member: 'DecimalPlaces', reason: NOT_YET('WV-5a', 'number formatting of the field.') },
  { kind: 'property-missing-on-web', element: 'NumericField', member: 'ThousandsSeparator', reason: NOT_YET('WV-5a', 'number formatting of the field.') },
  { kind: 'property-missing-on-web', element: 'TextArea', member: 'AcceptsReturn', reason: 'A web textarea always types a new line on Enter (the accept button is the form submit).' },
  { kind: 'property-missing-on-web', element: 'TextArea', member: 'MinLines', reason: NOT_YET('WV-5a', 'auto-growing textarea.') },
  { kind: 'property-missing-on-web', element: 'TextArea', member: 'MaxLines', reason: NOT_YET('WV-5a', 'auto-growing textarea.') },
  { kind: 'property-missing-on-web', element: '*', member: 'DrawMode', reason: 'Owner-draw (DrawItem/MeasureItem with a Graphics) is a desktop painting model; web lists use item templates (Repeater, WV-5b).' },
  { kind: 'property-missing-on-web', element: '*', member: 'OwnerDraw', reason: 'Owner-draw is a desktop painting model; web lists use item templates (WV-5b).' },
  { kind: 'event-missing-on-web', element: '*', member: 'OnDrawItem', reason: 'Owner-draw is a desktop painting model (see DrawMode).' },
  { kind: 'event-missing-on-web', element: '*', member: 'OnMeasureItem', reason: 'Owner-draw is a desktop painting model (see DrawMode).' },
  { kind: 'property-missing-on-web', element: 'DatePicker', member: 'Today', reason: 'The web DatePicker uses the browser\'s date; a fixed "today" is a test/design aid to add with the design mode (WV-10).' },
  { kind: 'property-web-only', element: 'TabItem', member: 'Icon', reason: 'Web tabs can show an icon. Proposed for the desktop TabItem.' },
  { kind: 'property-web-only', element: 'Tabs', member: 'Variant', reason: 'Web tab strip looks (underline, pills, stretched). Proposed for the desktop.' },
  { kind: 'property-web-only', element: 'Tabs', member: 'Size', reason: 'Web tab sizes. Proposed for the desktop.' },
  { kind: 'property-web-only', element: 'BreadcrumbItem', member: 'Href', reason: 'A web trail is made of links (open in a new tab); no desktop counterpart.' },
  { kind: 'property-web-only', element: 'BreadcrumbItem', member: 'Icon', reason: 'Web crumbs can show an icon. Proposed for the desktop.' },
  { kind: 'property-missing-on-web', element: 'Breadcrumb', member: 'RootChevron', reason: NOT_YET('WV-5a', 'room for a home icon before the first segment (the web uses BreadcrumbItem Icon).') },
  { kind: 'property-web-only', element: 'Breadcrumb', member: 'Size', reason: 'Web trail scale (Lg = page heading). Proposed for the desktop.' },
  { kind: 'property-web-only', element: 'FloatingWindow', member: 'Resizable', reason: 'The web FloatingWindow can be resizable. Proposed for the desktop.' },
  ...['ConfirmText', 'ConfirmEnabled', 'ConfirmBusy', 'ConfirmDanger', 'ConfirmFocused', 'CancelText', 'CancelEnabled'].map((member) => ({ kind: 'property-web-only' as const, element: 'FloatingWindow', member, reason: "The web FloatingWindow draws its own footer (confirm on the left, cancel on the right: the project's dialog rule, decided in @ui and nowhere else). Desktop dialogs place their buttons in the view (ActionBar.Region)." })),
  { kind: 'property-web-only', element: 'FloatingWindow', member: 'Banner', reason: 'Property element slot <FloatingWindow.Banner> of the @ui FloatingWindow (a message about the window itself, outside the scrolling content). Proposed for the desktop.' },
  { kind: 'property-web-only', element: 'FloatingWindow', member: 'TitleActions', reason: 'Property element slot <FloatingWindow.TitleActions> (buttons of the title band) of the @ui FloatingWindow. Desktop windows have caption buttons of their own.' },
  { kind: 'event-web-only', element: 'FloatingWindow', member: 'OnConfirm', reason: "The web FloatingWindow's footer confirm button (see ConfirmText)." },
  { kind: 'event-web-only', element: 'FloatingWindow', member: 'OnCancel', reason: "The web FloatingWindow's footer cancel button (see CancelText)." },
  { kind: 'property-web-only', element: '*', member: 'FieldClass', reason: 'Like Class (decision 3, tolerated during the migration): the classes of the inner <input>/<textarea>, where the @ui fields put their className.' },
  { kind: 'property-web-only', element: '*', member: 'HostStrings', reason: "Web only: @ui never imports i18n, so an element carrying its own strings receives the host's translator as a prop. The desktop elements read the application's resources themselves." },
  { kind: 'property-missing-on-web', element: 'DataTable', member: 'ReadOnly', reason: 'The web DataTable does not edit cells (WV-5b).' },
  { kind: 'property-missing-on-web', element: 'Column', member: 'ReadOnly', reason: 'The web DataTable does not edit cells (WV-5b).' },
  { kind: 'event-missing-on-web', element: 'DataTable', member: 'OnCellBeginEdit', reason: 'The web DataTable does not edit cells (WV-5b).' },
  { kind: 'event-missing-on-web', element: 'DataTable', member: 'OnCellValidating', reason: 'The web DataTable does not edit cells (WV-5b).' },
  { kind: 'event-missing-on-web', element: 'DataTable', member: 'OnCellValueChanged', reason: 'The web DataTable does not edit cells (WV-5b).' },
  { kind: 'event-missing-on-web', element: 'DataTable', member: 'OnCellEndEdit', reason: 'The web DataTable does not edit cells (WV-5b).' },
  { kind: 'property-missing-on-web', element: 'DataTable', member: 'Culture', reason: 'Web cells are formatted in the user\'s language (i18next); a per-table culture comes with the Column formats (WV-3).' },
  { kind: 'property-web-only', element: 'DataTable', member: 'Selectable', reason: 'Web multi-row selection with check boxes. Proposed for the desktop with the WV-5b alignment.' },
  { kind: 'property-missing-on-web', element: 'DockArea', member: 'Layout', reason: 'The web DockArea keeps its layout in localStorage (StorageKey) and exposes it through a controller ref; a bindable JSON layout comes with WV-5b.' },
  { kind: 'property-missing-on-web', element: 'DockArea', member: 'ActivePanel', reason: 'Through the controller ref on the web (activate); a bindable property comes with WV-5b.' },
  { kind: 'property-missing-on-web', element: 'DockArea', member: 'Theme', reason: 'The web DockArea takes a palette object (DockTheme); the enum mapping comes with WV-5b.' },
  { kind: 'event-missing-on-web', element: 'DockArea', member: 'OnPanelActivated', reason: NOT_YET('WV-5b', 'the web DockArea reports no panel events.') },
  { kind: 'event-missing-on-web', element: 'DockArea', member: 'OnPanelClosed', reason: NOT_YET('WV-5b', 'the web DockArea reports no panel events.') },
  { kind: 'event-missing-on-web', element: 'DockArea', member: 'OnLayoutChanged', reason: NOT_YET('WV-5b', 'the web DockArea reports no panel events.') },
  { kind: 'property-missing-on-web', element: 'DockPanel', member: 'Closable', reason: NOT_YET('WV-5b', 'every web dock panel can be closed.') },
  { kind: 'property-web-only', element: 'WorkspaceShell', member: 'Chromeless', reason: 'Web only: hides the host shell header while an editor is shown (no counterpart in a desktop window).' },
  { kind: 'event-missing-on-web', element: 'WorkspaceShell', member: 'OnSearch', reason: 'The web WorkspaceShell embeds the shell search bar (ShowSearch) instead of raising a search event.' },
  { kind: 'property-missing-on-web', element: 'ToolTip', member: 'AutoPopDelay', reason: 'The @ui Tooltip stays while the pointer rests on its control.' },
  { kind: 'property-missing-on-web', element: 'ToolTip', member: 'ReshowDelay', reason: 'The @ui Tooltip has one delay (InitialDelay).' },
  { kind: 'property-missing-on-web', element: 'ToolTip', member: 'ShowAlways', reason: 'A browser page has no inactive-window state to show tooltips in.' },
  { kind: 'event-missing-on-web', element: 'MenuItem', member: 'OnDropDownOpening', reason: 'MenuDropdown sub-menus open on hover from a static item list; filling them on demand comes with WV-5b.' },

  // ── WV-5a layout and text elements (core pilot: WaffleMenu & AccountMenu) ──
  ...(['Stack', 'Panel', 'UserControl'] as const).map((element): AllowEntry => ({ kind: 'property-mismatch', element, member: 'Padding', reason: 'The web containers keep the Control-level Padding ("left, top, right, bottom", any side), which the desktop containers replace with one F32 for the four sides. The hand-written screens being migrated pad their sides differently (px-5 pt-4 pb-1); proposed for the desktop containers.' })),
  { kind: 'property-web-only', element: 'Stack', member: 'Justify', reason: 'Placement of the children along the flow (start, centre, end, spread): the web screens centre or spread a row (justify-center / justify-between) as often as they fill it. Proposed for the desktop Stack.' },
  { kind: 'property-web-only', element: '*', member: 'Href', reason: 'A web container or link may carry an address (middle click, open in a new tab, the link role), its OnClick still deciding where a plain click goes. No desktop counterpart.' },
  { kind: 'property-web-only', element: '*', member: 'Layout', reason: 'Panel.Layout (Dock | Absolute), VIEWS-SPEC §5.2: flow by default on the web, absolute placement only on request. To add to the desktop registry, where both values keep the WinForms engine.' },
  { kind: 'property-web-only', element: 'ScrollArea', member: 'ScrollBars', reason: 'The axes a web scroll area scrolls (overflow-x / overflow-y). Proposed for the desktop ScrollArea.' },
  { kind: 'property-web-only', element: 'ScrollArea', member: 'ScrollbarGutter', reason: 'CSS scrollbar-gutter: room kept for a classic (non-overlay) scroll bar so the content does not shift or lose its symmetry. Desktop scroll bars overlay the content.' },
  { kind: 'property-missing-on-web', element: 'LinkLabel', member: 'Visited', reason: 'The browser styles visited links itself (:visited); a forced visited look is not allowed by browsers.' },
  { kind: 'property-missing-on-web', element: 'Icon', member: 'IconSize', reason: 'The web Icon is sized by Size (the glyph) and coloured by ForeColor; IconSize/IconColor apply to icons inside other controls.' },
  { kind: 'property-missing-on-web', element: 'Icon', member: 'IconScaling', reason: 'The web Icon draws Kubuno (Lucide) glyphs, which are square: no scaling mode.' },
  { kind: 'property-missing-on-web', element: 'Icon', member: 'IconColor', reason: 'See IconSize: the web Icon takes ForeColor.' },
  { kind: 'property-missing-on-web', element: 'Avatar', member: 'ImageData', reason: 'Image bytes from a Rust Shared<Vec<u8>>: a web photo is an address (Image).' },
  { kind: 'element-mismatch', element: 'Repeater', member: 'default_event', reason: 'The desktop default event (OnItemClick) does not exist on the web yet: the web Repeater repeats a template inside its container, the clicks are the template\'s own (WV-5b list elements).' },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'ItemTemplate', reason: NOT_YET('WV-5b', 'the template is written inside the Repeater; a user control as template comes with the list elements.') },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'Orientation', reason: 'The web Repeater emits its items into its container, which lays them out (a Stack, a TableLayoutPanel): no layout of its own.' },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'Wrap', reason: 'See Orientation: the container wraps (Stack WrapContents).' },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'Spacing', reason: 'See Orientation: the container spaces the items (Stack Gap).' },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'ItemWidth', reason: 'See Orientation: items size in the container\'s flow.' },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'ItemHeight', reason: 'See Orientation: items size in the container\'s flow.' },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'SelectionMode', reason: NOT_YET('WV-5b', 'selection belongs to the list elements (ListBox, ListView).') },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'SelectedIndex', reason: NOT_YET('WV-5b', 'see SelectionMode.') },
  { kind: 'property-missing-on-web', element: 'Repeater', member: 'EmptyText', reason: NOT_YET('WV-5b', 'an empty list shows nothing; the view shows its own empty state.') },
  { kind: 'event-missing-on-web', element: 'Repeater', member: 'OnItemClick', reason: NOT_YET('WV-5b', 'the template\'s elements raise their own clicks.') },
  { kind: 'event-missing-on-web', element: 'Repeater', member: 'OnSelectionChanged', reason: NOT_YET('WV-5b', 'see SelectionMode.') },

  // ── WV-5a: interaction states, outlines and text weights (what the pilot's Class attributes carried) ──
  ...(['HoverBackColor', 'PressedBackColor'] as const).map((member): AllowEntry => ({ kind: 'property-web-only', element: '*', level: 'Control', member, reason: 'Web hover / pressed background of any element with a theme token (the hand-written screens\' hover:bg-… / active:bg-…), so a clickable row or card needs no Class. Proposed for the desktop, whose controls paint their own states today.' })),
  { kind: 'property-web-only', element: '*', level: 'Control', member: 'CornerRadius', reason: 'Web corner radius of any element (a container clips its children to it). The desktop has CornerRadius on PictureBox and FloatingWindow only; proposed for its containers.' },
  ...(['BorderBrush', 'BorderThickness'] as const).map((member): AllowEntry => ({ kind: 'property-web-only', element: '*', level: 'Control', member, reason: 'Web outline of any element in a theme colour (border border-…). The desktop containers have BorderStyle (FixedSingle draws the theme border); proposed as a colour on the desktop.' })),
  { kind: 'property-web-only', element: '*', level: 'Control', member: 'Elevation', reason: 'Web shadow steps of the host (shadow-sm / -md / -lg). Proposed for the desktop (its popups draw their own shadow).' },
  ...(['Stack', 'Panel'] as const).map((element): AllowEntry => ({ kind: 'property-web-only', element, member: 'DividerColor', reason: 'Web lines between the children of a container (divide-y / divide-x of the hand-written lists). Proposed for the desktop Stack and Panel.' })),
  { kind: 'property-web-only', element: 'ScrollArea', member: 'ScrollBarStyle', reason: 'Web: the thin scroll bar inset from rounded corners of the menus (kb-inset-scroll). Desktop scroll bars are overlay bars already.' },
  ...(['Label', 'LinkLabel'] as const).flatMap((element): AllowEntry[] => [
    { kind: 'property-web-only', element, member: 'FontWeight', reason: 'Web text weight on the host\'s steps (font-medium, font-semibold…): typography comes from tokens on the web, where the desktop takes a weight from Font. Proposed for the desktop Label.' },
    { kind: 'property-web-only', element, member: 'FontStyle', reason: 'Web italic text (see FontWeight). Proposed for the desktop Label.' },
  ]),

  // ── WV-5a elements ──
  { kind: 'element-web-only', element: 'SettingsRow', reason: 'New element (WEB-VIEWS §3, decision 2026-10-01 "new components"): the settings row copied in 20 module repositories. Web first; the desktop element (same name and members) comes with the desktop side of WV-5a.' },
  { kind: 'element-web-only', element: 'RadioGroup', reason: 'New element (WEB-VIEWS §3): the radio list copied in 20 module repositories (desktop proposal: RadioButtons, XML_VIEWS §7). Web first; the desktop element comes with the desktop side of WV-5a.' },
  { kind: 'property-web-only', element: 'GroupBox', member: 'Description', reason: 'Web settings sections carry a help line under their title. Proposed for the desktop GroupBox.' },
  { kind: 'property-missing-on-web', element: 'PictureBox', member: 'ImageData', reason: 'Image bytes from a Rust Shared<Vec<u8>>: a web picture is an address (Image, a data: or blob: URL for bytes).' },
  // ── WV-11: what migrated screens need to keep their HTML semantics (the accessibility tree is part of the parity check) ──
  { kind: 'element-web-only', element: 'ReactHost', reason: 'The migration\'s escape hatch (WEB-VIEWS §2.3): a React component that is not a view yet, given by a binding. Web only: the desktop has no React.' },
  { kind: 'property-web-only', element: 'Label', member: 'HtmlTag', reason: 'Web: the HTML element of a text - a heading level (h1–h6, read as a heading by screen readers), an inline run (span)… The desktop Label is a run of text drawn by the control; its accessibility role comes from AccessibleRole.' },
  ...(['Label', 'LinkLabel'] as const).map((element): AllowEntry => ({ kind: 'property-web-only', element, member: 'InheritFontSize', reason: 'Web: a text keeps its parent\'s font size (a run inside a sentence) - CSS inheritance, which desktop controls do not have.' })),
  ...(['Stack', 'Panel'] as const).flatMap((element): AllowEntry[] => [
    { kind: 'property-web-only', element, member: 'HtmlTag', reason: 'Web: the HTML element of a container (section, nav, form, list and item…), which screen readers announce. Desktop containers expose their role through AccessibleRole.' },
    { kind: 'event-web-only', element, member: 'OnSubmit', reason: 'Web: a container that is a form (HtmlTag="Form") is submitted by Enter or a submit button. WinForms has AcceptButton on the form instead.' },
    { kind: 'property-web-only', element, member: 'DataAttributes', reason: 'Web data-* attributes: the styles and scripts of the page find an element by them (the chrome of the shell, a panel). Desktop controls are found by name.' },
    { kind: 'property-web-only', element, member: 'AccessibleModal', reason: 'Web aria-modal: a dialog drawn inside the page keeps screen readers in it. Desktop dialogs are windows, modal by the window manager.' },
  ]),
  { kind: 'property-web-only', element: '*', level: 'Control', member: 'AccessibleHidden', reason: 'Web aria-hidden: an element hidden from screen readers (a decorative backdrop). Desktop controls leave the accessibility tree with AccessibleRole None.' },
  ...(['InputType', 'AutoComplete'] as const).map((member): AllowEntry => ({ kind: 'property-web-only', element: 'TextField', member, reason: 'Web: the input type (password, email… - the masked field and the phone keyboards) and the browser\'s autofill token. The desktop masks with UseSystemPasswordChar (not on the web yet).' })),
  { kind: 'property-web-only', element: 'Button', member: 'ButtonType', reason: 'Web: a submit or reset button of its form (HTML button type). WinForms marks the form\'s AcceptButton / CancelButton instead.' },
  // ── WV-5b navigation elements ──
  ...NAV_ALLOWLIST,
  // ── WV-5b list elements (allowlist.lists.ts) ──
  ...LISTS_ALLOWLIST,
]
