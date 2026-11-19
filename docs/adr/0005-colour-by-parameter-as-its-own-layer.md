# 5. Colour by parameter is a layer of its own, lit to match its legend

Date: 2026-11-19
Status: accepted
Issue: #68

## Context

Colouring elements by a parameter value has to be temporary: clearing it
must bring every element back exactly as it was, whatever else had changed
it. It must not cost frame time, because the owner set performance as the
condition for the whole Data Insight work. And the colour on screen has to
be recognisably the colour in the legend.

Three things stood in the way:

- **One colour override per element.** `setColor` had no other users yet, but
  a filter (#70) or a later feature would use it, and a colouring that wrote
  into it could not tell its own colours from theirs when clearing.
- **The lighting darkens every face.** A face is drawn at 30–45 % of its
  colour (ambient 0.6 and one directional light of 0.8, over π). A legend's
  red came out as maroon and its yellow as olive.
- **The selection highlight is a faint blue glow.** On a saturated colour it
  disappeared: selected orange beams looked like unselected ones.

## Decision

- **A data colour layer.** Each element can hold a data colour (RGBA) above
  its colour override. The state texture shows the data colour when one is
  set, otherwise the override, otherwise the element's own colour. Clearing
  the layer restores what is underneath, so nothing has to be remembered.
  One call per model sets every element's colour from a typed array; the
  layer's memory (16 bytes per piece) is only held while a colouring is
  shown.
- **Data colours glow.** Pieces with a data colour add 0.55 of it as
  emissive light, so a face shows 75–95 % of the colour while the shading
  still shows the shape. Measured on the Snowdon sample: legend red
  (190, 0, 50) is drawn (186, 0, 49) on a top face.
- **A selected element in a coloured view is drawn in the highlight
  blue**, not tinted. The distinct-value palette leaves out deep blues for
  that reason.
- **"No value" is opaque near white.** The layer can ghost an element
  (alpha below 1), but see-through pieces are drawn in sorted depth bands:
  on Snowdon the orbit went from 5.9 to 7.6 ms on integrated graphics and
  draw calls from 5 to 81, and on a model of a hundred chunks the draw calls
  could reach thousands. Near white reads as "no value" just as clearly and
  costs nothing.
- **Unticking a legend entry gives its elements back their own colours**; it
  does not hide them. Hiding stays with Hide and Isolate.
- **Not undoable, not saved.** A colouring ends on Clear, when another
  starts, or when its last model is closed.

## Alternatives rejected

- **Use the colour override and remember what was there.** Works until a
  second feature writes the override while a colouring is shown; then
  clearing restores a stale colour.
- **An unlit material for coloured elements.** Matches the legend exactly
  but flattens the model into silhouettes; edges between faces vanish.
- **Darker legend swatches, as the lighting would draw them.** Honest, but
  the whole palette turns muddy, and distinct values become harder to tell
  apart.
- **A see-through ghost for "no value" by default.** See the frame cost
  above. It is one constant (`NO_VALUE_OPACITY`) if it is wanted later,
  perhaps only for small scopes.

## Consequences

- A filter or highlight feature that wants to stand above a colouring has
  to come above this layer in `ModelBatch.writeState`, which is now the one
  place that decides an element's drawn colour.
- The glow is a shader change made in `onBeforeCompile`, alongside the
  existing ones; a three.js upgrade that renames the Phong chunks needs it
  checked too.
- Colouring and clearing Snowdon's 1,235 elements take 1–4 ms on the main
  thread; the first colouring by a parameter also waits for its value column
  (ADR 4), about 100 ms on Snowdon.
- The orbit frame time with a colouring shown is the same as without.
