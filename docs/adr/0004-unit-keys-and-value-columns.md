# 4. Compare units by key, and keep parameter values in columns built on demand

Date: 2026-11-18
Status: accepted
Issue: #67 (for #68 and #69)

## Context

Colouring elements by a parameter (#68) needs the value of one parameter for
every element in a model, tens of thousands of them. Adding values up (#69)
needs the same values, plus a safe answer to "are these all in one unit?".

Two things were in the way:

- **Units were display text.** Each value carried a suffix such as `FOOT` or
  `mm`, taken only from the project's unit assignment. A unit set on a single
  property was ignored, derived units (thermal transmittance, load per area)
  were dropped, and a measure the model gave no unit was shown in metres
  without saying so. Nothing could tell whether two values were in the same
  unit.
- **Values were read again for every question.** Listing a parameter's values,
  or selecting the elements with one value, read every element of the model in
  the worker each time: about 55 ms on the Snowdon sample, and selecting held
  the worker's queue for about 50 ms per click, so a click on the model in
  that time waited up to 70 ms.

The owner decided on 18 Nov 2026: show and use the units the model states, with
no conversion for now, and refuse to add up a parameter whose values are in
different units.

## Decision

**Every value gets a unit key.** One module, `src/inspector/units.ts`, decides
which unit a value is in. A unit set on the property or quantity wins over the
project's unit for its measure. Any measure is matched to its unit type by its
IFC name (`IfcThermalTransmittanceMeasure` goes with
`THERMALTRANSMITTANCEUNIT`). The module returns a symbol to show and a key to
compare:

| Key | Means |
|---|---|
| `""` | no unit applies: text, yes/no, counts, ratios, plain numbers |
| `?LENGTHUNIT` | a measure whose unit the model does not state |
| `si:mm` | an SI unit, by its symbol |
| `conv:foot*0.3048 si:m` | a conversion-based unit: name, factor, and the unit of the factor |
| `der:si:kN^1 si:m^-2` | a derived unit: its parts and exponents, sorted |
| `ctx:<name>`, `cur:<code>` | context-dependent and monetary units |

Two values are in the same unit exactly when their keys are equal. Nothing
compares symbols. `canSum()` in the same module answers whether a parameter, or
a selection of it, can be added up, and why not.

**Values are kept in columns, built when first needed.** A column holds one
parameter's value for every element of the model's scope, which is the elements
the viewer draws:

- A number column is a `Float64Array`, with NaN where an element has no value.
  Its units are listed once, with a per-element index only when there is more
  than one.
- A text, yes/no or enumeration column is an `Int32Array` of positions in a
  list of distinct values, with -1 where an element has no value.
- Every column of a model lines up with one shared `Int32Array` of element ids.

The worker builds a column in the same short background steps as parameter
discovery. It sends the arrays across by transfer, not by copy. The main thread
keeps them until the model is closed. A column is built when its parameter is
first opened in the Parameters list, so it is usually ready before a value is
clicked. A value is read exactly as discovery reads it, so a column's counts
are the counts the list shows.

## Alternatives rejected

- **Convert everything to SI as it is read.** This was ruled out by the owner
  for now. It would also need conversion factors trusted for every unit, and
  would show numbers in a unit the model's author never used.
- **Compare unit symbols.** A foot and a US survey foot both show as `ft`. The
  key includes the conversion factor, so they stay apart.
- **Build every column during discovery.** That would make reading a value
  free, but memory grows with elements × parameters. The Snowdon sample would
  hold about 0.5 MB for all 51 parameters. A model with 50,000 elements and 300
  parameters would hold 60–120 MB, which is too much for a small laptop. Built
  on demand, one column costs 4–12 bytes per element: 5–10 KB on Snowdon, and
  0.2–0.6 MB at 50,000 elements.
- **Keep the worker re-reading for each question.** That is the 55 ms per list
  and 50 ms per click that columns remove.

## Consequences

- One unit written two ways gets two keys and is refused rather than added up.
  Examples are millimetres written as an SI unit and as a conversion of the
  metre, or one foot conversion stated relative to metres and another relative
  to millimetres. The answer is never a wrong total. A later converter can map
  keys to SI and lift the refusal.
- "Unit not stated" is now visible. Lengths in a model with no unit assignment
  show no unit, where they used to show `m`. Within one model, values with an
  unstated unit can still be added up (the total is labelled "unit not
  stated"). Across models they must not be, because the keys are equal but the
  units may not be. Combining models in #69 has to treat a `?` key as different
  from every model's own.
- The first pick of a value in a parameter costs one background read of the
  model, about 55 ms on Snowdon. That read usually starts when the parameter is
  opened, so it is done before the pick. Later picks scan an array on the main
  thread in about 2 ms, and the worker is left free. Measured in the app, a
  click on the model while parameter work runs now waits 3 ms at the median
  (12.8 ms at worst), down from 22.5 ms (69 ms at worst).
- A build started because a parameter was opened is given up when it is
  closed again, so browsing the list never leaves scans running. A pick makes
  its build urgent: other background work stands aside until it is done.
  This keeps the worst wait for a pick to one scan, about 2 s at 50,000
  elements.
- In a parameter whose numbers are in more than one unit, a value is a
  number *and* a unit: 3 mm and 3 m are listed and picked apart, and
  select-similar and the combined inspector view tell them apart too.
- A column is valid only for the scope it was built over. That scope is fixed
  per model when its parameters are first described, and both are dropped
  together when the model is closed.
- The old on-demand values message (`parameterValues`) is gone. Columns replace
  it. Select-similar still uses `findMatching`.
