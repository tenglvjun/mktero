# Caption selection in Zotero

Run with the Node version in `.node-version`:

```sh
node scripts/validate-caption-selection-zotero.mjs
```

This is an editor integration check in real Zotero/Gecko. It bundles the current
editor source without patches or instrumentation, applies the reader and KaTeX
stylesheets, and runs native mouse gestures inside a shadow root. It does not
install the product XPI or exercise PDF annotation persistence.

The three built-in samples cover Unicode scientific units, formulas with repeated
prose, and a long shared caption for two panels. Each sample runs forward,
backward, and multiline selection at a different reader width. The driver waits
for later selection events before using the popup, clicks a highlight color with
Gecko mouse events, and checks one save with the same text and valid source
ranges. It also checks Escape followed by a new gesture, leaving a caption for
ordinary text, two simultaneously live editors, and selection after destruction.

`--fixtures` writes and validates the inputs without starting Zotero.
`--preflight` verifies the macOS sandbox without starting Zotero. Real runs use
an empty temporary profile, deny network access and reads/writes of the real
library, and require a normal Zotero exit. The script prints the run directory
and result path before launch. `report.json` is written only after the assertions
and the normal exit pass; failures leave `failure.json` and the process log.

Additional local papers can be supplied with:

```sh
node scripts/validate-caption-selection-zotero.mjs --corpus /tmp/caption-corpus.json
```

The manifest is an array of at most 12 records:

```json
[
  { "label": "Paper A", "markdownPath": "paper-a.md", "figureIndex": 0 },
  { "label": "Paper B", "markdown": "![Figure 2. A caption.](figure.png)" }
]
```

`markdownPath` is relative to the manifest; `markdownFile` is an alias.
`figureIndex` defaults to zero and selects one academic figure from that paper.
Only the selected figure and synthetic adjacent paragraphs enter the isolated
reader. Before each caption check the driver scrolls its start into view. The
multiline gesture covers at least two visible prose lines, up to about five
lines; it does not require dragging to an offscreen caption tail. A caption too
short to wrap fails that explicit assertion. Use separate records or runs to
select additional figures. Keep corpus manifests, source papers, and generated
reports outside git.

The callbacks record saved drafts in memory, so this check proves selection and
popup behavior. Zotero PDF writes, annotation grouping, and durable reopening
belong to the product integration tests.
