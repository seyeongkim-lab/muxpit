# Grid Overview - Implementation Plan

## 1. Requirements Summary

A full-screen grid view that displays ALL open workspaces simultaneously with live miniature xterm.js terminals. The user can see all sessions at a glance and click any cell to switch to that workspace.

### Functional Requirements
- **FR-1**: Toggle grid view with `Ctrl+Shift+G` keyboard shortcut
- **FR-2**: All workspaces rendered simultaneously in a responsive grid layout
- **FR-3**: Each grid cell shows workspace name + live miniature terminal(s)
- **FR-4**: Clicking a cell switches to that workspace and exits grid view
- **FR-5**: Grid auto-arranges: 1=full, 2=side-by-side, 3+=responsive grid
- **FR-6**: Each cell shows the workspace's split layout structure (simplified)

---

## 2. Impact Analysis (Dry-Run)

### File Changes

| File | Action | Risk | Description |
|------|--------|------|-------------|
| `src/components/GridOverview.tsx` | CREATE | Low | New grid overview component |
| `src/components/GridCell.tsx` | CREATE | Low | Individual grid cell with miniature terminals |
| `src/components/MiniTerminal.tsx` | CREATE | Medium | Miniature terminal that re-attaches existing xterm instance |
| `src/components/MiniSplitPane.tsx` | CREATE | Low | Simplified split layout renderer for grid cells |
| `src/App.tsx` | MODIFY | Medium | Add grid view state toggle, render GridOverview |
| `src/components/Terminal.tsx` | MODIFY | High | Export `terminalInstances` map, add detach/reattach logic |
| `src/stores/workspace.ts` | NO CHANGE | - | Read-only access, no modifications needed |
| `src/stores/settings.ts` | NO CHANGE | - | Read-only access for theme colors |

### Risk Assessment

| Risk | Level | Mitigation |
|------|-------|------------|
| WebGL context limit (browsers cap at ~8-16 contexts) | High | Use Canvas2D renderer for mini-terminals, or render static snapshots |
| xterm DOM detach/reattach may lose state | High | Use xterm's `element` property for DOM reparenting instead of dispose/recreate |
| Performance with many workspaces (10+) | Medium | Throttle rendering, use CSS `transform: scale()` instead of re-fitting |
| FitAddon re-fit on grid may corrupt original terminal size | High | Do NOT call `fit()` on mini-terminals; use CSS scaling only |
| Memory: all xterm instances already in memory | Low | No new instances needed; existing ones stay alive |

### Destructive Operations
None. This feature is purely additive (new components + minor modifications to App.tsx and Terminal.tsx).

---

## 3. Codebase Analysis

### Terminal Lifecycle (Critical Understanding)

1. **`terminalInstances`** (Terminal.tsx:59-72): Module-level `Map<string, {...}>` that stores xterm instances, fit addons, ptyId, and cleanup callbacks. Instances persist across React re-renders.

2. **Mounting flow** (Terminal.tsx:140-310):
   - `TerminalLeaf` component checks if instance exists in map
   - If exists: re-attaches DOM element via `containerRef.current.appendChild(xtermEl)` (line 149)
   - If not: creates new XTerm, spawns PTY, stores in map
   - Key insight: **xterm DOM elements can be reparented** -- the existing code already does this (lines 145-157)

3. **WebGL addon** (Terminal.tsx:213-218): Loaded per terminal. WebGL contexts are limited per browser window (typically 8-16). With grid view showing many terminals simultaneously, this WILL hit the limit.

4. **ResizeObserver** (Terminal.tsx:327-335): Each TerminalLeaf has a ResizeObserver that calls `fitAddon.fit()`. When terminals are shown in the grid at reduced size, this will try to resize them to the small container -- which we do NOT want (it would change the actual terminal rows/cols).

### Key Design Decision: CSS Scaling vs. Re-fitting

Two approaches for miniature terminals:

**Option A: CSS `transform: scale()` (RECOMMENDED)**
- Render the terminal at full size but CSS-scale down to fit the grid cell
- Pros: No terminal resize, no PTY resize, output continues normally
- Cons: Slightly blurry at small scales, needs overflow:hidden

**Option B: Static canvas snapshot**
- Capture a screenshot of each terminal canvas and display as `<img>`
- Pros: Zero performance impact, no WebGL issues
- Cons: Not live, need periodic refresh, complex capture logic

**Decision: Option A** (CSS scaling) for the primary approach, with a fallback to canvas snapshot if performance degrades.

### Approach for xterm DOM Management

