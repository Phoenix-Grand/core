import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import en from './locales/en/core.json'
import fr from './locales/fr/core.json'
import setupEn from '../setup/locales/en'
import setupFr from '../setup/locales/fr'
import { CAUTION_KEYS, ENUM_OPTIONS, SETTINGS_PAGES, flatKey } from '../../admin/settings/settingsMap'

/** Missing English entries otherwise display a component's French defaultValue. */
it('provides English for literal Core/admin translation and view resource keys', () => {
  const hasKey = (key: string): boolean => {
    const lookup = (name: string) => name.split('.').reduce<unknown>((value, part) =>
      value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined, en)
    return [key, key + '_one', key + '_other'].some(name => typeof lookup(name) === 'string')
  }
  const missing = new Set<string>()
  const root = join(process.cwd(), 'src')
  for (const folder of ['core', 'admin']) {
    const dir = join(root, folder)
    for (const name of readdirSync(dir, { recursive: true }) as string[]) {
      if (/setup[\\/]|[\\/]locales[\\/]|\.(?:test|spec|d)\./.test(name)) continue
      if (!/\.(?:ts|tsx|kbview|kbcontrol)$/.test(name)) continue
      const source = readFileSync(join(dir, name), 'utf8')
      if (/\.kb(?:view|control)$/.test(name)) {
        for (const match of source.matchAll(/\{Res ([\w.-]+)(?=[,}])/g)) {
          if (!hasKey(match[1])) missing.add(match[1])
        }
        continue
      }
      const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        // Subsystem tabs pass their key through a descriptor rather than t('…').
        if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'labelKey' &&
            ts.isStringLiteral(node.initializer) && node.initializer.text.startsWith('admin.')) {
          if (!hasKey(node.initializer.text)) missing.add(node.initializer.text)
        }
        if (ts.isCallExpression(node) && /^(?:t|tr|translate|this\.tr|i18n\.t)$/.test(node.expression.getText(file))) {
          const key = node.arguments[0]
          if (key && ts.isStringLiteral(key) && !hasKey(key.text)) missing.add(key.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
  }
  expect([...missing].sort()).toEqual([])
})

it('provides English for every mapped setting and settings group', () => {
  const groups = SETTINGS_PAGES.flatMap(page => page.groups)
  const keys = groups.flatMap(group => group.keys)
  const required = keys.flatMap(key => [
    `setlabel_${flatKey(key)}`,
    ...(CAUTION_KEYS.has(key) ? [`setwarn_${flatKey(key)}`] : []),
    ...(ENUM_OPTIONS[key] ?? []).filter(option => option.label.startsWith('admin.'))
      .map(option => option.label.replace(/^admin\./, '')),
  ])
  required.push(...groups.flatMap(group => [`sgrp_${group.id}`, `sgrp_${group.id}_desc`]))
  const admin = en.admin as Record<string, string>
  // Without these entries, SettingControl displays the database's French text.
  expect(required.filter(key => !admin[key]?.trim())).toEqual([])
})

it('translates every nonempty label and description seeded in the settings database', () => {
  // Include unclaimed keys too: they still appear on the fallback settings page.
  const sql = readFileSync(join(process.cwd(), '../server/migrations/sqlite/000001_core_schema.up.sql'), 'utf8')
  const missing: string[] = []
  const categories = new Set<string>()
  let checked = 0
  for (const row of sql.matchAll(/INSERT INTO "core"\."settings" \(([^\n]+?)\) VALUES \(([^\n]+)\);/g)) {
    const columns = row[1].split(',').map(column => column.trim().replaceAll('"', ''))
    const values = [...row[2].matchAll(/\s*('(?:[^']|'')*'|[^,]+)\s*(?:,|$)/g)].map(value => {
      const raw = value[1].trim()
      return raw === 'NULL' ? null : raw.replace(/^'|'$/g, '').replaceAll("''", "'")
    })
    expect(values.length).toBe(columns.length)
    const setting = Object.fromEntries(columns.map((column, index) => [column, values[index]]))
    categories.add(setting.category!)
    for (const [column, prefix] of [['label', 'setlabel'], ['description', 'setdesc']]) {
      if (!setting[column]) continue
      const key = `${prefix}_${flatKey(setting.key!)}`
      if (!(en.admin as Record<string, string>)[key]?.trim()) missing.push(key)
      checked++
    }
  }
  expect(checked).toBeGreaterThan(200)
  expect(missing).toEqual([])
  expect([...categories].filter(category => !(en.admin as Record<string, string>)[`cat_${category}`]?.trim())).toEqual([])
})

it('has an English translation family for every French catalogue entry', () => {
  const flatten = (value: object, prefix = ''): string[] => Object.entries(value).flatMap(([key, item]) =>
    item && typeof item === 'object' ? flatten(item, `${prefix}${key}.`) : [`${prefix}${key}`])
  const english = new Set(flatten(en))
  // French has a "many" form; English uses "one" and "other" instead.
  expect(flatten(fr).filter(key => {
    const base = key.replace(/_(?:zero|one|two|few|many|other)$/, '')
    return ![key, base, `${base}_one`, `${base}_other`].some(candidate => english.has(candidate))
  })).toEqual([])
})

it('covers the installation wizard in its separate English namespace', () => {
  const keys = (value: object, prefix = ''): string[] => Object.entries(value).flatMap(([key, item]) =>
    item && typeof item === 'object' ? keys(item, `${prefix}${key}.`) : [`${prefix}${key}`])
  const english = new Set(keys(setupEn))
  expect(keys(setupFr).filter(key => !english.has(key))).toEqual([])
})
