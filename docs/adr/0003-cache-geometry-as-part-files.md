# 3. Cache geometry as part files in the browser's private file system

Date: 2026-11-17
Status: accepted
Issue: #89

## Context

A model's generated geometry was cached in IndexedDB as one record, so a reload
could skip parsing. Two limits made that fail for large models:

- Writing one record means one structured clone of all the geometry. On large
  models the browser refused it with an out-of-memory error.
- To avoid that, geometry was cached only if it fit in 500 MB. A model with
  2.4 GB of geometry was parsed again on every reload, about 43 seconds each
  time.

## Decision

- **Part files in OPFS.** While a model streams in, each worker writes its
  geometry as packed part files to the origin private file system, through a
  synchronous access handle. The main thread never holds a second copy.
- **A small index in IndexedDB.** It is written only after every worker has
  flushed and closed its files. A crash before that leaves part files with no
  index, which are swept after an hour and can never be read as a valid entry.
- **Keyed by content.** The key is the SHA-256 of the file, so the file name
  plays no part.
- **Compact form.** Indices are 16-bit where a piece has at most 65,536
  vertices. Normals are stored as signed bytes, which can shift a normal by
  under one degree. Bounds, colour and opacity are stored exactly.
- **The cap follows the device.** A quarter of the storage quota, no less than
  500 MB and no more than 8 GB.
- **Reads are checked.** Lengths are validated against the file, so a short or
  damaged part is a cache miss and the model is parsed instead.
- **Database version 4.** The upgrade deletes the old cache store. Old entries
  are dropped, not converted, so every model is parsed once after the update.
- **Storage may be unavailable.** Where OPFS or synchronous handles are
  missing, the load still works and nothing is cached. If the database cannot
  be opened because another tab holds an older version, the viewer runs
  without storage and says so. No load ever waits on storage.

## Alternatives rejected

- **Parts in IndexedDB.** Tried first. It ran at 120–160 MB/s, slowed cold
  loads to 18–23 s once writes were held back to protect memory, and without
  that limit some writes failed with "Failed to write blobs". OPFS wrote
  1.9 GB in 0.46 s and read it back in 0.87 s.
- **Keeping the 500 MB cap.** That is the limit that left the largest models
  with no cache at all.

## Consequences

- The model with 2.4 GB of geometry now reopens in about 8 s instead of 43.
  Smaller models reopen slightly faster than before.
- **This is a one-way door.** A build that asks for database version 3 cannot
  open a version 4 database, which also breaks its session restore. Any revert
  after this ships must keep version 4.
- The cache can now take several gigabytes of disk on a device that has the
  room. It is evicted by the cap and by the browser under storage pressure.
- A model loaded from cache has normals that went through one more rounding
  step than a fresh load. The difference is not visible but the two are not
  bit-identical.
- Synchronous access handles are exclusive, so two tabs cannot write the same
  part file. Keys are unique per load to keep that from ever happening.
