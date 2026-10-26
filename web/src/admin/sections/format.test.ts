import { afterEach, expect, it } from 'vitest'
import { formatBytes } from './format'

const initialLanguage = document.documentElement.lang
afterEach(() => { document.documentElement.lang = initialLanguage })

it('formats archive sizes with English units and preserves the existing thresholds and precision', () => {
  expect(formatBytes(1024, 'en')).toBe('1 kB')
  expect(formatBytes(500 * 1024 ** 2, 'en')).toBe('500 MB')
  expect(formatBytes(1024 ** 3, 'en')).toBe('1.0 GB')
  expect(formatBytes(1024 ** 4, 'en')).toBe('1.00 TB')
  for (const value of [-1, NaN, Infinity]) expect(formatBytes(value, 'en')).toBe('-')
})

it('uses French units and number formatting when French is selected', () => {
  expect(formatBytes(1024, 'fr')).toMatch(/^1\s+ko$/)
  expect(formatBytes(500 * 1024 ** 2, 'fr')).toMatch(/^500\s+Mo$/)
  expect(formatBytes(1024 ** 3, 'fr')).toMatch(/^1,0\s+Go$/)
  expect(formatBytes(1024 ** 4, 'fr')).toMatch(/^1,00\s+To$/)
})

it('follows document-language changes for callers that do not pass a locale', () => {
  document.documentElement.lang = 'fr'
  expect(formatBytes(1024 ** 3)).toContain('Go')
  document.documentElement.lang = 'en'
  expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
  document.documentElement.lang = ''
  expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
})
