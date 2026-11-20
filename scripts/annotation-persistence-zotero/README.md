# Installed-XPI annotation persistence validation

```bash
node scripts/validate-annotation-persistence-zotero.mjs
node scripts/validate-annotation-persistence-zotero.mjs build/mktero-0.10.0.xpi
node scripts/validate-annotation-persistence-zotero.mjs --fixtures
node scripts/validate-annotation-persistence-zotero.mjs --preflight
node --test test/annotation-persistence-zotero-harness.test.js
```

Use Node 24.15.0. A product run requires macOS and `/Applications/Zotero.app`.
The default XPI is `build/mktero-0.10.0.xpi`. The script snapshots it into the
run's extensions directory before preparing fixtures, records its SHA-256,
and verifies the active add-on's resource URI. Later launches use only that
copy. Run only one native Zotero harness at a time.

The existing research-note harness supplies the Seatbelt launcher and probes:
network access is denied, real HOME and other user data cannot be read, and
writes are restricted to the run directory. Gecko also starts offline. Three
application launches reuse one isolated profile and data directory. Each phase
must request `eAttemptQuit` and exit with code 0, no signal, and no forced
termination. A timeout or failure cleanup cannot pass. `--preflight` runs the
same isolation and normal-exit checks twice without a product XPI or fixtures;
`--fixtures` prepares reviewable synthetic PDFs and production-format offline
Markdown caches without launching Zotero.

The installed product is opened from its item menu. Native mouse drags select
text; the selection popup's Add Comment and Save controls create annotations.
The accessible highlight's focus/ArrowDown entry opens its actions popup,
whose color swatch is clicked natively. The sidebar's delete and retry controls
are clicked natively. The driver imports PDF attachments and seeds one legacy
local draft, but never creates the tested Zotero annotation items directly and
never replaces synchronization, persistence, or grouping APIs.

The four synthetic cases are:

- `retain`: a portrait two-page PDF with body text crossing the page boundary.
  Four identical, separated margin lines exceed 240 characters, sit within
  the top 5% of each page, and follow the body in PDF content-stream order.
  A product-created two-part highlight has its existing primary comment edited,
  is recolored from its second member, reopened, checked across two normal
  restarts, and recolored again using the restored group. Only the primary part
  keeps the edited comment; the other annotation fields remain unchanged.
- `delete`: a two-part highlight is created and recolored, then its second
  member's sidebar control deletes both members and the group. Reopening and
  both restarts verify that neither the items nor their group return.
- `retry`: an old local draft contains the same text and comment as a valid
  two-page PDF, but its initial imported PDF is deliberately damaged. The
  product must log a genuine synchronization failure and retain the local
  draft. Its failure control must become available. Clicking Retry while the
  PDF remains damaged must preserve one local draft and zero PDF annotations.
  If the control is missing, the report records a product issue, continues the
  remaining persistence checks, and returns a nonzero status after all normal
  exits; it never treats the missing control as a pass. After the first normal exit, the outer driver restores
  only the synthetic PDF file; the local record stays untouched. Opening the
  document in the next process must automatically synchronize it to exactly
  two PDF annotation keys, remove the local draft, and persist their group.
  Closing/reopening must keep those keys and counts. A third launch checks
  the recovered PDF annotations, fields, and group again.

- `caption`: a single-page PDF and cached offline SVG create a real figure
  widget between ordinary paragraphs. A backward native drag selects at least
  two visible caption lines. Saving its comment must produce exactly one PDF
  annotation with accurate multiline rectangles, no cross-page group, and no
  remaining local draft. Tab reopening and both restarts must retain its exact
  key, text, color, comment and geometry without including adjacent paragraphs.

Each successful group checkpoint requires all three durable representations:
exact Zotero fields (including text, color, comment, page and position), an
empty local store, and a group JSON containing exactly the two created keys.
Rectangle bounds are checked against the synthetic PDF's known text baseline.
Restart checks compare saved records, including item IDs, keys, sort indices,
and rectangles. Failed statuses are not seeded in JSON: the product keeps
them only in memory, so the first process must really fail.

Reports, fixture plans, environment-recovery evidence, per-phase checks,
process logs, exit records, popup diagnostics, and all isolated data remain in
the printed `/private/tmp/mktero-annotation-persistence-*` run directory.
Only a complete successful run writes `report.json` with `passed: true`.
A completed run with deferred product issues writes `passed: false` and can
separately report `persistencePassed: true`; the command still exits nonzero.
The run contains synthetic material only; no external paper corpus is read.
