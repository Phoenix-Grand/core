/**
 * The inherited levels of the web element registry: the members every control gets from
 * `Control` (and the view's root from `View`), named and typed exactly like the desktop's
 * (`kubuno-views` `registry::common`, `VIEW_PROPERTIES`, `COMMON_EVENTS`, `VIEW_EVENTS`).
 *
 * Only the members the web runtime implements are listed; the desktop members the web does
 * not have (window chrome, GDI fonts, background images…) are named, with a reason, in
 * `conformance.allowlist.ts`. Every member here is applied by the views runtime around the
 * component (`runtime` targets), not by the component itself; an element remaps one onto a
 * real prop with `inheritedMap` (e.g. `Enabled` → `disabled`).
 */
import type { EventMeta, PropertyMeta } from './types.ts'

const ACCESSIBLE_ROLES = [
  'Default', 'None', 'TitleBar', 'MenuBar', 'ScrollBar', 'Grip', 'Sound', 'Cursor', 'Caret', 'Alert',
  'Window', 'Client', 'MenuPopup', 'MenuItem', 'ToolTip', 'Application', 'Document', 'Pane', 'Chart',
  'Dialog', 'Border', 'Grouping', 'Separator', 'ToolBar', 'StatusBar', 'Table', 'ColumnHeader',
  'RowHeader', 'Column', 'Row', 'Cell', 'Link', 'HelpBalloon', 'Character', 'List', 'ListItem',
  'Outline', 'OutlineItem', 'PageTab', 'PropertyPage', 'Indicator', 'Graphic', 'StaticText', 'Text',
  'PushButton', 'CheckButton', 'RadioButton', 'ComboBox', 'DropList', 'ProgressBar', 'Dial',
  'HotkeyField', 'Slider', 'SpinButton', 'Diagram', 'Animation', 'Equation', 'ButtonDropDown',
  'ButtonMenu', 'ButtonDropDownGrid', 'WhiteSpace', 'PageTabList', 'Clock', 'SplitButton',
  'IpAddress', 'OutlineButton',
] as const

const CURSORS = [
  'Default', 'Arrow', 'IBeam', 'Hand', 'Wait', 'No', 'SizeAll', 'SizeNS', 'SizeWE', 'SizeNWSE',
  'SizeNESW', 'Cross', 'Help', 'AppStarting', 'UpArrow',
] as const

