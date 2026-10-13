// The condition tree: the UI model, its lossless mapping onto the wire form,
// and the ceilings the server enforces.
//
// ── Why the UI model differs from the wire form ───────────────────────────────
// The wire vocabulary is `all` / `any` / `not` / leaves. An operator does not
// think in terms of `not`: they think "all of these", "at least one of these",
// "none of these". So a UI group carries one of three operators and `none` is
// mapped onto `not` on the way out:
//
//     none of [a]        →  { not: a }                (no extra level)
//     none of [a, b, …]  →  { not: { any: [a, b] } }
//
// and back, so a rule written by another surface round-trips through the builder
// unchanged rather than being rewritten into a shape its author never chose.

import type { CondNode, CompareNode } from './types'
import { evaluateLeaf } from './leafKinds'
import type { Json } from './compare'

export type { Json }
export { compare, lookup } from './compare'

// ── UI model ─────────────────────────────────────────────────────────────────

export type GroupOp = 'all' | 'any' | 'none'

export interface UiGroup {
  kind:     'group'
  id:       string
  op:       GroupOp
  children: UiNode[]
}

export interface UiLeaf {
  kind: 'leaf'
  id:   string
  /** The wire node, verbatim. Unknown shapes travel through untouched. */
  node: CondNode
}

export type UiNode = UiGroup | UiLeaf

let counter = 0
/** Identity for React keys and for the per-node test verdicts. */
export function nodeId(): string {
  counter += 1
  return `n${counter}`
}

export function newGroup(op: GroupOp = 'all', children: UiNode[] = []): UiGroup {
  return { kind: 'group', id: nodeId(), op, children }
}

export function newLeaf(node: CondNode): UiLeaf {
  return { kind: 'leaf', id: nodeId(), node }
}

// ── Wire ⇄ UI ────────────────────────────────────────────────────────────────

export function fromWire(node: CondNode | null | undefined): UiGroup {
  const ui = parse(node ?? { type: 'all', of: [] })
  // The root is always a group: an operator must have somewhere to add a second
  // condition, and a bare leaf at the root leaves them nowhere to click.
  return ui.kind === 'group' ? ui : newGroup('all', [ui])
}

function parse(node: CondNode): UiNode {
  const n = node as { type?: string; of?: unknown }
  if (n.type === 'all' || n.type === 'any') {
    const children = Array.isArray(n.of) ? (n.of as CondNode[]) : []
    return newGroup(n.type, children.map(parse))
  }
  if (n.type === 'not') {
    const inner = n.of as CondNode | undefined
    const i = inner as { type?: string; of?: unknown } | undefined
    // `not(any([…]))` is what this builder writes for "none of"; anything else
    // negated is a "none of" holding exactly that one child.
    if (i?.type === 'any' && Array.isArray(i.of)) {
      return newGroup('none', (i.of as CondNode[]).map(parse))
    }
    return newGroup('none', inner ? [parse(inner)] : [])
  }
  return newLeaf(node)
}

export function toWire(node: UiNode): CondNode {
  if (node.kind === 'leaf') return node.node
  const children = node.children.map(toWire)
  if (node.op === 'all') return { type: 'all', of: children }
  if (node.op === 'any') return { type: 'any', of: children }
  if (children.length === 1) return { type: 'not', of: children[0] }
  return { type: 'not', of: { type: 'any', of: children } }
}

// ── Tree edits (immutable) ───────────────────────────────────────────────────

export function updateNode(root: UiGroup, id: string, fn: (n: UiNode) => UiNode): UiGroup {
  return walk(root, id, fn) as UiGroup
}

function walk(node: UiNode, id: string, fn: (n: UiNode) => UiNode): UiNode {
  if (node.id === id) return fn(node)
  if (node.kind !== 'group') return node
  return { ...node, children: node.children.map(c => walk(c, id, fn)) }
}

export function removeNode(root: UiGroup, id: string): UiGroup {
  const prune = (g: UiGroup): UiGroup => ({
    ...g,
    children: g.children
      .filter(c => c.id !== id)
      .map(c => (c.kind === 'group' ? prune(c) : c)),
  })
  return prune(root)
}

export function addChild(root: UiGroup, parentId: string, child: UiNode): UiGroup {
  return updateNode(root, parentId, n =>
    n.kind === 'group' ? { ...n, children: [...n.children, child] } : n)
}

/** Every node of the tree, depth-first. */
export function flatten(node: UiNode, out: UiNode[] = []): UiNode[] {
  out.push(node)
  if (node.kind === 'group') node.children.forEach(c => flatten(c, out))
  return out
}

// ── Ceilings, computed exactly as the server does ────────────────────────────

/** Depth of the WIRE tree, the root counting as 1 (`Condition::depth`). */
export function wireDepth(node: CondNode): number {
  const n = node as { type?: string; of?: unknown }
  if (n.type === 'all' || n.type === 'any') {
    const kids = Array.isArray(n.of) ? (n.of as CondNode[]) : []
    return 1 + kids.reduce((max, c) => Math.max(max, wireDepth(c)), 0)
  }
  if (n.type === 'not') return 1 + (n.of ? wireDepth(n.of as CondNode) : 0)
  return 1
}

/** Number of comparisons in the whole tree (`Condition::leaves`). */
export function wireLeaves(node: CondNode): number {
  const n = node as { type?: string; of?: unknown }
  if (n.type === 'all' || n.type === 'any') {
    const kids = Array.isArray(n.of) ? (n.of as CondNode[]) : []
    return kids.reduce((sum, c) => sum + wireLeaves(c), 0)
  }
  if (n.type === 'not') return n.of ? wireLeaves(n.of as CondNode) : 0
  return 1
}

// ── Verdicts, for the tester ─────────────────────────────────────────────────

/** Satisfied, not satisfied, or "this build cannot decide it here". */
export type Verdict = true | false | 'unknown'

export function verdictOf(node: UiNode, facts: Json): Verdict {
  if (node.kind === 'leaf') return evaluateLeaf(node.node, facts)
  const verdicts = node.children.map(c => verdictOf(c, facts))
  const unknown = verdicts.includes('unknown')
  if (node.op === 'all') {
    // An empty `all` matches: a rule with no condition fires on every
    // occurrence of its trigger, which is a legitimate thing to want.
    if (verdicts.includes(false)) return false
    return unknown ? 'unknown' : true
  }
  if (node.op === 'any') {
    // …whereas "at least one of nothing" is unsatisfiable.
    if (verdicts.includes(true)) return true
    return unknown ? 'unknown' : false
  }
  // `none`: satisfied when not a single child holds.
  if (verdicts.includes(true)) return false
  return unknown ? 'unknown' : true
}

/** Verdict per node id, for painting the whole tree in one pass. */
export function verdictMap(root: UiNode, facts: Json): Record<string, Verdict> {
  const out: Record<string, Verdict> = {}
  const visit = (n: UiNode) => {
    out[n.id] = verdictOf(n, facts)
    if (n.kind === 'group') n.children.forEach(visit)
  }
  visit(root)
  return out
}

/** Is this leaf a plain comparison this build understands? */
export function asCompare(node: CondNode): CompareNode | null {
  const n = node as CompareNode
  return n.type === 'compare' && typeof n.field === 'string' ? n : null
}
