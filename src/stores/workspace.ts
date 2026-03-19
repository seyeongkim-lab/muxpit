import { create } from "zustand";

// Split tree types
export type SplitDirection = "horizontal" | "vertical";

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number; // 0-1, position of the divider
  children: [LayoutNode, LayoutNode];
}

export interface LeafNode {
  type: "leaf";
  id: string;
  ptyId: number | null;
  cloneFromPtyId?: number; // PTY ID of the source pane when split
  sshCommand?: string; // SSH command to restore on session reload
}

export interface BrowserNode {
  type: "browser";
  id: string;
  url: string;
}

export type LayoutNode = SplitNode | LeafNode | BrowserNode;

export interface Workspace {
  id: string;
  name: string;
  layout: LayoutNode;
  focusedLeafId: string;
}

// Session save/restore types
interface SavedLeaf {
  type: "leaf";
  id: string;
  sshCommand?: string;
}

interface SavedBrowser {
  type: "browser";
  id: string;
  url: string;
}

interface SavedSplit {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  children: [SavedLayout, SavedLayout];
}

type SavedLayout = SavedLeaf | SavedBrowser | SavedSplit;

interface SavedWorkspace {
  id: string;
  name: string;
  layout: SavedLayout;
  focusedLeafId: string;
}

interface SavedSession {
  workspaces: SavedWorkspace[];
  activeId: string | null;
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;

  addWorkspace: (name?: string) => string;
  removeWorkspace: (id: string) => void;
  setActive: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setPtyId: (workspaceId: string, leafId: string, ptyId: number) => void;

  resetWorkspace: (id: string) => void;
  openBrowser: (workspaceId: string, leafId: string, url: string) => void;

  // Split operations
  splitLeaf: (workspaceId: string, leafId: string, direction: SplitDirection) => string;
  closeLeaf: (workspaceId: string, leafId: string) => void;
  setFocusedLeaf: (workspaceId: string, leafId: string) => void;
  setSplitRatio: (workspaceId: string, splitId: string, ratio: number) => void;

  setSshCommand: (workspaceId: string, leafId: string, cmd: string | undefined) => void;

  // Session persistence
  saveSession: () => void;
  restoreSession: () => boolean;
}

let counter = 0;
const genId = () => `n-${Date.now()}-${counter++}`;

// Helper: find and replace a node in the tree
const replaceNode = (
  tree: LayoutNode,
  targetId: string,
  replacement: LayoutNode,
): LayoutNode => {
  if (tree.id === targetId) return replacement;
  if (tree.type === "split") {
    return {
      ...tree,
      children: [
        replaceNode(tree.children[0], targetId, replacement),
        replaceNode(tree.children[1], targetId, replacement),
      ] as [LayoutNode, LayoutNode],
    };
  }
  return tree;
};

// Helper: remove a leaf and return sibling (or null if root)
const removeLeaf = (
  tree: LayoutNode,
  leafId: string,
): LayoutNode | null => {
  if (tree.type === "leaf" || tree.type === "browser") {
    return tree.id === leafId ? null : tree;
  }
  const [left, right] = tree.children;
  if (left.id === leafId) return right;
  if (right.id === leafId) return left;

  const newLeft = removeLeaf(left, leafId);
  if (newLeft !== left) {
    return newLeft === null ? right : { ...tree, children: [newLeft, right] };
  }
  const newRight = removeLeaf(right, leafId);
  if (newRight !== right) {
    return newRight === null ? left : { ...tree, children: [left, newRight] };
  }
  return tree;
};

