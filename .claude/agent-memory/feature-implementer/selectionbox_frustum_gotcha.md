---
name: SelectionBox frustum-construction gotcha
description: three's SelectionBox.js flips the far-plane normal without flipping the constant — copying this verbatim breaks Frustum.containsPoint
type: feedback
---

When porting frustum construction from `node_modules/three/examples/jsm/interactive/SelectionBox.js` (lines 158-200), the stock implementation does:

```js
planes[5].setFromCoplanarPoints(farBR, farTR, farTL);
planes[5].normal.multiplyScalar(-1);
```

With the winding `(farBR, farTR, farTL)`, `setFromCoplanarPoints` already produces a normal pointing INWARD (toward the camera). Multiplying just the normal by -1 (without also flipping the constant) does NOT keep the same plane in space — it puts the plane behind the camera and breaks `Frustum.containsPoint` for legitimately-inside points.

**Why:** `Plane.setFromCoplanarPoints(a,b,c)` calls `setFromNormalAndCoplanarPoint(normal, a)`, which sets `constant = -normal·a`. Flipping only the normal makes the plane equation no longer satisfy `n·a + c = 0` for the original point `a`.

SelectionBox happens to work because it only tests bounding-sphere CENTERS, which are always in front of the camera, so a far-plane-behind-the-camera never rejects a center. For AABB-based testing, the bug is fatal.

**Fix:** drop the multiply entirely. The plane from `setFromCoplanarPoints(farBR, farTR, farTL)` (with the SelectionBox winding) already faces inward.

**How to apply:** if you copy any of SelectionBox's frustum building, verify `Frustum.containsPoint(origin)` returns true for a centred marquee with the camera at (0,0,10). If it returns false, the far plane is likely the culprit.

Reference: `src/inspector/MarqueeSelector.ts:buildSelectionFrustum`.
