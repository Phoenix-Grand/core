/**
 * Extension contract: WHO reads the DNS of a domain declared on this instance.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Instance ▸ Domaines does its own small reading of a domain's mail records
 * (MX, SPF present, DMARC present) because an instance that hosts no mail
 * service still has to say something. But a real mail server knows strictly
 * more: which MX it expects to see, how many DNS lookups an SPF record costs,
 * whether the DKIM key it actually signs with is published, what the PTR of its
 * outgoing IP says, and whether its TLS certificate covers the name it
 * announces. None of that is knowable from the core.
 *
 * So the core states the QUESTION and lets whoever can answer it answer:
 * a module registers a provider under `DOMAIN_DIAGNOSTICS`, and the domain
 * sheet renders that instead of its own reading. The core names no module - if
 * nothing is registered, or the provider fails, the sheet keeps its own
 * reading. A section is never left empty.
 *
 * ── Registering (from a module's `register()`) ───────────────────────────────
 *
 *     ExtensionRegistry.register(DOMAIN_DIAGNOSTICS, '<moduleId>', {
 *       fetch: async (domain) => ({ source: 'Module Courrier', covered: true, checks: [...] }),
 *     } satisfies DomainDiagnosticsProvider)
 *
 * The first registered provider wins: two mail servers on one instance is not a
 * configuration this product supports, and silently merging two readings of the
 * same record would be worse than picking one and naming it.
 */
export const DOMAIN_DIAGNOSTICS = 'admin.domain-diagnostics'

/**
 * The colour of one line. `info` = published, but only the operator can judge
 * it; `unknown` = the check could not be made - explicitly not a failure.
 */
export type DomainDiagnosticVerdict = 'ok' | 'warn' | 'fail' | 'info' | 'unknown'

export interface DomainDiagnosticCheck {
  /** Stable identity, usable as a React key (e.g. `spf:example.com`). */
  id:        string
  /** `mx` | `spf` | `dkim` | `dmarc` | `ptr` | `tls` | anything the provider has. */
  kind:      string
  /** The name this line is about: the domain, a DKIM record name, a hostname. */
  scope:     string
  verdict:   DomainDiagnosticVerdict
  /** One sentence, already translated by the provider. */
  summary:   string
  /** What a correct configuration looks like - shown verbatim, to be copied. */
  expected?: string | null
  /** What is actually published. Empty means nothing was found. */
  found?:    string[]
  /**
   * True when the line is about the INSTANCE, not this domain (a PTR record, a
   * TLS certificate). Shown apart so an instance-wide fault does not read as a
   * fault of the domain being looked at.
   */
  instanceWide?: boolean
}

export interface DomainDiagnosticReport {
  /** Who produced this, in words. Displayed - the operator must know who speaks. */
  source:  string
  /**
   * False when the provider does not handle this domain at all. The sheet then
   * keeps its own reading and shows `note` above it, rather than pretending the
   * domain has no records.
   */
  covered: boolean
  checks:  DomainDiagnosticCheck[]
  /** A sentence shown above the lines - why a domain is not covered, typically. */
  note?:   string
  /** Where the operator can open the provider's full report (a real address). */
  href?:   string
}

export interface DomainDiagnosticsProvider {
  /**
   * Reads `domain` now. Rejecting is a legitimate answer: the sheet falls back
   * to the instance's own reading rather than showing an error where a
   * diagnostic was expected.
   */
  fetch: (domain: string) => Promise<DomainDiagnosticReport | null>
}
