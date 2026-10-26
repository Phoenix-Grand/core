import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  return () => observer.disconnect()
}

function currentLocale(): string {
  return document.documentElement.lang || 'en'
}

/** Follow the host's selected language without requiring an i18next provider. */
export function useUiLocale(): string {
  return useSyncExternalStore(subscribe, currentLocale, () => 'en')
}