/** `Control`'s properties on the web (desktop names, kinds, defaults and documentation). */
export const CONTROL_PROPERTIES: readonly PropertyMeta<never>[] = [
  {
    name: 'AccessibleName', kind: 'String', default: '', category: 'Accessibility', localizable: true,
    doc: 'Name that screen readers announce for the control. Leave empty to use its text.',
    docFr: "Nom annoncé par les lecteurs d'écran pour le contrôle. Laisser vide pour utiliser son texte.",
    to: { runtime: 'aria-label' },
  },
  {
    name: 'AccessibleDescription', kind: 'String', default: '', category: 'Accessibility', localizable: true,
    doc: 'Description that screen readers announce for the control.',
    docFr: "Description annoncée par les lecteurs d'écran pour le contrôle.",
    to: { runtime: 'aria-description' },
  },
  {
    name: 'AccessibleRole', kind: { Enum: ACCESSIBLE_ROLES }, default: 'Default', category: 'Accessibility',
    doc: "Kind of element that screen readers announce. Default uses the control's own kind.",
    docFr: "Type d'élément annoncé par les lecteurs d'écran. Default utilise le type du contrôle lui-même.",
    to: { runtime: 'aria-role' },
  },
  {
    name: 'AccessibleHidden', kind: 'Bool', default: 'false', category: 'Accessibility', webOnly: true,
    doc: 'Web only: hides the element and its children from screen readers (a decorative backdrop, a duplicate of a text read elsewhere).',
    docFr: "Web uniquement : cache l'élément et ses enfants aux lecteurs d'écran (un voile décoratif, le doublon d'un texte lu ailleurs).",
    to: { runtime: 'aria-hidden' },
  },
  {
    name: 'BackColor', kind: 'String', default: '', category: 'Appearance', editor: 'color', typeConverter: 'Color',
    doc: "Background colour: a theme colour (it follows the light and dark themes) or a colour of your choice. Leave empty to use the parent's.",
    docFr: 'Couleur de fond : une couleur du thème (elle suit les thèmes clair et sombre) ou une couleur de votre choix. Laisser vide pour prendre celle du parent.',
    to: { runtime: 'theme-color' },
  },
  {
    name: 'ForeColor', kind: 'String', default: '', category: 'Appearance', editor: 'color', typeConverter: 'Color',
    doc: "Text colour: a theme colour (it follows the light and dark themes) or a colour of your choice. Leave empty to use the parent's.",
    docFr: 'Couleur du texte : une couleur du thème (elle suit les thèmes clair et sombre) ou une couleur de votre choix. Laisser vide pour prendre celle du parent.',
    to: { runtime: 'theme-color' },
  },
  {
    name: 'Cursor', kind: { Enum: CURSORS }, default: 'Default', category: 'Appearance', editor: 'cursor',
    doc: 'Mouse pointer shown over the control.',
    docFr: 'Pointeur de la souris affiché au-dessus du contrôle.',
    to: { runtime: 'cursor' },
  },
  {
    name: 'RightToLeft', kind: { Enum: ['No', 'Yes', 'Inherit'] }, default: 'Inherit', category: 'Appearance',
    doc: "Shows the text from right to left, for languages such as Arabic or Hebrew. Inherit uses the parent's setting.",
    docFr: "Affiche le texte de droite à gauche, pour des langues comme l'arabe ou l'hébreu. Inherit reprend le réglage du parent.",
    to: { runtime: 'direction' },
  },
  {
    name: 'Enabled', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
    doc: 'Whether the control reacts to the mouse and the keyboard. A disabled control is shown greyed, with everything inside it.',
    docFr: 'Indique si le contrôle réagit à la souris et au clavier. Un contrôle désactivé est grisé, avec tout ce qu\'il contient.',
    to: { runtime: 'enabled' },
  },
  {
    name: 'Visible', kind: 'Bool', default: 'true', category: 'Behavior', bindable: true,
    doc: 'Whether the control is shown when the application runs. The designer still shows it.',
    docFr: "Indique si le contrôle est affiché quand l'application s'exécute. Le concepteur l'affiche toujours.",
    to: { runtime: 'visible' },
  },
  {
    name: 'TabIndex', kind: 'F32', default: '0', category: 'Behavior',
    doc: 'Position of the control in the order the Tab key follows, among the controls of the same container.',
    docFr: 'Position du contrôle dans l\'ordre suivi par la touche Tab, parmi les contrôles du même conteneur.',
    to: { runtime: 'tab-index' },
  },
  {
    name: 'TabStop', kind: 'Bool', default: 'true', category: 'Behavior',
    doc: 'Whether the Tab key stops on the control.',
    docFr: "Indique si la touche Tab s'arrête sur le contrôle.",
    to: { runtime: 'tab-stop' },
  },
  {
    name: 'ContextMenu', kind: 'String', default: '', category: 'Behavior', editor: 'reference:ContextMenu',
    doc: 'Menu shown when the control is right-clicked: the name of a ContextMenu of the view.',
    docFr: "Menu affiché quand on clique sur le contrôle avec le bouton droit : le nom d'un ContextMenu de la vue.",
    to: { runtime: 'context-menu' },
  },
  {
    name: 'AllowDrop', kind: 'Bool', default: 'false', category: 'Behavior',
    doc: 'Whether data (files, text…) can be dragged onto the control: it then raises DragEnter, DragOver, DragLeave and DragDrop.',
    docFr: 'Indique si des données (fichiers, texte…) peuvent être glissées sur le contrôle : il déclenche alors DragEnter, DragOver, DragLeave et DragDrop.',
    to: { runtime: 'allow-drop' },
  },
  {
    name: 'UseWaitCursor', kind: 'Bool', default: 'false', category: 'Behavior', bindable: true,
    doc: 'Shows the busy pointer over the control and everything inside it.',
    docFr: "Affiche le pointeur d'attente au-dessus du contrôle et de tout ce qu'il contient.",
    to: { runtime: 'cursor' },
  },
  {
    name: 'ToolTip', kind: 'String', default: '', category: 'Misc', bindable: true, localizable: true,
    doc: 'Text of the tooltip shown when the mouse rests on the control.',
    docFr: "Texte de l'info-bulle affichée quand la souris s'arrête sur le contrôle.",
    to: { runtime: 'tooltip' },
  },
  {
    name: 'Tag', kind: 'String', default: '', category: 'Data',
    doc: 'Any text you want to keep with the control, for your own code.',
    docFr: 'Texte libre conservé avec le contrôle, pour votre propre code.',
    to: { runtime: 'tag' },
  },
  {
    name: 'Locked', kind: 'Bool', default: 'false', category: 'Design', designTime: true,
    doc: 'Prevents the control from being moved or resized in the designer.',
    docFr: 'Empêche de déplacer ou de redimensionner le contrôle dans le concepteur.',
    to: { runtime: 'design' },
  },
  {
    name: 'GenerateMember', kind: 'Bool', default: 'true', category: 'Design', designTime: true,
    doc: 'Whether your code can find the control by its name.',
    docFr: 'Indique si votre code peut retrouver le contrôle par son nom.',
    to: { runtime: 'design' },
  },
  {
    name: 'Modifiers', kind: { Enum: ['Private', 'Protected', 'Internal', 'ProtectedInternal', 'Public'] },
    default: 'Private', category: 'Design', designTime: true,
    doc: 'Who may use the control from code outside the view; Protected or Public also lets the views inheriting this one change it.',
    docFr: "Qui peut utiliser le contrôle depuis du code extérieur à la vue ; Protected ou Public permet aussi aux vues qui héritent de celle-ci de le modifier.",
    to: { runtime: 'design' },
  },
  {
    name: 'X', kind: 'F32', default: '0', category: 'Layout',
    doc: 'Distance from the left edge of the parent panel, in pixels.',
    docFr: 'Distance depuis le bord gauche du panneau parent, en pixels.',
    to: { runtime: 'layout' },
  },
  {
    name: 'Y', kind: 'F32', default: '0', category: 'Layout',
    doc: 'Distance from the top edge of the parent panel, in pixels.',
    docFr: 'Distance depuis le bord supérieur du panneau parent, en pixels.',
    to: { runtime: 'layout' },
  },
  {
    name: 'Width', kind: 'F32', default: '', category: 'Layout',
    doc: 'Width of the element, in pixels.',
    docFr: "Largeur de l'élément, en pixels.",
    to: { runtime: 'layout' },
  },
  {
    name: 'Height', kind: 'F32', default: '', category: 'Layout',
    doc: 'Height of the element, in pixels.',
    docFr: "Hauteur de l'élément, en pixels.",
    to: { runtime: 'layout' },
  },
  {
    name: 'Dock', kind: { Enum: ['None', 'Top', 'Bottom', 'Left', 'Right', 'Fill'] }, default: 'None', category: 'Layout',
    doc: 'Edge of the parent panel the element is docked to, or Fill to take the remaining space.',
    docFr: "Bord du panneau parent auquel l'élément est ancré, ou Fill pour occuper l'espace restant.",
    to: { runtime: 'layout' },
  },
  {
    name: 'Anchor', kind: 'String', default: 'Top, Left', category: 'Layout',
    doc: 'Edges of the parent panel the element stays attached to when it is resized, for example Top, Left.',
    docFr: "Bords du panneau parent auxquels l'élément reste attaché quand il est redimensionné, par exemple Top, Left.",
    to: { runtime: 'layout' },
  },
  {
    name: 'Margin', kind: 'String', default: '0, 0, 0, 0', category: 'Layout', typeConverter: 'Padding',
    doc: 'Space kept around the control by the container that lines it up with others: left, top, right, bottom, in pixels.',
    docFr: "Espace laissé autour du contrôle par le conteneur qui l'aligne avec d'autres : gauche, haut, droite, bas, en pixels.",
    to: { runtime: 'layout' },
  },
  {
    name: 'Padding', kind: 'String', default: '0, 0, 0, 0', category: 'Layout', typeConverter: 'Padding',
    doc: 'Space inside the control, around its content: left, top, right, bottom, in pixels.',
    docFr: "Espace à l'intérieur du contrôle, autour de son contenu : gauche, haut, droite, bas, en pixels.",
    to: { runtime: 'layout' },
  },
  {
    name: 'MinimumSize', kind: 'String', default: '0, 0', category: 'Layout', typeConverter: 'Size',
    doc: 'Smallest size of the control: width, height in pixels (0 means no limit).',
    docFr: 'Plus petite taille du contrôle : largeur, hauteur en pixels (0 signifie aucune limite).',
    to: { runtime: 'layout' },
  },
  {
    name: 'MaximumSize', kind: 'String', default: '0, 0', category: 'Layout', typeConverter: 'Size',
    doc: 'Largest size of the control: width, height in pixels (0 means no limit).',
    docFr: 'Plus grande taille du contrôle : largeur, hauteur en pixels (0 signifie aucune limite).',
    to: { runtime: 'layout' },
  },
  {
    name: 'Stack.Fill', kind: 'Bool', default: 'false', category: 'Layout',
    doc: 'On a child of a Stack: it takes the room the other children leave along the flow.',
    docFr: "Sur un enfant d'une Stack : il prend la place que les autres enfants laissent le long du flux.",
    to: { runtime: 'layout' },
  },
  {
    name: 'TableLayoutPanel.Row', kind: 'F32', default: '', category: 'Layout',
    doc: 'On a child of a TableLayoutPanel: its row (0 is the first); empty for the next free cell.',
    docFr: "Sur un enfant d'un TableLayoutPanel : sa ligne (0 est la première) ; vide pour la prochaine cellule libre.",
    to: { runtime: 'layout' },
  },
  {
    name: 'TableLayoutPanel.Column', kind: 'F32', default: '', category: 'Layout',
    doc: 'On a child of a TableLayoutPanel: its column (0 is the first); empty for the next free cell.',
    docFr: "Sur un enfant d'un TableLayoutPanel : sa colonne (0 est la première) ; vide pour la prochaine cellule libre.",
    to: { runtime: 'layout' },
  },
  {
    name: 'TableLayoutPanel.RowSpan', kind: 'F32', default: '1', category: 'Layout',
    doc: 'On a child of a TableLayoutPanel: how many rows it spans.',
    docFr: "Sur un enfant d'un TableLayoutPanel : le nombre de lignes qu'il occupe.",
    to: { runtime: 'layout' },
  },
  {
    name: 'TableLayoutPanel.ColumnSpan', kind: 'F32', default: '1', category: 'Layout',
    doc: 'On a child of a TableLayoutPanel: how many columns it spans.',
    docFr: "Sur un enfant d'un TableLayoutPanel : le nombre de colonnes qu'il occupe.",
    to: { runtime: 'layout' },
  },
  // Web only (VIEWS-SPEC §4): tolerated during the migration, flagged and counted by the
  // language server; every repository's budget must reach zero.
  {
    name: 'Class', kind: 'String', default: '', category: 'Appearance', webOnly: true,
    doc: 'Web only, migration aid: Tailwind classes added to the element. Flagged by the language server; use theme tokens and layout elements instead.',
    docFr: "Web uniquement, aide à la migration : classes Tailwind ajoutées à l'élément. Signalé par le serveur de langage ; utilisez plutôt les jetons du thème et les éléments de disposition.",
    to: { runtime: 'class' },
  },
  // Web only (WV-5a): the interaction states and the outline of any element, with theme tokens - what the
  // hand-written screens write as `hover:bg-surface-1`, `rounded-[20px]`, `border border-border`, `shadow-md`.
  // Proposed for the desktop (its controls paint their own hover and pressed states today).
  {
    name: 'HoverBackColor', kind: 'String', default: '', category: 'Appearance', editor: 'color', typeConverter: 'Color', bindable: true, webOnly: true,
    doc: 'Web only: background colour while the mouse is over the control (a theme colour; Token/NN for NN % opacity). Leave empty for none.',
    docFr: "Web uniquement : couleur de fond quand la souris est au-dessus du contrôle (une couleur du thème ; Jeton/NN pour NN % d'opacité). Laisser vide pour aucune.",
    to: { runtime: 'hover-color' },
  },
  {
    name: 'PressedBackColor', kind: 'String', default: '', category: 'Appearance', editor: 'color', typeConverter: 'Color', bindable: true, webOnly: true,
    doc: 'Web only: background colour while the control is pressed. Leave empty for none.',
    docFr: 'Web uniquement : couleur de fond pendant que le contrôle est enfoncé. Laisser vide pour aucune.',
    to: { runtime: 'pressed-color' },
  },
  {
    name: 'CornerRadius', kind: 'F32', default: '', category: 'Appearance', typeConverter: 'CornerRadius', bindable: true, webOnly: true,
    doc: 'Web only: radius of the rounded corners, in pixels (a large value such as 9999 makes a pill). A container clips its children to its corners. Leave empty for the element\'s own corners.',
    docFr: "Web uniquement : rayon des coins arrondis, en pixels (une grande valeur comme 9999 fait une pilule). Un conteneur rogne ses enfants à ses coins. Laisser vide pour les coins propres à l'élément.",
    to: { runtime: 'corner-radius' },
  },
  {
    name: 'BorderBrush', kind: 'String', default: '', category: 'Appearance', editor: 'color', typeConverter: 'Color', bindable: true, webOnly: true,
    doc: 'Web only: colour of a line drawn around the control (BorderThickness pixels wide). Leave empty for none.',
    docFr: 'Web uniquement : couleur d\'une ligne tracée autour du contrôle (large de BorderThickness pixels). Laisser vide pour aucune.',
    to: { runtime: 'border-brush' },
  },
  {
    name: 'BorderThickness', kind: 'F32', default: '1', category: 'Appearance', webOnly: true,
    doc: 'Web only: width of the line drawn with BorderBrush, in pixels.',
    docFr: 'Web uniquement : largeur de la ligne tracée avec BorderBrush, en pixels.',
    to: { runtime: 'border-thickness' },
  },
  {
    name: 'Elevation', kind: { Enum: ['None', 'Sm', 'Md', 'Lg'] }, default: 'None', category: 'Appearance', webOnly: true,
    doc: 'Web only: a shadow under the control, small, medium or large (the host\'s shadow steps).',
    docFr: "Web uniquement : une ombre sous le contrôle, petite, moyenne ou grande (les paliers d'ombre de l'hôte).",
    to: { runtime: 'elevation' },
  },
]

