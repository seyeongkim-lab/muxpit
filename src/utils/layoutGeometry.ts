import type { LayoutNode, SplitNode } from "../stores/workspace";

export interface LeafRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const collectRects = (
  node: LayoutNode,
  x = 0,
  y = 0,
  w = 1,
  h = 1,
  out: LeafRect[] = [],
): LeafRect[] => {
  if (node.type === "split") {
    const r = node.ratio;
    if (node.direction === "horizontal") {
      collectRects(node.children[0], x, y, w * r, h, out);
      collectRects(node.children[1], x + w * r, y, w * (1 - r), h, out);
    } else {
      collectRects(node.children[0], x, y, w, h * r, out);
      collectRects(node.children[1], x, y + h * r, w, h * (1 - r), out);
    }
  } else {
    out.push({ id: node.id, x, y, w, h });
  }
  return out;
};

export type Direction = "left" | "right" | "up" | "down";

export const findNeighbor = (
  layout: LayoutNode,
  currentId: string,
  dir: Direction,
): string | null => {
  const rects = collectRects(layout);
  const cur = rects.find((r) => r.id === currentId);
  if (!cur) return null;
  const curCx = cur.x + cur.w / 2;
  const curCy = cur.y + cur.h / 2;
  const eps = 0.001;

  const candidates = rects.filter((r) => {
    if (r.id === currentId) return false;
    if (dir === "left") return r.x + r.w <= cur.x + eps;
    if (dir === "right") return r.x >= cur.x + cur.w - eps;
    if (dir === "up") return r.y + r.h <= cur.y + eps;
    if (dir === "down") return r.y >= cur.y + cur.h - eps;
    return false;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (dir === "left" || dir === "right") {
      const aCy = a.y + a.h / 2;
      const bCy = b.y + b.h / 2;
      return Math.abs(aCy - curCy) - Math.abs(bCy - curCy);
    }
    const aCx = a.x + a.w / 2;
    const bCx = b.x + b.w / 2;
    return Math.abs(aCx - curCx) - Math.abs(bCx - curCx);
  });

  return candidates[0].id;
};

/**
 * Walk from root to a target leaf, returning the path of split ancestors.
 * Each path entry records the split node and which child contains the target (0 or 1).
 */
const findPath = (
  node: LayoutNode,
  targetId: string,
  path: { node: SplitNode; childIdx: 0 | 1 }[] = [],
): { node: SplitNode; childIdx: 0 | 1 }[] | null => {
  if (node.type !== "split") {
    return node.id === targetId ? path : null;
  }
  const left = findPath(node.children[0], targetId, [...path, { node, childIdx: 0 }]);
  if (left) return left;
  return findPath(node.children[1], targetId, [...path, { node, childIdx: 1 }]);
};

/**
 * Compute a new split ratio in response to a directional resize on the focused leaf.
 * Returns { splitId, ratio } for the nearest matching ancestor split, or null if none.
 *
 * Convention: arrow direction pushes the boundary in that direction.
 *   left / up  → ratio decreases by delta
 *   right / down → ratio increases by delta
 */
export const computeResize = (
  layout: LayoutNode,
  focusedLeafId: string,
  dir: Direction,
  delta = 0.03,
): { splitId: string; ratio: number } | null => {
  const path = findPath(layout, focusedLeafId);
  if (!path || path.length === 0) return null;

  const wantDir = dir === "left" || dir === "right" ? "horizontal" : "vertical";

  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i];
    if (entry.node.direction !== wantDir) continue;

    let ratio = entry.node.ratio;
    if (dir === "left" || dir === "up") ratio -= delta;
    else ratio += delta;
    return { splitId: entry.node.id, ratio };
  }
  return null;
};

/** Collect all leaf-like nodes (leaf, browser, monitor, claudeSession) in tree order. */
export const collectOrderedLeaves = (node: LayoutNode): LayoutNode[] => {
  if (node.type === "split") {
    return [...collectOrderedLeaves(node.children[0]), ...collectOrderedLeaves(node.children[1])];
  }
  return [node];
};
