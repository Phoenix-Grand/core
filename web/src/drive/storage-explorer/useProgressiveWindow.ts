/**
 * Progressive loading (client windowing) - only the top window of the ordered
 * list (folders first, then files) is mounted; it grows as the sentinel at the
 * bottom enters view: first to fill the visible area, then as the user scrolls.
 * Purely client-side, so it applies to every source uniformly. Selection and
 * keyboard logic keep using the FULL ordered list (selection is id-based, so it
 * is unaffected by what is currently mounted).
 */
import { useEffect, useRef, useState } from 'react'

const WINDOW_BATCH = 30

export function useProgressiveWindow({ totalItems, resetKey, containerRef, isLoading, rootResolved }: {
  totalItems: number
  /** Changing it restarts the window from the top (navigation, sort, filter). */
  resetKey: string
  containerRef: React.RefObject<HTMLDivElement | null>
  isLoading: boolean
  rootResolved: boolean
}) {
  const [visibleCount, setVisibleCount] = useState(WINDOW_BATCH)
  // Restart the window from the top whenever the ordered content changes identity
  // (folder navigation, sort or filter change).
  useEffect(() => { setVisibleCount(WINDOW_BATCH) }, [resetKey])
  const hasMore = visibleCount < totalItems

  const loadSentinelRef = useRef<HTMLDivElement | null>(null)
  const [sentinelVisible, setSentinelVisible] = useState(false)
  useEffect(() => {
    const el = loadSentinelRef.current
    if (!el) { setSentinelVisible(false); return }
    const io = new IntersectionObserver(
      ([entry]) => setSentinelVisible(entry.isIntersecting),
      { root: containerRef.current, rootMargin: '600px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, isLoading, rootResolved]) // eslint-disable-line react-hooks/exhaustive-deps
  // While the sentinel sits inside the viewport (area not yet full, or the scroll
  // reached the bottom), grow the window - filling first, then on scroll.
  useEffect(() => {
    if (!sentinelVisible || !hasMore) return
    const id = requestAnimationFrame(() => setVisibleCount(c => c + WINDOW_BATCH))
    return () => cancelAnimationFrame(id)
  }, [sentinelVisible, hasMore, visibleCount])

  return { visibleCount, hasMore, loadSentinelRef }
}
