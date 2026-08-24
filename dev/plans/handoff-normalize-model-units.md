# Normalize model units — one world unit = one metre

> ## ⚠ Re-review before implementing
>
> **This plan was written on 2026-08-24, before any of the measurement work
> landed. Assumptions in it may have gone stale.** Before starting, re-verify:
> the line references below still point where they claim; `CACHE_SCHEMA_VERSION`
> is still where it is; nothing has already added unit handling; the sample
> models still declare the units quoted here. If a check fails, fix this
> document first and say what changed — do not implement around a stale claim.
>
> This is the **first** of five planned steps (this one, then measurement
> phases 1–4). Later steps carry the same warning and get staler the longer
> they wait.

---

## TL;DR

Geometry currently lives in whatever length unit the IFC file was authored in.
Three of the four sample models are millimetres, one is metres, and nothing
reconciles them. Fix: read the unit each model declares and apply a uniform
scale so **one world unit is one metre, for every model**.

Recommended mechanism — **scale the model's `THREE.Group`**, not the vertices.
See *Where to apply the scale*; this reverses an earlier call in
`handoff-measurement-modes.md` and is the lower-risk option by some margin.

Ships with a **per-model override** in the model tree, because exporters do
sometimes declare the wrong unit and the user is the only one who can see it.

---

## The problem, measured

Probed with web-ifc directly, 2026-08-24:

```
assets/ifcs/RIB.ifc          IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)   local x-range  -30700 .. 30700
assets/ifcs/SBM_RIE.ifc      IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)
assets/ifcs/SMB_ARK.ifc      IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)
Snowdon Towers …Structural   IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)         local x-range     -37 .. 37
```

Consequences today:

1. **`MeasurementTool` is wrong on any non-metre model.** `createLabel` is
   `` `${distance.toFixed(2)} m` `` — hardcoded. A 30.7 m beam in RIB.ifc
   reads "30700.00 m".
2. **Multi-model is broken.** Load a millimetre model beside a metre model and
   they sit in one scene at 1000× different sizes. The model tree, the
   single-model lock and the combined fit all imply multi-model is supported.
3. **Any future summed length / area / volume is corrupted** across models —
   a landmine directly in front of the Data Insight epic.

## This is not a detection problem

The file *declares* its unit, and **we already read that declaration**:
`computeUnitTable` (`src/inspector/repository/unitTable.ts`) walks
`IfcProject.UnitsInContext.Units` to drive the inspector's unit pills, and
`format.ts` maps the SI prefix (`SI_PREFIX_SYMBOL: MILLI → 'm'`).

Three specific gaps:

1. **`UnitTable` is `ReadonlyMap<MeasureKind, string>` — symbols only.** It
   resolves `MILLI` to the letter `m`, never the number `0.001`.
2. **Nothing hands a factor to `ModelManager`.**
3. **Timing.** `ensureUnitTable` is lazy — computed on the first *property*
   query (`ifcWorker.ts`). Geometry needs the factor at model-open.

Do **not** infer the unit from model extents. "30 000 units across, probably
millimetres" fails silently on a large site model authored in metres, and we
would be guessing at something the file states outright.

---

## Where to apply the scale

**Recommended: a uniform scale on the model's `THREE.Group`.**

`handoff-measurement-modes.md` argued for scaling vertices, on the grounds
that a group scale "leaves raw numbers in `geometry.boundingBox` and in every
raycast hit". **That was wrong, and this supersedes it.** Verified:

- `raycaster.intersectObjects` returns `hit.point` in **world** space, so it
  already includes the group scale.
- `Box3.expandByObject` (used by `ModelManager.getBoundingBox` →
  `expandByVisibleMeshes`) applies `matrixWorld`, so fit is correct.
- `MarqueeSelector` already does `tmpBox.copy(local).applyMatrix4(mesh.matrixWorld)`
  — correct by construction.

The group scale wins on four counts:

| | group scale | vertex scale |
|---|---|---|
| Geometry cache | **untouched** — cached raw geometry stays valid | needs `CACHE_SCHEMA_VERSION` bump; stale entries silently 1000× wrong |
| Per-model override | **live, one number** | requires a re-parse |
| Blast radius | one `Object3D` property | every vertex buffer, worker + cache + main thread |
| Reversibility | set it back | re-parse everything |

**The discipline it requires:** anything reading `geometry.attributes.position`
directly gets *local, unscaled* numbers and must apply `matrixWorld`. Today
nothing does. The snapping phase will (feature edges come out of
`EdgesGeometry` in local space) — and it has to apply `matrixWorld` regardless,
because models are also translated and rotated. Write that expectation down in
`ModelManager` next to the scale.

**Uniform scale only.** Non-uniform would break normals; IFC length units are
a single scalar, so this never arises.

---