/** `Control`'s common events on the web, raised by the runtime from DOM listeners on the root. */
export const CONTROL_EVENTS: readonly EventMeta<never>[] = [
  { name: 'OnClick', category: 'Action', args: 'MouseEventArgs', from: { dom: 'click', args: 'mouse' },
    doc: 'Occurs when the control is clicked.', docFr: "Se produit quand l'utilisateur clique sur le contrôle." },
  { name: 'OnDoubleClick', category: 'Action', args: 'MouseEventArgs', from: { dom: 'dblclick', args: 'mouse' },
    doc: 'Occurs when the control is double-clicked.', docFr: "Se produit quand l'utilisateur double-clique sur le contrôle." },
  { name: 'OnMouseClick', category: 'Action', args: 'MouseEventArgs', from: { dom: 'click', args: 'mouse' },
    doc: 'Occurs when the control is clicked with the mouse.', docFr: "Se produit quand l'utilisateur clique sur le contrôle avec la souris." },
  { name: 'OnMouseDoubleClick', category: 'Action', args: 'MouseEventArgs', from: { dom: 'dblclick', args: 'mouse' },
    doc: 'Occurs when the control is double-clicked with the mouse.', docFr: "Se produit quand l'utilisateur double-clique sur le contrôle avec la souris." },
  { name: 'OnMouseDown', category: 'Mouse', args: 'MouseEventArgs', from: { dom: 'mousedown', args: 'mouse' },
    doc: 'Occurs when a mouse button is pressed over the control.', docFr: 'Se produit quand un bouton de la souris est enfoncé au-dessus du contrôle.' },
  { name: 'OnMouseUp', category: 'Mouse', args: 'MouseEventArgs', from: { dom: 'mouseup', args: 'mouse' },
    doc: 'Occurs when a mouse button pressed over the control is released.', docFr: 'Se produit quand un bouton de la souris enfoncé au-dessus du contrôle est relâché.' },
  { name: 'OnMouseMove', category: 'Mouse', args: 'MouseEventArgs', from: { dom: 'mousemove', args: 'mouse' },
    doc: 'Occurs when the mouse pointer moves over the control.', docFr: 'Se produit quand le pointeur de la souris se déplace sur le contrôle.' },
  { name: 'OnMouseEnter', category: 'Mouse', args: 'EventArgs', from: { dom: 'mouseenter', args: 'none' },
    doc: 'Occurs when the mouse pointer enters the control.', docFr: 'Se produit quand le pointeur de la souris entre dans le contrôle.' },
  { name: 'OnMouseLeave', category: 'Mouse', args: 'EventArgs', from: { dom: 'mouseleave', args: 'none' },
    doc: 'Occurs when the mouse pointer leaves the control.', docFr: 'Se produit quand le pointeur de la souris quitte le contrôle.' },
  { name: 'OnMouseHover', category: 'Mouse', args: 'EventArgs', from: { dom: 'mousehover', args: 'none' },
    doc: 'Occurs when the mouse pointer rests on the control.', docFr: "Se produit quand le pointeur de la souris s'immobilise sur le contrôle." },
  { name: 'OnMouseWheel', category: 'Mouse', args: 'MouseEventArgs', from: { dom: 'wheel', args: 'mouse' },
    doc: 'Occurs when the mouse wheel moves while the pointer is over the control.', docFr: 'Se produit quand la molette de la souris tourne alors que le pointeur est sur le contrôle.' },
  { name: 'OnKeyDown', category: 'Key', args: 'KeyEventArgs', from: { dom: 'keydown', args: 'dom' },
    doc: 'Occurs when a key is pressed while the control has the focus.', docFr: 'Se produit quand une touche est enfoncée alors que le contrôle a le focus.' },
  { name: 'OnKeyPress', category: 'Key', args: 'KeyPressEventArgs', from: { dom: 'keypress', args: 'dom' },
    doc: 'Occurs when a character key is pressed while the control has the focus.', docFr: 'Se produit quand une touche de caractère est enfoncée alors que le contrôle a le focus.' },
  { name: 'OnKeyUp', category: 'Key', args: 'KeyEventArgs', from: { dom: 'keyup', args: 'dom' },
    doc: 'Occurs when a key is released while the control has the focus.', docFr: 'Se produit quand une touche est relâchée alors que le contrôle a le focus.' },
  { name: 'OnEnter', category: 'Focus', args: 'EventArgs', from: { dom: 'focusin', args: 'none' },
    doc: 'Occurs when the control, or a control inside it, receives the focus.', docFr: "Se produit quand le contrôle, ou un contrôle qu'il contient, reçoit le focus." },
  { name: 'OnGotFocus', category: 'Focus', args: 'EventArgs', from: { dom: 'focus', args: 'none' },
    doc: 'Occurs when the control receives the focus.', docFr: 'Se produit quand le contrôle reçoit le focus.' },
  { name: 'OnLeave', category: 'Focus', args: 'EventArgs', from: { dom: 'focusout', args: 'none' },
    doc: 'Occurs when the focus leaves the control and every control inside it.', docFr: "Se produit quand le focus quitte le contrôle et tous les contrôles qu'il contient." },
  { name: 'OnLostFocus', category: 'Focus', args: 'EventArgs', from: { dom: 'blur', args: 'none' },
    doc: 'Occurs when the control loses the focus.', docFr: 'Se produit quand le contrôle perd le focus.' },
  { name: 'OnResize', category: 'Layout', args: 'EventArgs', from: { dom: 'resize', args: 'none' },
    doc: 'Occurs when the control is resized.', docFr: 'Se produit quand le contrôle est redimensionné.' },
  { name: 'OnSizeChanged', category: 'Property Changed', args: 'EventArgs', from: { dom: 'resize', args: 'none' },
    doc: 'Occurs when the size of the control changes.', docFr: 'Se produit quand la taille du contrôle change.' },
  { name: 'OnDragDrop', category: 'Drag Drop', args: 'DragEventArgs', from: { dom: 'drop', args: 'dom' },
    doc: 'Occurs when data (files, text…) is dropped on the control. Its AllowDrop property must be true, and DragEnter or DragOver must have accepted it (e.effect).',
    docFr: 'Se produit quand des données (fichiers, texte…) sont déposées sur le contrôle. Sa propriété AllowDrop doit valoir true, et DragEnter ou DragOver doit les avoir acceptées (e.effect).' },
  { name: 'OnDragEnter', category: 'Drag Drop', args: 'DragEventArgs', from: { dom: 'dragenter', args: 'dom' },
    doc: 'Occurs when data is dragged over the control. Set e.effect to accept the drop. Its AllowDrop property must be true.',
    docFr: 'Se produit quand des données sont glissées sur le contrôle. Définissez e.effect pour accepter le dépôt. Sa propriété AllowDrop doit valoir true.' },
  { name: 'OnDragOver', category: 'Drag Drop', args: 'DragEventArgs', from: { dom: 'dragover', args: 'dom' },
    doc: 'Occurs while data is dragged over the control. Set e.effect to accept the drop at that point.',
    docFr: 'Se produit pendant que des données sont glissées sur le contrôle. Définissez e.effect pour accepter le dépôt à cet endroit.' },
  { name: 'OnDragLeave', category: 'Drag Drop', args: 'EventArgs', from: { dom: 'dragleave', args: 'none' },
    doc: 'Occurs when data dragged over the control leaves it or the drag is cancelled.',
    docFr: 'Se produit quand des données glissées sur le contrôle le quittent ou que le glissement est annulé.' },
]

