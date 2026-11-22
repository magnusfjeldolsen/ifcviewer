# 6. Totals count the selection, and remember their rows by parameter key

Date: 2026-11-19
Status: accepted
Issue: #69

## Context

The owner wants quick answers to questions like "how heavy is this
selection?" or "how much rebar is in that foundation?": the parameters the
model already has, with count, sum, min, max and average, with as little
clicking as possible, and grouping when the question is "per type". It is a
quick inspection tool, not a spreadsheet, and it must not slow the viewer
down on integrated graphics.

Three choices are hard to undo once people rely on them:

- **What the totals cover.** A count that silently covers something other
  than what the user thinks is worse than none.
- **What is remembered, and how.** Once rows are stored in browsers, a change
  of format must read the old one or lose people's rows.
- **How several columns are read.** Totals often want three or four
  parameters at once; each column used to be a full read of the model.

## Decision

- **Scope: the selection, else everything visible.** With anything selected
  the totals cover exactly the selected elements, hidden or not, across
  models. With nothing selected they cover what can be seen, by the same rule
  as colouring (ADR 5): not hidden, model switched on, not wholly behind the
  section plane. The tab's header always says which ("37 selected elements",
  "All visible: 1,235 elements"). Totals follow the selection and what can
  be seen while the tab is open (after 80 ms of quiet), and do nothing while
  it is closed.
- **Rows are parameter keys, remembered in this browser.** The rows added,
  how each is charted, and the one group-by parameter are kept in
  `localStorage` under `ifcviewer:totals`, as
  `{"v":1,"rows":[{"key":"…","chart":"pie"?}],"groupBy":"…"|null}`. Keys,
  not models: the next model with the same parameters shows its totals with
  no clicks. Anything unreadable is dropped, never an error. A later format
  bumps `v` and reads `v: 1`.
- **Units as ADR 4 says, across models too.** Numbers in different unit keys
  are never added: a row shows one total per unit and says why. A unit a
  model does not state (`?LENGTHUNIT`) is that model's own; two models'
  unstated units are kept apart. No conversion.
- **Columns of one model are read together.** The worker builds every column
  asked for while another of the same model and scope is being built in the
  same pass over the elements; one asked for part-way reads round to the
  elements it missed. Cancelling, hurrying and closing work per column as
  before.

## Alternatives rejected

- **Whole model when nothing is selected.** Simple, but disagrees with what
  is on screen after Hide or Isolate, and with the colouring's rule.
- **Remember rows per model.** Each new model would start empty, which is the
  click the owner asked to remove.
- **Save totals with the session or share them in links.** Not asked for;
  rows are a personal habit, not part of a model's view.
- **A renamable multi-tab workspace (the issue's first sketch).** More to
  learn and more clicks for the quick question; one Totals tab with a
  group-by covers the pivot the owner described.
- **Queue column builds one per pass.** Simpler, but three rows on a large
  model cost three full reads.

## Consequences

- Clicking a group's line selects its elements, so the totals then cover
  that group alone: drilling down is a click, Escape goes back.
- The first use of a parameter waits for its column (about 100 ms on the
  Snowdon sample, longer on large models, with progress on its row); after
  that a selection change takes about a millisecond.
- A column build the Totals tab started is given up when the tab closes or
  the row is removed, unless the Parameters list is getting the same column
  ready; the list's own release can give up a build the tab wants, which the
  tab then asks for again.
- Describing a model's parameters, needed once before its columns, is not
  given up when the tab closes; it is kept and shared with the Parameters
  list.