The grid view must NOT:
- Create new xterm instances (wasteful, PTY duplication)
- Call `fitAddon.fit()` on grid-displayed terminals (would resize PTY)
- Dispose/recreate WebGL addons

The grid view MUST:
- Reparent the xterm DOM element from the normal view container into the grid cell
- Use CSS `transform: scale(factor)` + `transform-origin: top left` to shrink
- When exiting grid view, reparent back to the original container
- During grid view, terminal output continues flowing (PTY events still fire)

### Existing Patterns to Reuse
- `SplitPane` recursive layout rendering -> `MiniSplitPane` for simplified grid cell layout
- `collectLeafIds()` from workspace store -> enumerate terminals per workspace
- `useWorkspaceStore` selector pattern for reactive updates
- Inline styles pattern used throughout the project (no CSS modules)

---

## 4. Implementation Order

### Phase 1: Core Grid Infrastructure
**Goal**: Grid toggle with basic cells showing workspace names
**Risk**: Low

- [ ] **Task 1.1**: Add `gridViewOpen` state to `App.tsx` (simple `useState<boolean>`)
- [ ] **Task 1.2**: Add `Ctrl+Shift+G` keyboard shortcut in App.tsx keydown handler
- [ ] **Task 1.3**: Create `GridOverview.tsx` component with responsive grid layout
  - Calculate grid dimensions based on workspace count
  - 1 workspace = full area, 2 = 2 columns, 3-4 = 2x2, 5-6 = 3x2, etc.
  - Full-screen overlay over the terminal area
- [ ] **Task 1.4**: Create `GridCell.tsx` component showing workspace name, pane count, metadata
- [ ] **Task 1.5**: Wire click handler: clicking a cell calls `setActive(ws.id)` + `setGridViewOpen(false)`

### Phase 2: Live Terminal Display in Grid Cells
**Goal**: Show actual live terminal content in miniature form
**Risk**: High (xterm DOM reparenting, WebGL context limits)

- [ ] **Task 2.1**: Export `terminalInstances` from Terminal.tsx (currently module-private)
  - Export as `getTerminalInstance(leafId: string)` getter function
- [ ] **Task 2.2**: Create `MiniTerminal.tsx` component
  - Accepts `leafId` prop
  - Gets the xterm DOM element from `terminalInstances`
  - Renders a scaled-down container with the xterm element reparented into it
  - Uses `CSS transform: scale()` based on container size vs original terminal size
  - Disables pointer events on the terminal (read-only preview)
  - On unmount, does NOT dispose -- just detaches the DOM element
- [ ] **Task 2.3**: Create `MiniSplitPane.tsx` component
  - Recursive layout renderer similar to SplitPane.tsx but simplified
  - No divider drag handles
  - Renders `MiniTerminal` for leaf nodes
  - Renders simplified split containers for split nodes
  - Handles browser/monitor/claudeSession nodes with placeholder icons
- [ ] **Task 2.4**: Integrate MiniSplitPane into GridCell
- [ ] **Task 2.5**: Handle re-mounting: when grid view closes, ensure the active workspace's terminals are reparented back to their original TerminalLeaf containers
  - The existing `TerminalLeaf` already handles re-attach (lines 145-157)
  - Need to trigger re-render of TerminalLeaf components after grid closes

### Phase 3: Polish and Edge Cases
**Goal**: Handle all edge cases, optimize performance
**Risk**: Medium

- [ ] **Task 3.1**: Handle workspace creation/deletion while grid is open
  - Grid should reactively update when workspaces change
- [ ] **Task 3.2**: Visual polish
  - Highlight active workspace cell
  - Hover effect on cells
  - Workspace name overlay with git branch if available
  - Transition animation for grid open/close (opacity fade)
- [ ] **Task 3.3**: Handle WebGL context exhaustion
  - If more than ~8 terminals, the WebGL contexts for offscreen terminals will be lost
  - xterm.js automatically falls back to canvas renderer when WebGL is lost
  - Test with 10+ workspaces and verify graceful degradation
- [ ] **Task 3.4**: Performance optimization
  - Only re-parent xterm DOM elements for visible grid cells
  - For workspaces with many splits, consider showing only the focused pane
- [ ] **Task 3.5**: Keyboard navigation in grid view
  - Arrow keys to move between cells
  - Enter to select
  - Escape to close grid view
- [ ] **Task 3.6**: Add grid view toggle button to sidebar header (visual indicator)

---

## 5. Quality Gate

### Build verification
```bash
rtk tsc --noEmit
rtk cargo check
```

