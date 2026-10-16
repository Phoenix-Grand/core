import { useQuery } from '@tanstack/react-query'
import { KubunoLogo } from '@ui'
import { getPublicConfig } from '../../api/publicConfig'

/**
 * The mark of THIS instance - its own when an administrator set one, the
 * product's otherwise.
 *
 * `instance.logo_url` has been a public setting since the first migration and
 * was editable in the console, but nothing ever read it: a knob that changed
 * nothing. This component is the single place that honours it, so a
 * self-hosted deployment carries its own identity everywhere the product mark
 * used to be hard-coded - sign-in, shell, printed reports.
 *
 * Read from the PUBLIC configuration (`/config`), never from the admin
 * settings: the sign-in page must draw it before anybody is authenticated.
 * Same query key as the sign-in page and the reports header, so the whole
 * console shares one cached read.
 *
 * `className` styles the FALLBACK only. The product mark is a glyph coloured
 * through `currentColor` (`text-primary`, `text-white`); a custom logo is an
 * image whose colours are its own, and tinting it would be wrong.
 */
export function InstanceLogo({ size = 24, className }: { size?: number; className?: string }) {
  const { data } = useQuery({
    queryKey:  ['public-config'],
    queryFn:   getPublicConfig,
    staleTime: 60_000,
  })
  const raw = data?.['instance.logo_url']
  const url = typeof raw === 'string' && raw.trim() !== '' ? raw : null
  const name = typeof data?.['instance.name'] === 'string' ? (data['instance.name'] as string) : 'Kubuno'

  if (!url) return <KubunoLogo size={size} className={className} />

  // Height fixed, width free: a logo is rarely square, and cropping somebody's
  // identity to a ratio the product happens to use is not a detail.
  return (
    <img
      src={url}
      alt={name}
      style={{ height: size }}
      className="w-auto max-w-40 object-contain"
    />
  )
}
