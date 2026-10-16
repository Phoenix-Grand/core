// Data access of the buildings-and-resources section.
//
// Four cache entries, one per thing the page reads: the overview counters, the
// buildings (floors included), the resources and the features. They are kept
// apart rather than folded into one call because they are edited independently
// and refetched independently - but every mutation invalidates *all* of them,
// for a reason specific to this model: the composed name of a resource contains
// its building's key and its features' names, so renaming either rewrites rows
// the caller never touched.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../core/api/client'

export const RESOURCES_KEY = ['admin-resources'] as const
export const BUILDINGS_KEY = ['admin-buildings'] as const
export const FEATURES_KEY  = ['admin-resource-features'] as const
export const OVERVIEW_KEY  = ['admin-resources-overview'] as const

/** The closed category vocabulary, mirroring the column's CHECK. */
export type ResourceCategory = 'meeting_room' | 'other'

export interface Building {
  id:           string
  building_key: string
  name:         string | null
  address:      string
  description:  string | null
  latitude:     number | null
  longitude:    number | null
  /** In display order, lowest first. The order is data, not a sort. */
  floors:       string[]
  resource_count: number
}

export interface ResourceFeature {
  id:          string
  name:        string
  description: string | null
  resource_count: number
}

/** The building fields carried alongside every resource row. */
export interface ResourceBuilding {
  id:        string
  key:       string
  name:      string | null
  address:   string
  latitude:  number | null
  longitude: number | null
}

export interface Resource {
  id:               string
  name:             string
  /** Composed by the server, never typed. What everybody outside this page reads. */
  generated_name:   string
  category:         ResourceCategory
  resource_type:    string | null
  floor_name:       string
  floor_section:    string | null
  capacity:         number
  /** Never handed back automatically when its meeting empties out. */
  release_exempt:   boolean
  user_description: string | null
  description:      string | null
  /** The building it sits in, exactly as the internal catalogue publishes it. */
  building:         ResourceBuilding
  feature_ids:      string[]
  feature_names:    string[]
}

export interface ResourceOverview {
  buildings:       number
  resources:       number
  features:        number
  rooms:           number
  room_seats:      number
  /** The three gaps - what makes the inventory unfinished rather than absent. */
  empty_buildings: number
  undescribed:     number
  unused_features: number
}

export interface BuildingInput {
  building_key: string
  name:         string | null
  address:      string
  description:  string | null
  latitude:     number | null
  longitude:    number | null
  floors:       string[]
}

export interface ResourceInput {
  name:             string
  building_id:      string
  category:         ResourceCategory
  resource_type:    string | null
  floor_name:       string
  floor_section:    string | null
  capacity:         number
  user_description: string | null
  description:      string | null
  feature_ids:      string[]
  release_exempt:   boolean
}

export interface FeatureInput {
  name:        string
  description: string | null
}

export interface BuildingList {
  buildings: Building[]
  limits:    { floors: number; floor_name: number }
}

export interface ResourceList {
  resources:  Resource[]
  categories: ResourceCategory[]
  limits: {
    name: number; floor_name: number; floor_section: number
    capacity: number; description: number
  }
}

export function useResourceOverview() {
  return useQuery({
    queryKey: OVERVIEW_KEY,
    queryFn: () => api.get<ResourceOverview>('/admin/resources/overview').then(r => r.data),
    staleTime: 30_000,
  })
}

export function useBuildings() {
  return useQuery({
    queryKey: BUILDINGS_KEY,
    queryFn: () => api.get<BuildingList>('/admin/buildings').then(r => r.data),
    staleTime: 30_000,
  })
}

export function useResources() {
  return useQuery({
    queryKey: RESOURCES_KEY,
    queryFn: () => api.get<ResourceList>('/admin/resources').then(r => r.data),
    staleTime: 30_000,
  })
}

