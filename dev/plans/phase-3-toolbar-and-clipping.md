# Phase 3 — Toolbar & Clipping Tool

## Goal

Add a top toolbar with tool placeholders, and implement the first real tool: a section/clipping plane that the user places by clicking a surface.

## Toolbar Design

A horizontal bar at the top of the viewport with icon buttons. Only one tool can be active at a time.

### Tool slots (Phase 3 implements only the clipping tool — the rest are placeholders):

| Icon | Tool | Status |
|------|------|--------|
| Scissors | Section/Clip | **Implement now** |
| Transparent cube | Transparify all | Placeholder |
| Reset icon | Reset view | Placeholder |

### Active tool state machine

Tools follow a centralized activation pattern managed by a `ToolManager`:

```
IDLE → user clicks tool → ACTIVE (tool.activate())
ACTIVE → user clicks abort / presses Escape / clicks another tool → IDLE (tool.deactivate())
```

Every tool implements a `Tool` interface:
```ts
interface Tool {
  name: string;
  activate(): void;
  deactivate(): void;
  dispose(): void;
}
```

The `ToolManager` ensures only one tool is active at a time. Switching tools auto-deactivates the previous one. An "Abort" button appears whenever any tool is active, and calls `deactivate()` on the current tool.

This is the centralized cancel mechanism — any tool that creates state (clipping planes, selection highlights, measurements) cleans up in its own `deactivate()`.

## Clipping Tool — Detailed Design

### User flow

1. User clicks the scissors button in the toolbar
2. Cursor changes to crosshair — tool is now listening for a surface click
3. User clicks on a model surface
4. A clipping plane is created at the click point, oriented along the surface normal
5. A visual plane helper + scissors icon appears at the clip location
6. User can **drag the scissors icon** to slide the plane along its normal
7. The model is clipped in real-time as the plane moves
8. User clicks "Abort" (or Escape, or another tool) → clipping plane is removed, model restored

### Technical approach

**Surface detection:**
- `THREE.Raycaster` from camera through mouse position
- Hit result gives us: intersection point + face normal
- These define the clipping plane

**Clipping:**
- `THREE.Plane` created from intersection point + face normal
- Applied via `renderer.clippingPlanes = [plane]`
- `renderer.localClippingEnabled = true`

**Visual helper:**
- `THREE.PlaneHelper` or a custom semi-transparent mesh to show the clip plane
- A small scissors sprite/icon at the plane center (drag handle)

**Dragging:**
- On mousedown on the scissors icon → enter drag mode
- On mousemove → project mouse movement onto the plane's normal axis
- Update `plane.constant` as user drags → real-time clip update
- On mouseup → exit drag mode

**Deactivation (abort):**
- Remove the `THREE.Plane` from `renderer.clippingPlanes`
- Remove the visual helper + drag handle from the scene
- Restore cursor to default

## Module Structure

```
src/
  tools/
    Tool.ts            ← Tool interface + ToolManager class
    ClippingTool.ts    ← Section plane tool implementation
    index.ts           ← exports
  ui/
    Toolbar.ts         ← Toolbar DOM component
    index.ts           ← exports
```

## Checklist

### Preparation
- [ ] Create branch `feature/toolbar-clipping`
- [ ] Run all existing tests

### Toolbar + ToolManager
- [ ] Define `Tool` interface in `src/tools/Tool.ts`
- [ ] Implement `ToolManager` (activate/deactivate/abort, one-active-at-a-time)
- [ ] Create `Toolbar` UI component (top bar with buttons)
- [ ] Add Abort button (visible only when a tool is active)
- [ ] Wire Escape key to abort
- [ ] Style toolbar

### Clipping Tool
- [ ] Implement surface click detection (Raycaster)
- [ ] Create clipping plane from hit point + normal
- [ ] Add visual plane helper to scene
- [ ] Add draggable handle (scissors icon/sprite)
- [ ] Implement drag along normal axis
- [ ] Real-time clip update during drag
- [ ] Clean up on deactivate (remove plane, helper, restore model)

### Placeholder Tools
- [ ] Add disabled "Transparify" button
- [ ] Add disabled "Reset View" button

### Integration
- [ ] Wire ToolManager into App.ts
- [ ] Pass Viewer's renderer, scene, camera to tools that need them
- [ ] Write tests for ToolManager (activate/deactivate/abort logic)
- [ ] Run all tests
- [ ] Ask for manual testing

## Test Strategy

- **ToolManager**: unit test activate/deactivate/abort state transitions, one-active-at-a-time invariant
- **ClippingTool**: hard to unit test (depends on raycasting + renderer) — covered by manual testing
- **Toolbar**: DOM component — manual testing

## Done When

- Toolbar visible at top with scissors, transparent-cube (disabled), reset (disabled) buttons
- Clicking scissors activates clipping mode (crosshair cursor)
- Clicking a surface creates a clipping plane at that point
- Dragging the handle slides the plane along its normal, clipping the model in real-time
- Abort / Escape removes the clipping plane and restores the model
- All existing + new tests pass
- Manual test approved
