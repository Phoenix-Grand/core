import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@ui'
import { ShieldAlert } from 'lucide-react'

function SectionCrashed() {
  const { t } = useTranslation()
  return (
    <EmptyState
      variant="error"
      icon={<ShieldAlert />}
      title={t('admin.section_error_title')}
      description={t('admin.section_error_desc')}
      action={{ label: t('admin.section_error_retry'), onClick: () => window.location.reload() }}
      t={t}
    />
  )
}

/**
 * Keeps one section's failure inside that section.
 *
 * A delegated administrator sees the console but not every surface, and a panel
 * that assumes its data arrived can throw on a refused request. Without this the
 * whole `/admin` route unmounts and the operator gets a white page with no clue
 * what happened — the one outcome a permission refusal must never produce.
 * Re-keyed on the tab id, so navigating away from a broken section recovers.
 */
export default class AdminSectionBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[admin] section crashed', error, info.componentStack)
  }

  render() {
    return this.state.failed ? <SectionCrashed /> : this.props.children
  }
}
