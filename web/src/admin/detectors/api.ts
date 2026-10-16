// Data access of the content-detector screen.
//
// Three questions, three cache entries: the catalogue, one detector's sheet
// (with the rules that use it), and a trial run. The trial is a MUTATION rather
// than a query on purpose - it must never be cached, never be refetched on
// focus, and never be replayed: the body carries text an administrator pasted,
// and the only correct number of times to send it is exactly once, when they
// asked.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../core/api/client'

export const DETECTORS_KEY = ['admin-detectors'] as const

export type DetectorKind = 'regex' | 'wordlist' | 'checksum'
export type ChecksumAlgo = 'luhn' | 'iban' | 'nir' | 'siret' | 'rib_fr'

export interface Detector {
  id:                 string
  key:                string
  label:              string
  description:        string | null
  category:           string
  kind:               DetectorKind
  pattern:            string | null
  terms:              string[]
  checksum:           ChecksumAlgo | null
  proximity_terms:    string[]
  proximity_window:   number
  proximity_required: boolean
  base_confidence:    number
  checksum_bonus:     number
  proximity_bonus:    number
  /** The three thresholds. The third is the one that makes a leak rule mean
   *  what it says: fifty copies of one number are not fifty numbers. */
  min_confidence:     number
  min_matches:        number
  min_unique_matches: number
  is_enabled:         boolean
  is_builtin:         boolean
  created_at:         string
  updated_at:         string
}

export interface DetectorLimits {
  pattern_len:    number
  terms:          number
  term_len:       number
  sample_bytes:   number
  compiled_bytes: number
}

export interface DetectorList {
  detectors: Detector[]
  kinds:     DetectorKind[]
  checksums: ChecksumAlgo[]
  limits:    DetectorLimits
}

/** What the editor sends. Every optional field falls back to the server default. */
export interface DetectorInput {
  key:                string
  label:              string
  description?:       string | null
  category?:          string
  kind:               DetectorKind
  pattern?:           string | null
  terms?:             string[]
  checksum?:          ChecksumAlgo | null
  proximity_terms?:   string[]
  proximity_window?:  number
  proximity_required: boolean
  base_confidence?:   number
  checksum_bonus?:    number
  proximity_bonus?:   number
  min_confidence?:    number
  min_matches?:       number
  min_unique_matches?: number
  is_enabled:         boolean
}

/**
 * One match of a trial run.
 *
 * Offsets, never text. The sample lives in the browser - the administrator typed
 * it there - so the highlighting is done locally and the response can keep the
 * promise the rest of the feature makes: no inspected value in a JSON body.
 */
export interface TestMatch {
  start:      number
  end:        number
  confidence: number
  counted:    boolean
}

export interface TestResult {
  matches: TestMatch[]
  summary: {
    min_confidence:     number
    matches:            number
    unique_matches:     number
    best_confidence:    number
    min_matches:        number
    min_unique_matches: number
    would_match:        boolean
  }
  scan: {
    bytes:     number
    truncated: boolean
    timed_out: boolean
    saturated: boolean
  }
}

export function useDetectors() {
  return useQuery({
    queryKey: DETECTORS_KEY,
    queryFn: () => api.get<DetectorList>('/admin/detectors').then(r => r.data),
    staleTime: 30_000,
  })
}

export function useDetector(id: string | null) {
  return useQuery({
    queryKey: [...DETECTORS_KEY, id],
    enabled: !!id,
    queryFn: () => api
      .get<{ detector: Detector; used_by: string[] }>(`/admin/detectors/${id}`)
      .then(r => r.data),
  })
}

function useDetectorMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: DETECTORS_KEY })
      // A detector is the vocabulary of a rule: the rule catalogue offers the
      // enabled ones, so it goes stale the moment one is added or disabled.
      void qc.invalidateQueries({ queryKey: ['admin-rules-catalog'] })
    },
  })
}

export function useCreateDetector() {
  return useDetectorMutation((input: DetectorInput) =>
    api.post('/admin/detectors', input).then(r => r.data))
}

export function useUpdateDetector() {
  return useDetectorMutation(({ id, input }: { id: string; input: DetectorInput }) =>
    api.patch(`/admin/detectors/${id}`, input).then(r => r.data))
}

export function useDeleteDetector() {
  return useDetectorMutation((id: string) =>
    api.delete(`/admin/detectors/${id}`).then(r => r.data))
}

/**
 * A trial run. Not a query: nothing about it may be cached, retried or replayed.
 */
export function useTestDetector() {
  return useMutation({
    mutationFn: (body: { sample: string; detector_id?: string; draft?: DetectorInput; min_confidence?: number }) =>
      api.post<TestResult>('/admin/detectors/test', body).then(r => r.data),
    retry: false,
    gcTime: 0,
  })
}

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../core/api/errorMessage'
