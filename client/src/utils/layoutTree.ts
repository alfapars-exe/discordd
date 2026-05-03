/**
 * utils/layoutTree.ts — Pure tree operations for the VS Code-style split-pane layout.
 *
 * Single responsibility: own the immutable LayoutNode algebra. No store, no
 * React, no side effects — every function takes a tree and returns a new
 * tree, which makes the algorithms easy to test in isolation and removes
 * tree-shape concerns from uiStore.
 *
 * The layout is a binary tree of split nodes with leaf nodes that point at
 * panel ids. A "split" with one collapsed side promotes its sibling up
 * automatically (see removeLeafFromLayout).
 */

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "leaf"; panelId: string }
  | {
      type: "split";
      direction: SplitDirection;
      children: [LayoutNode, LayoutNode];
      ratio: number;
    };

/**
 * Drop a leaf for a given panelId. Splits whose only remaining child is the
 * sibling collapse upward — preserves the invariant that splits always have
 * two non-null children. Returns null if the entire tree contained only
 * the removed panel.
 */
export function removeLeafFromLayout(
  node: LayoutNode,
  panelId: string,
): LayoutNode | null {
  if (node.type === "leaf") {
    return node.panelId === panelId ? null : node;
  }

  const left = removeLeafFromLayout(node.children[0], panelId);
  const right = removeLeafFromLayout(node.children[1], panelId);

  if (left === null && right === null) return null;
  if (left === null) return right;
  if (right === null) return left;

  return { ...node, children: [left, right] };
}

/**
 * Update the `ratio` of a split node located at the given path. `path` is
 * a sequence of 0/1 indices walking down child branches. Path of length 0
 * targets the root split.
 *
 * Out-of-range / non-split paths return the tree unchanged (defensive — the
 * UI may emit stale paths during fast resize gestures).
 */
export function updateRatioAtPath(
  node: LayoutNode,
  path: number[],
  ratio: number,
): LayoutNode {
  if (path.length === 0 && node.type === "split") {
    return { ...node, ratio };
  }
  if (node.type === "split" && path.length > 0) {
    const [head, ...rest] = path;
    const newChildren: [LayoutNode, LayoutNode] = [...node.children];
    newChildren[head] = updateRatioAtPath(newChildren[head], rest, ratio);
    return { ...node, children: newChildren };
  }
  return node;
}

/** Where the new panel sits relative to the existing target panel. */
export type SplitPosition = "before" | "after";

/**
 * Replace the leaf for `targetPanelId` with a split node containing both the
 * original leaf and a new leaf for `newPanelId`. The new panel goes either
 * before or after the original — controls drop direction.
 *
 * If targetPanelId isn't present in the tree the tree is returned unchanged.
 */
export function insertSplit(
  layout: LayoutNode,
  targetPanelId: string,
  newPanelId: string,
  direction: SplitDirection,
  position: SplitPosition,
): LayoutNode {
  if (layout.type === "leaf") {
    if (layout.panelId !== targetPanelId) return layout;
    const target: LayoutNode = { type: "leaf", panelId: targetPanelId };
    const inserted: LayoutNode = { type: "leaf", panelId: newPanelId };
    return {
      type: "split",
      direction,
      children: position === "before" ? [inserted, target] : [target, inserted],
      ratio: 0.5,
    };
  }
  return {
    ...layout,
    children: [
      insertSplit(layout.children[0], targetPanelId, newPanelId, direction, position),
      insertSplit(layout.children[1], targetPanelId, newPanelId, direction, position),
    ],
  };
}
