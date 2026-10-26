import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { localizedCountries } from './countries'
import { monthLabels, weekdayLabels } from './date-picker/helpers'
import { useUiLocale } from './useUiLocale'

afterEach(() => cleanup())

it('localizes calendar and country labels using the selected locale', () => {
  expect(monthLabels('en')).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
  expect(weekdayLabels('en')).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S'])
  expect(monthLabels('fr', 'long')[1]).toBe('février')
  expect(localizedCountries('en').find(c => c.iso2 === 'DE')?.name).toBe('Germany')
  expect(localizedCountries('fr').find(c => c.iso2 === 'DE')?.name).toBe('Allemagne')
})

it('updates an already open control when the host language changes to English', async () => {
  function CalendarLabels() {
    return <span>{monthLabels(useUiLocale(), 'long')[1]}</span>
  }
  document.documentElement.lang = 'fr'
  render(<CalendarLabels />)
  expect(screen.getByText('février')).toBeTruthy()
  await act(async () => { document.documentElement.lang = 'en' })
  expect(screen.getByText('February')).toBeTruthy()
})