// Helper: collect all leaf IDs (terminal leaves only)
export const collectLeafIds = (node: LayoutNode): string[] => {
  if (node.type === "leaf") return [node.id];
  if (node.type === "browser") return [node.id];
  return [
    ...collectLeafIds(node.children[0]),
    ...collectLeafIds(node.children[1]),
  ];
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeId: null,

  addWorkspace: (name?: string) => {
    const leafId = genId();
    const wsId = genId();
    const ws: Workspace = {
      id: wsId,
      name: name ?? `Shell ${get().workspaces.length + 1}`,
      layout: { type: "leaf", id: leafId, ptyId: null },
      focusedLeafId: leafId,
    };
    set((s) => ({
      workspaces: [...s.workspaces, ws],
      activeId: wsId,
    }));
    return wsId;
  },

  resetWorkspace: (id: string) => {
    const newLeafId = genId();
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id
          ? {
              ...w,
              name: "Shell 1",
              layout: { type: "leaf" as const, id: newLeafId, ptyId: null },
              focusedLeafId: newLeafId,
            }
          : w,
      ),
    }));
  },

  openBrowser: (workspaceId: string, leafId: string, url: string) => {
    const browserId = genId();
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const splitNode: SplitNode = {
          type: "split",
          id: genId(),
          direction: "horizontal",
          ratio: 0.5,
          children: [
            { type: "leaf", id: leafId, ptyId: (findLeaf(w.layout, leafId))?.ptyId ?? null },
            { type: "browser", id: browserId, url },
          ],
        };
        return { ...w, layout: replaceNode(w.layout, leafId, splitNode) };
      }),
    }));
  },

  removeWorkspace: (id: string) => {
    set((s) => {
      const filtered = s.workspaces.filter((w) => w.id !== id);
      const newActive =
        s.activeId === id
          ? filtered[filtered.length - 1]?.id ?? null
          : s.activeId;
      return { workspaces: filtered, activeId: newActive };
    });
  },

  setActive: (id: string) => set({ activeId: id }),

  renameWorkspace: (id: string, name: string) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, name } : w,
      ),
    }));
  },

  setPtyId: (workspaceId: string, leafId: string, ptyId: number) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const updatePty = (node: LayoutNode): LayoutNode => {
          if (node.type === "leaf" && node.id === leafId) {
            return { ...node, ptyId };
          }
          if (node.type === "split") {
            return {
              ...node,
              children: [
                updatePty(node.children[0]),
                updatePty(node.children[1]),
              ] as [LayoutNode, LayoutNode],
            };
          }
          return node;
        };
        return { ...w, layout: updatePty(w.layout) };
      }),
    }));
  },

  splitLeaf: (workspaceId: string, leafId: string, direction: SplitDirection) => {
    const newLeafId = genId();
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const splitNode: SplitNode = {
          type: "split",
          id: genId(),
          direction,
          ratio: 0.5,
          children: [
            { type: "leaf", id: leafId, ptyId: (findLeaf(w.layout, leafId))?.ptyId ?? null },
            { type: "leaf", id: newLeafId, ptyId: null, cloneFromPtyId: (findLeaf(w.layout, leafId))?.ptyId ?? undefined },
          ],
        };
        return {
          ...w,
          layout: replaceNode(w.layout, leafId, splitNode),
          focusedLeafId: newLeafId,
        };
      }),
    }));
    return newLeafId;
  },

  closeLeaf: (workspaceId: string, leafId: string) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const newLayout = removeLeaf(w.layout, leafId);
        if (!newLayout) return w; // Don't remove last leaf
        const leaves = collectLeafIds(newLayout);
        const newFocus = leaves.includes(w.focusedLeafId)
          ? w.focusedLeafId
          : leaves[0];
        return { ...w, layout: newLayout, focusedLeafId: newFocus };
      }),
    }));
  },

  setFocusedLeaf: (workspaceId: string, leafId: string) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, focusedLeafId: leafId } : w,
      ),
    }));
  },

  setSshCommand: (workspaceId: string, leafId: string, cmd: string | undefined) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const update = (node: LayoutNode): LayoutNode => {
          if (node.type === "leaf" && node.id === leafId) return { ...node, sshCommand: cmd };
          if (node.type === "split") {
            return { ...node, children: [update(node.children[0]), update(node.children[1])] as [LayoutNode, LayoutNode] };
          }
          return node;
        };
        return { ...w, layout: update(w.layout) };
      }),
    }));
  },

  saveSession: () => {
    const state = get();
    const stripPty = (node: LayoutNode): SavedLayout => {
      if (node.type === "leaf") return { type: "leaf", id: node.id, sshCommand: node.sshCommand };
      if (node.type === "browser") return { type: "browser", id: node.id, url: node.url };
      return {
        type: "split",
        id: node.id,
        direction: node.direction,
        ratio: node.ratio,
        children: [stripPty(node.children[0]), stripPty(node.children[1])],
      };
    };

    const session: SavedSession = {
      workspaces: state.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        layout: stripPty(w.layout),
        focusedLeafId: w.focusedLeafId,
      })),
      activeId: state.activeId,
    };

    try {
      localStorage.setItem("wmux-session", JSON.stringify(session));
    } catch {}
  },

  restoreSession: () => {
    try {
      const raw = localStorage.getItem("wmux-session");
      if (!raw) return false;

      const session: SavedSession = JSON.parse(raw);
      if (!session.workspaces || session.workspaces.length === 0) return false;

      const restoreLayout = (node: SavedLayout): LayoutNode => {
        if (node.type === "leaf") return { type: "leaf", id: node.id, ptyId: null, sshCommand: node.sshCommand };
        if (node.type === "browser") return { type: "browser", id: node.id, url: node.url };
        return {
          type: "split",
          id: node.id,
          direction: node.direction,
          ratio: node.ratio,
          children: [restoreLayout(node.children[0]), restoreLayout(node.children[1])],
        };
      };

      const workspaces: Workspace[] = session.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        layout: restoreLayout(w.layout),
        focusedLeafId: w.focusedLeafId,
      }));

      set({ workspaces, activeId: session.activeId });
      return true;
    } catch {
      return false;
    }
  },

  setSplitRatio: (workspaceId: string, splitId: string, ratio: number) => {
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const updateRatio = (node: LayoutNode): LayoutNode => {
          if (node.type === "split" && node.id === splitId) {
            return { ...node, ratio: Math.max(0.1, Math.min(0.9, ratio)) };
          }
          if (node.type === "split") {
            return {
              ...node,
              children: [
                updateRatio(node.children[0]),
                updateRatio(node.children[1]),
              ] as [LayoutNode, LayoutNode],
            };
          }
          return node;
        };
        return { ...w, layout: updateRatio(w.layout) };
      }),
    }));
  },
}));

// Helper: find a leaf node by id
const findLeaf = (node: LayoutNode, id: string): LeafNode | null => {
  if (node.type === "leaf") return node.id === id ? node : null;
  if (node.type === "browser") return null;
  return findLeaf(node.children[0], id) ?? findLeaf(node.children[1], id);
};

// Helper: find leaf by ptyId across all workspaces
export const findLeafByPtyId = (
  workspaces: Workspace[],
  ptyId: number,
): { workspaceId: string; leafId: string; leafCount: number } | null => {
  for (const ws of workspaces) {
    const leaves = collectLeafIds(ws.layout);
    for (const leafId of leaves) {
      const leaf = findLeaf(ws.layout, leafId);
      if (leaf && leaf.ptyId === ptyId) {
        return { workspaceId: ws.id, leafId, leafCount: leaves.length };
      }
    }
  }
  return null;
};