/** `View`'s properties - accepted on the view's root element only. */
export const VIEW_PROPERTIES: readonly PropertyMeta<never>[] = [
  {
    name: 'Title', kind: 'String', default: '', category: 'Appearance', bindable: true, localizable: true,
    doc: "Text of the window's title bar, also shown in the task bar. On the web: the page's (or dialog's) title.",
    docFr: 'Texte de la barre de titre de la fenêtre, aussi affiché dans la barre des tâches. Sur le web : le titre de la page (ou du dialogue).',
    to: { runtime: 'view-title' },
  },
]

/** `View`'s events - accepted on the view's root element only. */
export const VIEW_EVENTS: readonly EventMeta<never>[] = [
  { name: 'OnLoad', category: 'Behavior', args: 'EventArgs', from: { runtime: 'view-load', args: 'none' },
    doc: 'Occurs before the view is shown for the first time.', docFr: 'Se produit avant le premier affichage de la vue.' },
  { name: 'OnShown', category: 'Behavior', args: 'EventArgs', from: { runtime: 'view-shown', args: 'none' },
    doc: 'Occurs the first time the view is shown.', docFr: 'Se produit la première fois que la vue est affichée.' },
  // Web only: a page leaves the screen without a window closing (route change, panel closed).
  { name: 'OnUnload', category: 'Behavior', args: 'EventArgs', from: { runtime: 'view-unload', args: 'none' },
    doc: 'Web only: occurs when the view leaves the screen (route change, panel or dialog closed).',
    docFr: "Web uniquement : se produit quand la vue quitte l'écran (changement de page, panneau ou dialogue fermé)." },
]