## Implementation steps

### 1. A numeric length scale

`src/inspector/format.ts` — alongside `SI_PREFIX_SYMBOL`, add the factors
(`MILLI: 0.001`, `CENTI: 0.01`, `DECI: 0.1`, `KILO: 1000`, …) and a function
resolving a `RawUnitEntry` for `LENGTHUNIT` to metres-per-unit. Default `1`
when absent or unrecognised, and say so in a comment: an unknown prefix must
not silently scale a model to nothing.

`IFCCONVERSIONBASEDUNIT` (feet/inches) also appears in the wild —
`readUnitEntry` already reads it as `conversionLabel`. Out of scope to convert;
return `1` and **log once per model** so an imperial file is a known-unknown
rather than a silent wrong answer.

### 2. Read the unit at model-open

`src/parser/ifcWorker.ts` — `ensureUnitTable` is lazy. Call it (or a narrower
length-only read) when the model opens, and include `metresPerUnit` in the
parse result that crosses back to the main thread.

Keep the existing lazy path for properties; this only guarantees the length
factor is known before meshes are built.

### 3. Apply it

`src/viewer/ModelManager.ts` — `addModel` / `beginStream` set
`group.scale.setScalar(metresPerUnit)` on the model group. Store the declared
factor on `ModelEntry` so the UI can show it and the override can reset to it.

### 4. Per-model override

Model tree row gains a unit control showing the **declared** unit, marked when
overridden. Changing it sets the group scale live — no re-parse. Persist with
the model in `SessionStore`, and show the override state on reload so it is
never silent.

### 5. Re-tune scale constants

These were tuned by eye against today's mixed scales and now see consistent
metres:

- `computeFitPosition` (`src/viewer/cameraUtils.ts`) — `near = distance * 0.01`,
  `far = distance * 100`.
- Pivot marker scale (`Viewer.updateMarkerScales`) — `dist * 0.008`.
- Measurement marker sizes (`MARKER_SCREEN_SIZE`, `HOVER_MARKER_SCREEN_SIZE`).
- `ClippingTool.HANDLE_SCREEN_SIZE`.

Most are ratios of a distance and should be scale-invariant already — **verify
rather than assume**, and only change what actually looks wrong.

### 6. Label the unit honestly

`MeasurementTool.createLabel` stops hardcoding `" m"`. With world units now
metres it can format from metres — metres with two decimals is a reasonable
default; the fuller treatment is decision D8 in the measurement plan.

---

## Tests

Pure and unit-testable (put them where the logic lives):

- `MILLI` → `0.001`, `CENTI` → `0.01`, absent prefix → `1`, unknown → `1`.
- A conversion-based (imperial) unit → `1` plus the warning path.
- `ModelEntry` records the declared factor; an override changes the effective
  scale without changing the declared value.

Integration-ish, with the existing fixture approach:

- A millimetre model and a metre model produce **world** bounding boxes of
  comparable magnitude (the existing e2e tests already derive expectations
  from whatever fixture is present — follow that, do not pin absolute numbers;
  `RIB.ifc` is untracked and has been swapped mid-review before).

---

## Manual test

1. Load `Snowdon Towers` (metres) — nothing should look different.
2. Load `RIB.ifc` (millimetres) alone — fit still frames it correctly.
3. **Load both together** — they must appear at plausible relative sizes.
   This is the headline fix and is impossible to fake.
4. Measure a known span in RIB.ifc — the label must read metres, not
   thousands.
5. Clipping handles, the pivot marker and measurement markers stay a sensible
   size in both models.
6. Override a model's unit in the tree — the model rescales live, the override
   is visibly marked, and it survives a reload.

---

## Risks

- **Scale constants.** The main unknown; needs eyes on both models.
- **Session restore.** Models restored from `SessionStore` must get the scale
  too — check the restore path, not just the fresh-load path.
- **Geometry cache.** Not invalidated by design (that is the point of the
  group-scale approach) — but confirm the cache stores only raw geometry and
  no derived world-space values.
- **Imperial models.** Explicitly unhandled; must warn, not silently mis-scale.
- **`instanced-meshes` later.** If instancing ever lands, per-instance matrices
  compose with the group scale — fine, but worth a note where the scale is set.

---

## Checklist

- [ ] Re-verify the ⚠ banner's assumptions
- [ ] Branch `feature/normalize-model-units`
- [ ] Run existing tests (baseline)
- [ ] Length-factor resolution + tests
- [ ] Unit read at model-open, factor crosses the worker boundary
- [ ] Group scale applied on add + on session restore
- [ ] Per-model override, persisted and visibly marked
- [ ] Scale constants verified (change only what is actually wrong)
- [ ] Measurement label reads metres
- [ ] Manual test, especially step 3 (both models together)
- [ ] PR
