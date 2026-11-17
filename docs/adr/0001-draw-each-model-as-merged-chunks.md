# 1. Draw each model as a few merged chunks, with per-element state in a texture

Date: 2026-11-17
Status: accepted
Issue: #89

## Context

Orbiting a loaded model was slow, and a faster graphics card did not help.
Every part of every element was its own three.js mesh with its own material, so
a model cost one draw call per part: 17,254 on the Snowdon sample, more than
30,000 on a large architectural model. Profiling showed the time went to the
processor preparing each draw call, not to the graphics card drawing triangles.
Frame rate was the same on integrated and discrete graphics.

The same structure made the features we want next expensive. Colouring or
hiding tens of thousands of elements by a property meant swapping tens of
thousands of materials.

## Decision

Each model is one `ModelBatch`:

- **Merged chunks.** Parts are merged into chunk meshes, split spatially so
  chunks off screen are skipped. A chunk holds at most 262,144 vertices. A part
  of at least half that size gets a chunk of its own, so it is never copied.
- **State in a texture.** Hidden, highlighted, colour override and opacity
  override are one row per element in a data texture. The standard Phong
  material reads it through a small shader addition. Changing the state of any
  number of elements is a texture update, never a geometry or material change.
- **Elements, not meshes.** The rest of the app addresses `(modelId,
  expressId)` through `ModelManager` (`setHidden`, `setColor`, `setOpacity`,
  `setHighlighted`, `elementOfHit`). No consumer sees a mesh or a material.
- **Welded vertices.** The worker merges vertices that share a position and an
  8-bit normal. Normals are stored as four signed bytes.
- **A local anchor per chunk.** Positions are offsets from the chunk's anchor,
  and a part joins a chunk only within 1024 m of it, so georeferenced models
  keep sub-millimetre precision in 32-bit floats.
- **See-through parts.** They are drawn from separate index lists without depth
  writes, and re-sorted far to near in 32 depth bands once the view has rested.
- **Main-memory copies are released.** Normals and part indices are freed after
  upload to the graphics card.

## Alternatives rejected

- **`THREE.BatchedMesh`.** On Windows, Chrome translates WebGL to Direct3D, and
  the multi-draw call it relies on becomes one draw per instance again. Measured
  on the large model: still 11 frames per second.
- **`THREE.InstancedMesh`.** The worker already hands over each placement as
  its own vertices, so finding repeats would mean re-deriving them. It also
  only helps models with many repeated parts.
- **Sharing materials by colour.** Removes material switches but keeps one draw
  call per part, which was the actual cost.
- **A larger chunk cap.** Measured at 512k, 1M and 2M vertices on a 98 million
  vertex model: fewer draw calls but the same frame time, and far more copying
  while the model streams in.

## Consequences

- Draw calls fell from 17,254 to 4 on Snowdon and from about 32,000 to about
  110 on the large model. Orbit went from 18 to about 200 frames per second and
  from 10 to 30–38 on integrated graphics.
- Very large models are now limited by triangle count, not draw calls. Going
  further needs less geometry on screen (simplified distant parts, occlusion),
  not more batching.
- Colouring and filtering by property (#68, #70) are one call per model.
- An individual element can no longer be found by walking the scene graph.
  Anything that needs an element goes through `ModelManager`.
- The material is customised with `onBeforeCompile`, so a three.js upgrade that
  changes the Phong shader's chunk names needs this checked.
- Because main-memory copies are released, the model cannot be re-uploaded
  after the browser loses the graphics context. It has to be reloaded, which
  the geometry cache makes quick for models that fit in it.
- See-through parts are sorted in bands rather than exactly, so overlapping
  glass can differ slightly from an exact sort.
