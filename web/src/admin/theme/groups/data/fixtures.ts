/** Static rows/options for the "Données & administration" gallery group. */
import { formatDate as formatLocalizedDate } from '../../../../core/intl/datetime'

export interface DemoMember {
  id:      string
  name:    string
  email:   string
  unit:    string
  role:    'admin' | 'user' | 'guest'
  quota:   number   // bytes used
  max:     number   // bytes granted
  lastSeen: Date
  active:  boolean
}

const GB = 1024 ** 3

// Names are deliberately accented: they double as the sort/fold test corpus
// (localeCompare with sensitivity "base" must interleave "Élodie" with "Emma").
const RAW: Array<[string, string, DemoMember['role'], number, number, string, boolean]> = [
  ['Élodie Marchand',   "Units & measurements",       'admin', 8.4,  10, '2026-08-02T09:12:00', true],
  ['Bruno Nkolo',       "Human resources",    'user',  2.1,  10, '2026-08-01T17:40:00', true],
  ['Émile Sow',         "IT security",  'admin', 9.6,  10, '2026-08-03T07:05:00', true],
  ['Chloé Vasseur',     "Education & training",  'user',  0.4,  10, '2026-07-28T11:22:00', true],
  ['Ada Okonkwo',       "Units & measurements",       'user',  7.8,  10, '2026-08-02T14:03:00', true],
  ['Ismaël Barry',      "Logistics",             'user',  5.2,  10, '2026-07-30T08:47:00', false],
  ['Zoé Lambert',       "Education & training",  'guest', 0.1,   2, '2026-06-19T16:31:00', false],
  ['Hugo Da Silva',     "IT security",  'user',  3.3,  10, '2026-08-01T10:15:00', true],
  ['Naïma Cherif',      "Human resources",    'user',  9.1,  10, '2026-08-03T06:58:00', true],
  ['Théo Rousseau',     "Logistics",             'user',  1.7,  10, '2026-07-25T13:09:00', true],
  ['Wei Zhang',         'Île-de-France',          'user',  6.5,  10, '2026-08-02T19:44:00', true],
  ['Amara Diallo',      'Île-de-France',          'admin', 4.9,  10, '2026-07-31T09:30:00', true],
  ['Lucía Fernández',   "Education & training",  'user',  2.8,  10, '2026-07-29T15:12:00', true],
  ['Noé Charpentier',   "Units & measurements",       'guest', 0.05,  2, '2026-05-11T10:00:00', false],
  ['Sofia Ricci',       "Logistics",             'user',  7.2,  10, '2026-08-01T12:26:00', true],
  ['Yasmine Haddad',    "IT security",  'user',  0.9,  10, '2026-07-27T18:05:00', true],
  ['Piotr Nowak',       "Human resources",    'user',  3.6,  10, '2026-07-26T09:41:00', true],
  ['Íris Almeida',      'Île-de-France',          'user',  5.8,  10, '2026-08-02T08:19:00', true],
  ['Kenji Tanaka',      "Units & measurements",       'user',  9.4,  10, '2026-08-03T05:37:00', true],
  ['Marta Kowalczyk',   "Education & training",  'user',  1.2,  10, '2026-07-24T14:52:00', false],
  ['Oussama Benali',    "Logistics",             'user',  6.1,  10, '2026-07-30T20:11:00', true],
  ['Freja Nilsson',     "IT security",  'guest', 0.3,   2, '2026-07-02T11:48:00', true],
  ['Camille Petit',     "Human resources",    'user',  4.4,  10, '2026-08-01T07:23:00', true],
  ['Diego Morales',     'Île-de-France',          'user',  8.9,  10, '2026-08-02T21:06:00', true],
  ['Anaïs Perrin',      "Units & measurements",       'user',  2.5,  10, '2026-07-28T16:39:00', true],
  ['Tobias Weber',      "Logistics",             'admin', 7.6,  10, '2026-08-03T04:14:00', true],
  ['Leïla Mansouri',    "Education & training",  'user',  0.7,  10, '2026-07-23T10:57:00', true],
  ['Samuel Ncube',      "IT security",  'user',  5.5,  10, '2026-07-31T15:28:00', true],
]

export const DEMO_MEMBERS: DemoMember[] = RAW.map(([name, unit, role, used, max, seen, active], i) => ({
  id:       `m${i + 1}`,
  name,
  email:    `${name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z]+/g, '.')}@kubuno.local`,
  unit,
  role,
  quota:    Math.round(used * GB),
  max:      max * GB,
  lastSeen: new Date(seen),
  active,
}))

/** Long list for the Combobox - the case `Dropdown` cannot serve. */
export const DEMO_UNITS: Array<{ value: string; label: string; group: string; description?: string }> = [
  { value: 'unites',    label: "Units & measurements",      group: "Departments",   description: "Calibration, conversions" },
  { value: 'rh',        label: "Human resources",   group: "Departments",   description: "Contracts, leave" },
  { value: 'secu',      label: "IT security", group: "Departments",   description: 'SOC, incidents' },
  { value: 'educ',      label: "Education & training", group: "Departments",   description: "Internal training" },
  { value: 'logi',      label: "Logistics",            group: "Departments" },
  { value: 'idf',       label: 'Île-de-France',         group: "Regions" },
  { value: 'paca',      label: "Provence-Alpes-Côte d'Azur", group: "Regions" },
  { value: 'ara',       label: 'Auvergne-Rhône-Alpes',  group: "Regions" },
  { value: 'occ',       label: 'Occitanie',             group: "Regions" },
  { value: 'bfc',       label: 'Bourgogne-Franche-Comté', group: "Regions" },
  { value: 'na',        label: 'Nouvelle-Aquitaine',    group: "Regions" },
  { value: 'bre',       label: 'Bretagne',              group: "Regions" },
  { value: 'nor',       label: 'Normandie',             group: "Regions" },
  { value: 'ges',       label: 'Grand Est',             group: "Regions" },
  { value: 'hdf',       label: 'Hauts-de-France',       group: "Regions" },
  { value: 'cvl',       label: 'Centre-Val de Loire',   group: "Regions" },
  { value: 'pdl',       label: 'Pays de la Loire',      group: "Regions" },
  { value: 'cor',       label: 'Corse',                 group: "Regions" },
  { value: 'reu',       label: 'La Réunion',            group: "Overseas" },
  { value: 'mar',       label: 'Martinique',            group: "Overseas" },
  { value: 'gua',       label: 'Guadeloupe',            group: "Overseas" },
  { value: 'guy',       label: 'Guyane',                group: "Overseas" },
  { value: 'may',       label: 'Mayotte',               group: "Overseas" },
]

const KO = 1024
export function formatBytes(bytes: number): string {
  if (bytes < KO) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes / KO
  let i = 0
  while (v >= KO && i < units.length - 1) { v /= KO; i++ }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

export function formatDate(d: Date): string {
  return formatLocalizedDate(d, { day: '2-digit', month: 'short', year: 'numeric' })
}
