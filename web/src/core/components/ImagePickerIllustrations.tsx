import { useTranslation } from 'react-i18next'
import { useMemo, useState } from 'react'
import type { ImageSourceProps } from '../registry/ImageSourceRegistry'
import { ILLUSTRATIONS, COLLECTIONS, illustrationSrc, illustrationFile } from './illustrations'

/**
 * "Illustrations" tab of the image picker: Kubuno's own artwork, offered to
 * anyone who would rather pick a picture than upload one. Everything is drawn
 * locally (see `illustrations.ts`), so this tab works with no network and owes
 * nothing to a third-party image bank.
 *
 * A picked illustration is handed back as a FILE rather than a URL: the caller
 * usually uploads it (a contact photo, an avatar), and a data: URL would leave
 * whoever reads the record later with a blob they cannot resolve.
 */
export default function ImagePickerIllustrations({ onPick, query }: ImageSourceProps) {
  const { t: translate } = useTranslation()
  const [collection, setCollection] = useState<string | null>(null)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ILLUSTRATIONS.filter(i =>
      (!collection || i.collection === collection) &&
      (!q || i.keywords.some(k => k.toLowerCase().includes(q)) ||
        translate(`image_picker.art_${i.id.split('-')[0]}`).toLowerCase().includes(q) ||
        translate(`image_picker.collection_${i.collection}`).toLowerCase().includes(q))
    )
  }, [query, collection, translate])

  const chip = (id: string | null, label: string) => (
    <button key={id ?? 'all'} type="button" onClick={() => setCollection(id)}
      className={`px-3 py-1.5 rounded-md text-sm whitespace-nowrap transition-colors ${
        collection === id ? 'bg-primary-light text-primary' : 'text-text-secondary hover:bg-surface-2'}`}>
      {label}
    </button>
  )

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 flex-wrap px-1 pb-3 shrink-0">
        {chip(null, translate('image_picker.all'))}
        {COLLECTIONS.map(c => chip(c.id, translate(`image_picker.collection_${c.id}`)))}
      </div>

      {!shown.length ? (
        <p className="flex-1 flex items-center justify-center text-sm text-text-secondary">
          {translate('image_picker.no_illustrations')}</p>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="grid gap-3 pb-2"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))' }}>
            {shown.map(ill => (
              <button key={ill.id} type="button"
                onClick={() => onPick({ kind: 'file', file: illustrationFile(ill) })}
                title={translate(`image_picker.art_${ill.id.split('-')[0]}`)}
                className="aspect-square rounded-full overflow-hidden border-2 border-transparent
                           hover:border-primary focus-visible:border-primary outline-none transition-colors">
                <img src={illustrationSrc(ill.svg)} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
