/**
 * The parts of `InheritanceChainWindow.kbview` still written in React (the codemod could not convert them; see the
 * TODO comments in the view). Each is rendered by a `<ReactHost>` with the values it reads as props.
 */
import { Check, Lock } from "lucide-react"
import { scopeLabel } from "../controls/ProvenanceLine"
import type { InheritanceChainWindow } from './InheritanceChainWindow'
const fmt = (v: unknown) =>
  typeof v === 'string' ? v : JSON.stringify(v)

export function Part1({ l, i, t }: { l: NonNullable<InheritanceChainWindow['rows_items']>[number]['l']; i: NonNullable<InheritanceChainWindow['rows_items']>[number]['i']; t: NonNullable<InheritanceChainWindow['tr']> }) {
  return (
    <li
                  key={`${l.scope_type}-${l.scope_id ?? 'x'}-${i}`}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${
                l.is_winner ? 'border-primary bg-primary-light' : 'border-border bg-surface-1'
              }`}
                  style={{ marginLeft: Math.min(i, 6) * 12 }}
                >
                  <span className="mt-0.5 w-4 shrink-0">
                    {l.is_winner && <Check size={14} className="text-primary" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm text-text-primary">
                        {scopeLabel(t, l.scope_type, l.scope_name)}
                      </span>
                      {l.is_own && (
                        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary">
                          {t('admin.chain_here')}
                        </span>
                      )}
                      {/* Tinted surface + neutral text, never amber text on the
                          card's own background — see ProvenanceLine. */}
                      {l.locked && (
                        <span className="inline-flex items-center gap-1 rounded bg-warning-light px-1.5 py-0.5 text-xs text-text-primary">
                          <Lock size={11} className="text-warning" />
                          {t('admin.chain_locked')}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block break-all font-mono text-xs text-text-secondary">
                      {fmt(l.value)}
                    </span>
                  </span>
                </li>
  )
}