/**
 * `IconSize`, `IconScaling`, `IconColor` - the own properties every element with an icon has on
 * the desktop. On the web the `icon-node` converter of the element's `Icon` applies them.
 */
export const ICON_PROPERTIES: readonly PropertyMeta<never>[] = [
  {
    name: 'IconSize', kind: 'String', default: '', category: 'Icon', typeConverter: 'IconSize',
    doc: "Size of the icon: Small (16), Medium (20), Large (24), XLarge (32), a number of pixels, or width, height. Leave empty for the control's own size.",
    docFr: "Taille de l'icône : Small (16), Medium (20), Large (24), XLarge (32), un nombre de pixels, ou largeur, hauteur. Laisser vide pour la taille propre au contrôle.",
    to: { runtime: 'icon-size' },
  },
  {
    name: 'IconScaling', kind: { Enum: ['Fit', 'Fill', 'Stretch', 'None'] }, default: 'Fit', category: 'Icon',
    doc: "How an image that is not square fills the icon's box: Fit shows all of it, Fill covers the box, Stretch fits it to the box exactly, None keeps its own size.",
    docFr: "Façon dont une image non carrée remplit la place de l'icône : Fit la montre entière, Fill couvre la place, Stretch l'ajuste exactement, None garde sa propre taille.",
    to: { runtime: 'icon-scaling' },
  },
  {
    name: 'IconColor', kind: 'String', default: '', category: 'Icon', editor: 'color', typeConverter: 'Color',
    doc: "Colour of the icon, every pixel recoloured (for a one-colour icon). Leave empty for the control's colour: a glyph and an SVG drawn in currentColor follow it and the theme, another image keeps its colours.",
    docFr: "Couleur de l'icône, chaque pixel recoloré (pour une icône d'une seule couleur). Laisser vide pour la couleur du contrôle : un glyphe et un SVG dessiné en currentColor la suivent, ainsi que le thème ; une autre image garde ses couleurs.",
    to: { runtime: 'icon-color' },
  },
]

