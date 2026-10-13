/**
 * The parts of `AdminPage.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import AdminSectionBoundary from "../AdminSectionBoundary"
import type { AdminPage } from './AdminPage'

export function Part1({ tab, Section, forSection, navigate }: { tab: NonNullable<AdminPage['tab']>; Section: NonNullable<AdminPage['Section']>; forSection: NonNullable<AdminPage['forSection']>; navigate: NonNullable<AdminPage['navigate']> }) {
  return (
    <AdminSectionBoundary key={tab}>
            {Section && <Section params={forSection} navigate={navigate} />}
          </AdminSectionBoundary>
  )
}
