import { lazy, Suspense } from 'react'

interface Props {
  url:      string
  filename: string
  onClose:  () => void
}

/**
 * The PDF viewer, fetched the first time someone opens a PDF.
 *
 * It used to be exported straight from the SDK surface, which made
 * `pdfjs-dist` - a renderer of several megabytes - part of the chunk that EVERY
 * module loads at start-up. Chat, Mail and Calendar were downloading a PDF
 * engine they never use.
 *
 * The lazy boundary lives here rather than at the call sites so that nothing
 * changes for them: same props, same behaviour, and no `Suspense` to remember.
 * The fallback is deliberately empty - the modal appears when it is ready,
 * which is what a spinner behind a spinner would have looked like anyway.
 */
const Inner = lazy(() => import('./PdfViewerModal'))

export default function PdfViewerModal(props: Props) {
  return (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  )
}
