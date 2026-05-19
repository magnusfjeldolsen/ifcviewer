---
name: Highlight variant cache pattern
description: SelectionManager uses a WeakMap<Material, Material> cache for emissive-boosted variants — never dispose variants on restore
type: feedback
---

SelectionManager.highlightVariants is a `WeakMap<THREE.Material, THREE.Material>`
that maps original material -> shared emissive-boosted clone. Two meshes that
share an original material share their highlight variant.

Why: with N=18k selected meshes in a 100k-mesh model, the dominant cost was
~22k per-mesh Material.clone() calls at ~1ms each. The cache collapses that
to O(distinct materials in selection), typically a few dozen.

How to apply:
- NEVER call `.dispose()` on a variant in the restore path. The variant may
  still be referenced by another currently-highlighted mesh, and reselect
  must reuse it from the cache. Variants release automatically when the
  original material is GC'd (the WeakMap holds the original as key).
- `MeshHighlight.originalMaterial` keeps the EXACT original reference for
  restore. Restore is a single ref-swap, no allocation.
- The companion piece is `ModelEntry.meshesByExpressId: Map<number, Mesh[]>`
  built at `ModelManager.addModel`. Any code that needs "meshes for an
  expressID" should hit this index, NOT iterate `group.children`.
- If you add a new highlight style (e.g. hover, error), give it its own
  WeakMap cache with the same shape. Do not reuse `highlightVariants`
  for a different visual.
- Eager `geometry.computeBoundingBox()` was removed from `addModel`;
  `MarqueeSelector.classifyMesh` already lazily computes on first hit.
  Don't reintroduce eager bbox computation without measuring the load cost.
