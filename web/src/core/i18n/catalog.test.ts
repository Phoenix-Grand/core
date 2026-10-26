import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import en from './locales/en/core.json'

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
