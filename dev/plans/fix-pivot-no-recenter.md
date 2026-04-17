# Fix: Pivot Point Selection Should Not Re-center View

## Problem

When the user presses `v` and clicks on the model to set a new pivot point, the
view instantly snaps to center on that point. This makes the UX clunky — the
camera jumps unexpectedly, losing the user's current framing.

## Expected Behavior

Pressing `v` and clicking should:
1. Move the orbit pivot (controls target) to the clicked point
2. Show the pivot marker at that point
3. **Keep the camera position and view direction unchanged**

Future orbiting/rotating will then revolve around the new pivot, but the view
at the moment of selection stays stable.

## Root Cause

In `src/viewer/Viewer.ts`, the `placePivot()` method (line 203-205) does:

```ts
this.controls.target.copy(point);
this.controls.update();
```

`OrbitControls.target` defines both the orbit center *and* the point the camera
looks at. Setting `target` to the new pivot and calling `update()` immediately
re-orients the camera to look at that point, causing the visible "snap".

## Fix

The problem is that `OrbitControls.update()` calls `lookAt(target)` every
frame, so any target change immediately reorients the camera. Moving the camera
to compensate preserves view direction but causes visible parallax (the camera
physically translates, shifting the entire scene).

The correct approach: **decouple the target change from the render loop.**

1. Set `controls.target` to the new pivot point
2. Set a `pivotTransitioning` flag to skip `controls.update()` in the animate loop
3. The view stays exactly as-is — camera position and orientation unchanged
4. When the user begins their next interaction (orbit/pan/zoom), the
   OrbitControls `'start'` event clears the flag
5. `controls.update()` resumes, and the orbit now revolves around the new pivot

The brief reorientation on first interaction is masked by the user's own
drag/scroll gesture.

## Checklist

- [x] Create branch `fix/pivot-point-no-recenter`
- [x] Run existing tests (57 pass)
- [ ] Add/update unit tests for pivot behavior
- [ ] Apply fix in `Viewer.ts`
- [ ] Run tests — all must pass
- [ ] Manual testing by user
- [ ] PR to main