/** `TextBoxBase`'s properties the web supports (each text element maps them in `inheritedMap`). */
export const TEXT_BOX_BASE_PROPERTIES: readonly PropertyMeta<never>[] = [
  {
    name: 'ReadOnly', kind: 'Bool', default: 'false', category: 'Behavior', bindable: true,
    doc: 'Lets the text be selected and copied but not changed.',
    docFr: 'Permet de sélectionner et de copier le texte, mais pas de le modifier.',
    to: { runtime: 'element-mapped' },
  },
  {
    name: 'MaxLength', kind: 'F32', default: '32767', category: 'Behavior',
    doc: 'Largest number of characters that can be typed.',
    docFr: 'Nombre maximal de caractères pouvant être saisis.',
    to: { runtime: 'element-mapped' },
  },
]

/** One inherited level: the members a base class gives every element whose chain names it. */
export interface InheritedLevel {
  readonly properties: readonly PropertyMeta<never>[]
  readonly events: readonly EventMeta<never>[]
}

/**
 * The levels of the control hierarchy the web implements, by class name (the desktop's
 * `base_chain` names). A level absent here contributes nothing on the web; the conformance
 * allowlist says which desktop levels are not implemented yet and why.
 */
export const INHERITED_LEVELS: Readonly<Record<string, InheritedLevel>> = {
  TextBoxBase: { properties: TEXT_BOX_BASE_PROPERTIES, events: [] },
  Control: { properties: CONTROL_PROPERTIES, events: CONTROL_EVENTS },
}

