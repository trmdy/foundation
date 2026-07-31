/**
 * A plain-JS reference model of the same six verbs the adapters implement,
 * operating directly on FdnNode trees with no CRDT involved. Used by
 * harness.test.ts to check that both adapters materialize to the same
 * result as "just apply the verb to the tree" would, for non-conflicting
 * single-author sequences where there's no ambiguity about the right answer.
 */

import type { FdnNode, NodeId } from './contract.js'

function cloneNode(n: FdnNode): FdnNode {
  return {
    id: n.id,
    tag: n.tag,
    props: { ...n.props },
    styles: { ...n.styles },
    ...(n.text !== undefined ? { text: n.text } : {}),
    children: n.children.map(cloneNode),
  }
}

function mapNode(root: FdnNode, id: NodeId, fn: (n: FdnNode) => FdnNode): FdnNode {
  if (root.id === id) return fn(root)
  return { ...root, children: root.children.map((c) => mapNode(c, id, fn)) }
}

export function refInsertNode(root: FdnNode, parent: NodeId, index: number, node: FdnNode): FdnNode {
  return mapNode(root, parent, (p) => {
    const children = [...p.children]
    children.splice(index, 0, cloneNode(node))
    return { ...p, children }
  })
}

function extract(root: FdnNode, id: NodeId): { rest: FdnNode; removed: FdnNode | undefined } {
  if (root.children.some((c) => c.id === id)) {
    const removed = root.children.find((c) => c.id === id)
    return { rest: { ...root, children: root.children.filter((c) => c.id !== id) }, removed }
  }
  let removed: FdnNode | undefined
  const children = root.children.map((c) => {
    const result = extract(c, id)
    if (result.removed) removed = result.removed
    return result.rest
  })
  return { rest: { ...root, children }, removed }
}

export function refRemoveNode(root: FdnNode, id: NodeId): FdnNode {
  return extract(root, id).rest
}

export function refMoveNode(root: FdnNode, id: NodeId, newParent: NodeId, index: number): FdnNode {
  const { rest, removed } = extract(root, id)
  if (!removed) throw new Error(`refMoveNode: unknown node ${id}`)
  return mapNode(rest, newParent, (p) => {
    const children = [...p.children]
    children.splice(index, 0, removed)
    return { ...p, children }
  })
}

export function refSetProp(root: FdnNode, id: NodeId, key: string, value: string): FdnNode {
  return mapNode(root, id, (n) => ({ ...n, props: { ...n.props, [key]: value } }))
}

export function refSetStyle(root: FdnNode, id: NodeId, prop: string, value: string): FdnNode {
  return mapNode(root, id, (n) => ({ ...n, styles: { ...n.styles, [prop]: value } }))
}

export function refSetText(root: FdnNode, id: NodeId, text: string): FdnNode {
  return mapNode(root, id, (n) => ({ ...n, text }))
}
