# 2. Generate a large model's geometry in several workers

Date: 2026-11-17
Status: accepted
Issue: #89

## Context

A large model took 14 to 43 seconds to load, and nothing appeared for the first
7 to 17 of them. Timing each phase showed two causes.

The load ran web-ifc's `StreamAllMeshes` twice: once with an empty callback to
count the elements for the progress text, and once for real. The first pass was
assumed to be cheap. It is not: web-ifc generates every element's geometry in
it and throws the result away. That was 4 of 14 seconds on a 357 MB model and
16 of 43 on a geometry-heavy 48 MB one.

What remained was geometry generation itself, which web-ifc does on one thread.
Opening the model (about 2 s for 357 MB) and reading the file (about 0.6 s from
a local disk) were small by comparison.

## Decision

- **No counting pass.** After opening the model, the worker lists the elements
  that can have geometry from the model's type index, which takes milliseconds,
  and streams them with `StreamMeshes`. The list is built the way web-ifc
  builds its own: every type its `IsIfcElement` accepts, minus openings and
  spaces. Tests compare it with `StreamAllMeshes` on IFC2X3, IFC4 and IFC4X3.
- **An approximate total.** The list includes elements that turn out to have no
  geometry, so progress reads "3,800 of about 7,500 elements". The final count
  is exact.
- **Helper workers.** For files of 20 MB or more, up to three helper workers
  each open their own copy of the file and generate geometry for chunks of
  elements. All of them feed the same `ModelBatch`.
- **A coordinator worker hands out the chunks.** Doing it on the main thread
  left workers waiting about a third of the time, because the main thread is
  busy appending geometry.
- **A chunk counts only when its geometry has reached the main thread.** If a
  helper fails, exactly the chunks that never arrived go back out, so nothing
  is lost and nothing is drawn twice.
- **Only the main worker keeps the model.** It answers property queries after
  the load. Helpers close their copy and exit.
- **Every parse has a token.** Messages, ports and stop requests are keyed by
  it, not by model id, so a second load of the same model cannot receive the
  first one's replies.
- **How many helpers.** None under 20 MB; at most three; at most half the cores
  minus one; and within one 1.25 GB memory budget shared by all loads, counting
  three file sizes per helper.

## Alternatives rejected

- **web-ifc's multithreaded build.** It needs cross-origin isolation headers
  that GitHub Pages cannot send, and we have not measured that it speeds up
  geometry.
- **More helpers.** Measured on the 357 MB model: one helper 8.8 s, two 8.6 s,
  three 8.5 s, and about 0.7 GB more memory for each. On the 48 MB model three
  helpers do pay: 26.8 s with none, 12.1 s with three.
- **Handing out chunks from the main thread.** See above.

## Consequences

- First geometry on the 357 MB model went from 6.8 to 2.9 s, and fully loaded
  from 14.1 to 6.4 s. The 48 MB model went from 43 to 11 s.
- Each helper costs a copy of the file plus web-ifc's working memory while the
  load runs. The memory budget is what keeps this bounded, so changing it needs
  a memory measurement, not only a timing.
- Elements no longer arrive in file order. Nothing may depend on that order.
- What remains before first geometry is web-ifc opening the model. Going lower
  means a different parser or a pre-converted format, not more workers.
- The worker protocol is now a small distributed system. Changes to it need
  tests for message order, which is where its defects were found in review.
