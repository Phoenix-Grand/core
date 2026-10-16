// Kubuno (référence) - override JS de l'objet emblématique : la tuile de fichier
// du Drive ('drive.file-card'). Reproduction STRUCTURELLE fidèle (mêmes classes,
// états de sélection, case flottante, en-tête nom + zone d'aperçu). Point de
// départ éditable : la logique d'icône/miniature du Drive n'est pas accessible à
// un thème, l'extension est affichée à la place de la vignette.
export function register(api) {
  const { React, ui, components } = api
  const h = React.createElement
  const FloatCheckbox = ui.FloatCheckbox

  function FileCard(props) {
    const {
      file, selected, preSelected, focused,
      onSelect, onToggle, onContextMenu, onOpen, thumbH = 128, dense = false,
    } = props
    const ext = String((file && file.name ? file.name.split('.').pop() : '') || '').toUpperCase().slice(0, 5)
    const stateCls = selected
      ? 'border-primary ring-2 ring-primary/20 bg-[#ddeafc]'
      : preSelected
      ? 'border-primary/50 bg-[#ddeafc]'
      : focused
      ? 'border-primary/60 ring-2 ring-primary/20 bg-surface-1'
      : 'border-[#e8eaed] bg-surface-1 hover:border-border hover:bg-[#e4ecf7]'

    return h('div', {
      'data-selectable-id': file && file.id,
      className:
        'group relative rounded-xl border hover:shadow-[0_1px_6px_rgba(0,0,0,0.1)] ' +
        'transition-all min-w-0 select-none cursor-default ' + stateCls,
      onClick: (e) => onSelect && onSelect(file && file.id, e),
      onDoubleClick: () => onOpen && onOpen(file),
      onContextMenu: (e) => onContextMenu && onContextMenu(e, file),
    },
      h(FloatCheckbox, {
        selected: !!selected,
        onToggle: () => onToggle && onToggle(file && file.id),
        className: 'absolute -top-1.5 -left-1.5 z-10',
      }),
      h('div', { className: 'flex items-center gap-2 ' + (dense ? 'px-2 h-8' : 'px-3 h-10') },
        h('span', {
          className: (dense ? 'text-xs' : 'text-[13px]') + ' font-medium text-text-primary truncate flex-1',
        }, file && file.name),
      ),
      h('div', {
        className: 'relative overflow-hidden rounded-lg bg-white flex items-center justify-center ' +
          (dense ? 'mx-1.5 mb-1.5' : 'mx-2 mb-2'),
        style: { height: thumbH },
      },
        h('span', {
          className: 'text-text-tertiary font-semibold',
          style: { fontSize: 22, letterSpacing: '0.06em' },
        }, ext),
      ),
    )
  }

  components.register('drive.file-card', FileCard)
}