### Manual testing checklist
- [ ] Ctrl+Shift+G toggles grid view on/off
- [ ] Grid shows all workspaces with correct names
- [ ] Terminal content is visible (live, updating) in grid cells
- [ ] Clicking a cell switches to that workspace
- [ ] Grid auto-arranges: 1 full, 2 side-by-side, 4 = 2x2 grid
- [ ] Split layouts rendered correctly in cells
- [ ] Original terminal works normally after closing grid view
- [ ] Terminal content not lost during grid view toggle
- [ ] PTY output continues flowing while grid is open
- [ ] No WebGL errors in console with <= 8 workspaces
- [ ] Graceful degradation with > 8 workspaces
- [ ] Escape key closes grid view
- [ ] Creating/closing workspace while grid is open works

---

## 6. Concerns and Mitigations

### WebGL Context Limit (Primary Risk)
Browsers limit WebGL contexts to 8-16 per page. Each xterm with WebGL addon consumes one context. When grid view renders ALL terminals simultaneously:
- **Mitigation 1**: xterm.js handles WebGL context loss gracefully (falls back to canvas2d)
- **Mitigation 2**: For workspaces not currently visible, the WebGL context may already be reclaimed
- **Mitigation 3**: If severe, implement a "screenshot mode" that captures canvas as static image for grid display

### DOM Reparenting Stability
Moving xterm's DOM element between containers is already done in the codebase (Terminal.tsx lines 145-157). However, doing this for ALL terminals simultaneously during grid open/close is a heavier operation.
- **Mitigation**: Stagger reparenting with `requestAnimationFrame` to avoid layout thrashing
- **Mitigation**: Use CSS `visibility: hidden` on the normal view instead of removing it, then overlay the grid view on top

### Alternative Approach: Dual DOM (Simpler, Recommended for v1)
Instead of reparenting xterm elements:
1. Keep ALL terminals mounted in their normal positions (hidden when not active)
2. Grid view is a CSS overlay with `pointer-events: none` styled cards
3. Each grid card uses `position: absolute` + `transform: scale()` to show a scaled-down view of the actual terminal area
4. This avoids all reparenting issues but requires ALL workspaces' terminal areas to be in the DOM simultaneously

**This approach changes the architecture**: instead of only rendering the active workspace's `<SplitPane>`, render ALL workspaces but hide inactive ones with `display: none` or `visibility: hidden`. This is actually a prerequisite for live grid previews anyway.

### Revised Architecture (Recommended)

```
App.tsx terminal area:
  {workspaces.map(ws => (
    <div key={ws.id} style={{ display: ws.id === activeId && !gridView ? 'block' : 'none', width: '100%', height: '100%' }}>
      <SplitPane node={ws.layout} workspaceId={ws.id} />
    </div>
  ))}
  {gridView && <GridOverview />}
```

GridOverview uses portal or absolute positioning to show scaled snapshots. But the key change is: **all workspaces are always mounted**. This ensures:
- All xterm instances have DOM containers
- PTY output flows to all terminals
- Grid view just needs to show scaled views

**Trade-off**: More DOM nodes always in memory. For typical usage (2-8 workspaces, 1-4 panes each) this is 2-32 terminal elements -- very manageable.

---

## 7. Implementation Notes
(To be filled by dev agent during implementation)

---

## Architecture Diagram

```
Current:
  App
    Sidebar
    terminalArea
      SplitPane (active workspace ONLY)

Proposed:
  App
    Sidebar
    terminalArea
      [ALL workspaces mounted, inactive ones hidden]
        SplitPane(ws1) -- visible if active && !gridView
        SplitPane(ws2) -- hidden
        SplitPane(ws3) -- hidden
        ...
      GridOverview (overlay, visible when gridView=true)
        GridCell(ws1) -- shows scaled preview
        GridCell(ws2) -- shows scaled preview
        GridCell(ws3) -- shows scaled preview
```

## Estimated Complexity
- Phase 1: ~2 hours (straightforward UI work)
- Phase 2: ~4 hours (xterm DOM management is the core challenge)
- Phase 3: ~3 hours (polish and edge cases)
- Total: ~9 hours

## Key Files Reference
- `src/components/Terminal.tsx` -- xterm lifecycle, `terminalInstances` map
- `src/components/SplitPane.tsx` -- recursive layout renderer
- `src/stores/workspace.ts` -- workspace/layout types and store
- `src/App.tsx` -- main app shell, keyboard shortcuts, workspace rendering
