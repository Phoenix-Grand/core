import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'

/**
 * The one write of the account sheet.
 *
 * Every editable card sends `PATCH /admin/users/:id` — the audited directory
 * endpoint — through this hook, so there is a single list of the surfaces a
 * change invalidates. Before, each caller kept its own and they had already
 * diverged: the storage page's consumer table went on showing an old ceiling
 * after the directory had raised it.
 *
 * Nothing here decides *what* to send: each card sends only the fields its draft
 * says moved (see [`useDraft`]). An unchanged value echoed back would still be
 * written, and would still produce an audit entry announcing a modification that
 * did not happen.
 */
export function useUpdateAccount(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<{ user: unknown }>(`/admin/users/${userId}`, body).then(r => r.data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-user', userId] })
      void qc.invalidateQueries({ queryKey: ['admin-users'] })
      // A move changes the per-unit head counts of the unit manager.
      void qc.invalidateQueries({ queryKey: ['admin-org-unit-counts'] })
      // A ceiling change moves every figure of the storage page.
      void qc.invalidateQueries({ queryKey: ['admin-storage'] })
      void qc.invalidateQueries({ queryKey: ['admin-storage-consumers'] })
      void qc.invalidateQueries({ queryKey: ['admin-storage-account-usage'] })
    },
  })
}

/**
 * The sentence the server actually sent.
 *
 * Both shapes on purpose: the API client rejects with a FLAT `{ message, code }`
 * (`normalizeError`, api/client.ts), so reading `response.data.message` alone
 * never finds anything and every refusal reads as the same generic fallback.
 */
export function accountError(err: unknown): string | undefined {
  const e = err as { message?: string; response?: { data?: { message?: string } } }
  return e?.response?.data?.message ?? e?.message
}