/** The web-only members of the inherited levels (listed in the export, allowlisted in conformance). */
export const WEB_ONLY_INHERITED = new Set([
  'Class', 'OnUnload', 'HoverBackColor', 'PressedBackColor', 'CornerRadius', 'BorderBrush', 'BorderThickness', 'Elevation',
])

/**
 * `HostStrings` - web only: the element's own strings (a close button's name, a default « Cancel », a table's
 * pager) come from the host's catalogue instead of the English defaults of `@ui`: the views runtime gives the
 * component the host's translator as its `t` (what a TSX screen does with `t={t}`). Spread into the elements
 * whose component takes a `t`.
 */
export const HOST_STRINGS = {
  name: 'HostStrings', kind: 'Bool', default: 'false', category: 'Behavior', webOnly: true,
  doc: "Web only: the control's own texts (a close button's name, a default Cancel) in the user's language, from the application's strings.",
  docFr: "Web uniquement : les textes propres au contrôle (le nom d'un bouton Fermer, un Annuler par défaut) dans la langue de l'utilisateur, pris dans les textes de l'application.",
  to: { prop: 't', convert: 'host-t' },
} as const

/**
 * `FieldClass` - web only: Tailwind classes of the field itself (the `<input>` / `<textarea>`), where the `@ui`
 * component puts its `className` (`Class` styles the element's root, around the label and the help line). Tolerated
 * during the migration like `Class`.
 */
export const FIELD_CLASS = {
  name: 'FieldClass', kind: 'String', default: '', category: 'Appearance', webOnly: true,
  doc: 'Web only: style classes of the text box itself (Class styles the whole control, label included).',
  docFr: "Web uniquement : classes de style de la zone de saisie elle-même (Class s'applique au contrôle entier, libellé compris).",
  to: { prop: 'className' },
} as const