export function useResourceFeatures() {
  return useQuery({
    queryKey: FEATURES_KEY,
    queryFn: () => api.get<{ features: ResourceFeature[] }>('/admin/resource-features').then(r => r.data),
    staleTime: 30_000,
  })
}

/**
 * Every mutation of this section invalidates every one of its caches.
 *
 * Deliberately blunt, and correct here rather than lazy: a building's key and a
 * feature's name are both *inside* the composed name of resources, so a write to
 * one of those two lists changes rows in another. Invalidating only what was
 * written would leave the resource table showing names the server no longer
 * agrees with, which is the one thing this screen must never do.
 */
function useSectionMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of [RESOURCES_KEY, BUILDINGS_KEY, FEATURES_KEY, OVERVIEW_KEY]) {
        void qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}

export function useCreateBuilding() {
  return useSectionMutation((input: BuildingInput) =>
    api.post('/admin/buildings', input).then(r => r.data))
}

export function useUpdateBuilding() {
  return useSectionMutation(({ id, input }: { id: string; input: BuildingInput }) =>
    api.patch(`/admin/buildings/${id}`, input).then(r => r.data))
}

export function useDeleteBuilding() {
  return useSectionMutation((id: string) =>
    api.delete(`/admin/buildings/${id}`).then(r => r.data))
}

export function useCreateResource() {
  return useSectionMutation((input: ResourceInput) =>
    api.post('/admin/resources', input).then(r => r.data))
}

export function useUpdateResource() {
  return useSectionMutation(({ id, input }: { id: string; input: ResourceInput }) =>
    api.patch(`/admin/resources/${id}`, input).then(r => r.data))
}

export function useDeleteResource() {
  return useSectionMutation((id: string) =>
    api.delete(`/admin/resources/${id}`).then(r => r.data))
}

export function useCreateFeature() {
  return useSectionMutation((input: FeatureInput) =>
    api.post('/admin/resource-features', input).then(r => r.data))
}

export function useUpdateFeature() {
  return useSectionMutation(({ id, input }: { id: string; input: FeatureInput }) =>
    api.patch(`/admin/resource-features/${id}`, input).then(r => r.data))
}

export function useDeleteFeature() {
  return useSectionMutation((id: string) =>
    api.delete(`/admin/resource-features/${id}`).then(r => r.data))
}

/** One implementation, shared: reading the failure of a request is the same
 *  problem everywhere. Re-exported under the name this section's callers
 *  already use. */
export { apiErrorMessage as errorMessage } from '../../../core/api/errorMessage'

// ── Room usage ───────────────────────────────────────────────────────────────

export interface RoomStats {
  /** False when the module that holds the bookings is not installed or silent. */
  available:       boolean
  reason?:         'module_absent' | 'unreachable' | 'refused' | 'unreadable'
  bookings:        number
  booked_hours:    number
  declined:        number
  released_hours:  number
  rooms:           number
  available_hours: number
  /** `null` when there is no room at all - a rate over nothing is not zero. */
  booking_rate:    number | null
  per_day:  { date: string; hours: number; bookings: number }[]
  /** `hour` is read on a clock in the zone the request named, not in UTC. */
  per_hour: { hour: number; hours: number }[]
  per_room: { resource_id: string; name: string; capacity: number; hours: number; bookings: number; declined: number }[]
}

/** The figures are the calendar's, relayed by the core: the console never reads
 *  another component's schema.
 *
 *  The browser's own zone travels with the window. "Nine o'clock" and "Monday"
 *  are what a clock somewhere says about an instant, so the buckets have to be
 *  cut where the person reading them lives - bucketed in UTC, a Paris morning
 *  meeting would show up an hour early. */
export function useRoomStats(from: string, to: string, enabled: boolean) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return useQuery({
    queryKey: ['admin-room-stats', from, to, tz],
    queryFn:  () => api
      .get<RoomStats>('/admin/resources/room-stats', { params: { from, to, tz } })
      .then(r => r.data),
    enabled,
    staleTime: 60_000,
  })
}
