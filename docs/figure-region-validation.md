# Figure region validation

Validation date: 2026-09-12. Implementation: `3eb6bdf`; final validation code:
`09c5f5a8eeda762122a4bb28ff906960d49aa597`. Review baseline: `663733a`.
Subsequent documentation commits do not change the tested runtime or fixtures.

The pipeline preserves provider Markdown and layout evidence until the local
PDF crop passes PNG, exact-range, geometry, and budget checks. A successful
transaction replaces the individual image/OCR ranges with one ordinary local
Markdown image and stores bounded `figureMap` provenance. Uncertain candidates
keep their original images and text. Cancellation does not publish a result.

## Final Runtime Matrix

All native runs use separate profiles and data directories created below
`build/figure-validation/`. No production Zotero profile or live OCR service
was used. Each pixel run covers 32 provider/case combinations, 34 restored
crops, and 1,068 independent feature probes. Cases include an intentional
preserve result, so passing a case does not mean it was composed.

| Runtime | Pixel Cases | Reader Layouts | Reader Cycles / Windows | Render Cycles | Result |
| --- | --- | --- | --- | --- | --- |
| Chromium 145 | 32 | 12 | Not applicable | Not applicable | Pass |
| Firefox 153 | 32 | 12 | Not applicable | Not applicable | Pass |
| Zotero 7.0.32 / Firefox 115 | 32 | 12 | 100 / 2 | 100 | Pass |
| Zotero 8.0.5 / Firefox 140 | 32 | 12 | 100 / 2 | 100 | Pass |
| Zotero 9.0.6 | 32 | 12 | 100 / 2 | 100 | Pass |
| Zotero 10.0.2 | 32 | 12 | 100 / 2 | 100 | Pass |

Reader layouts cover original, translated, and bilingual modes at actual
300, 520, 760, and 1200 pixel host widths. Checks assert one complete image,
one caption, natural aspect ratio, and containment in the reading pane. Native
interaction checks exercise the figure directory, reference preview, image
enlargement and 125% zoom, PDF region navigation, same-PDF replacement across
two windows, snapshot saving/reloading, and ordinary Markdown export. Export
receives only Markdown and assets; the referenced PNG is compared byte for
byte without consulting `figureMap` or the PDF in the exporter.

Each native renderer loop performs 100 real PDF.js sessions across two windows:
34 finish, 34 cancel after rendering starts, and 32 cancel during PNG encoding.
After every session, active loading/render tasks, canvases, timers, and abort
listeners equal zero. Reader object URLs return to zero after each close.
Window/document listener counts are compared after Zotero's PDF and snapshot
UI has initialized and after 100 cycles; the final counts match the baseline.
These are resource lifecycle checks, not an OS RSS or GC heap benchmark.
Conversion cancellation, pending-task retention, stale-result rejection,
window shutdown, and toolbar cleanup also have injected Node regressions.

## Evidence And Reproduction

Reports and screenshots are generated artifacts under `build/figure-validation/`:

- `chromium-report.json` and `firefox-report.json`: per-crop feature results,
  expected bounds, body/caption exclusion, ratios, and resource counts.
- `chromium-<width>-<view>.png` and `firefox-<width>-<view>.png`: all 12 layouts.
- `chromium-comparison.png` and `firefox-comparison.png`: original full PDF
  page with the crop outlined, next to the restored 4x4 PNG. This is a visual
  aid; acceptance uses the independent fixture geometry and feature probes.
- `zotero-{7,8,9,10}-final/validation.json`: native results, workflows,
  listener baselines/finals, and render lifecycle counters.
- Each native directory also contains `reader-{300,520,760,1200}.png`,
  per-case PNG/Markdown/figure-map files, and the exported Markdown assets.

Use Node 24.15.0 from `.node-version`. The completed checks are the narrow
figure/bootstrap/cache/PDF compatibility regressions, `npm run check`,
`npm test`, `npm run build`, and `git diff 663733a --check`. Standards and Spec
reviews found no remaining actionable defects. The PDF.js legacy compatibility
tests exercise real PDF text/path operators, including the Firefox 115
`Promise.withResolvers` and `ArrayBuffer.transferToFixedLength` fallbacks.

Run the Node checks **before** browser/native validation: build removes the
entire `build/` directory, and the full test suite itself runs packaging checks.
Do not run those commands while a native validation profile is active.

```sh
npm run check
npm test
npm run build
node scripts/validate-figure-browser.mjs
MKTERO_ZOTERO_PATH=/path/to/zotero MKTERO_ZOTERO_RUN_ID=7-final \
  node scripts/validate-figure-zotero.mjs
```

For the browser command set `MKTERO_PLAYWRIGHT_PATH` to an installed Playwright
module and, if needed, `MKTERO_CHROMIUM_PATH` / `MKTERO_FIREFOX_PATH`. Repeat the
native command with each version's executable and a distinct run ID. Omit
`MKTERO_FIGURE_CASES` for the full matrix; `grid-2x2` is a diagnostic subset.
The native runner always creates a new isolated profile and stops its process
after recording the result.

## Fixture Identity

Two consecutive executions of `node scripts/generate-figure-fixtures.mjs`
produced identical files. The self-authored fixture has 17 pages and 16 cases:

| Artifact | SHA-256 |
| --- | --- |
| `compound-figures.pdf` | `882ae02de1841dce5d06de00adcca7b8a9a54639af82d4e6779e7b8887c76d78` |
| `compound-figures.expected.json` | `0095c032b4444694915dd528242ea067455efd0563d9ea5f50fc4b9812af09dd` |
| Local validation XPI, version unchanged at 0.3.9 | `c273bf8db3cc9e936dc2e79d547c3eb1c731a58610735f460521b8b73074ccc6` |

Pixel probes cover axes, arrows, text/labels, shared legends, panel backgrounds,
and embedded bitmap colors, with independent crop bounds and caption/body
exclusion. The scan-only page is an actual raster XObject without PDF text
operators. Other pages use PDF text, paths, and embedded images; rotation,
nonzero CropBox, and UserUnit variants exercise displayed-page coordinates.

## Coverage Limits

- MinerU restoration is limited to supported VLM 3.4.5 detailed layout
  metadata and provable source ranges. The fixed upstream unit/frame evidence
  is documented in design section 7. Synthetic archives exercise this adapter;
  no new cloud response was obtained. Flat-only metadata, unsupported versions,
  and ambiguous trailing captions preserve their original content.
- Mistral production coordinates remain `unknown`. Known models preserve with
  `missing-geometry`; unknown models use `unsupported-layout-schema`. Synthetic
  Mistral cases explicitly declare fixture coordinates to test the shared
  algorithm. They do not verify Mistral's real CropBox origin or rotation.
- No user-provided failing PDF/OCR response was available. These results do not
  establish a regression fix for that specific document.
- Native profiles use generated translated captions and local fixtures. They
  exercise real reader/store/export integration, not live OCR/AI networking.
  Persistent metadata contains original OCR fragments as documented in both
  READMEs and may synchronize when the user saves a Zotero snapshot.
