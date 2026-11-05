# Development

[English](./development.md) · [简体中文](./development.zh-CN.md) · [Back to README](../README.md)

Use the Node.js version in [`.node-version`](../.node-version), currently
`24.15.0`. Node.js 25 is outside the supported dependency range.

```bash
npm ci
npm run check
npm test
npm run build
```

Run one test while iterating with `node --test test/<name>.test.js`. The build
creates the reproducible XPI, SHA-256 checksum, and `build/updates.json` under
`build/`; `build/` and `node_modules/` are generated and ignored.

Keep the versions in `manifest.json`, `package.json`, and `package-lock.json`
consistent before tagging a release. See [AGENTS.md](../AGENTS.md) for the
architecture, security invariants, and contribution checklist.

## Hosted conversion sharing

`src/mktero/shared-conversion.js` is owned once by bootstrap. It shares raw-cache
lookup, hosted transport and one raw-archive save by API base, account-session
scope, request profile, full PDF SHA-256 and byte length. Each attachment leases
that acquisition through its own processing and annotations. Force replacement
reserves before aborting its old run; releases identify the exact run signal.
A new generation revokes older cache publication immediately, and stores check
`canCommit` inside their serial queue before metadata publication. A failed new
generation does not restore the old one's write permission. Local cache
restoration captures an offline publication guard, so a delayed recovery cannot
overwrite a parallel forced conversion. Shutdown also waits for outstanding
archive writes within the bounded cleanup period.

The opaque `accountSessionEpoch` preference rotates on explicit login/logout,
including login with the same email. Token refresh preserves it. The separate
runtime scope also observes API and provider changes; neither identity contains
access or refresh tokens. Disk cache identities and schema stay unchanged.
Cancellation cleanup is best effort and bounded; this module provides no hosted
job recovery after restart or a lost create response.

HTTP deadlines and cancellation cover both response headers and body reads.
Cancelling a create rejects the caller immediately. Once headers have arrived,
the body can still reveal a job id during a recovery window (by default at most
2 seconds, also limited by the remaining request deadline), then cleanup sends
one independent DELETE. That DELETE has its own 2-second total budget for token
lookup, transfer and body consumption. The shared layer separately limits how
long shutdown or a replacement waits; none of these limits proves that the
remote task was cancelled.

`test/shared-mktero-conversion*.test.js` controls lifecycle races with explicit
gates. `test/mktero-sharing-boundaries.test.js` combines the real service,
extractor and HTTP client with simulated transport.
`test/mktero-sharing-response-cleanup.test.js` checks late create responses and
DELETE body deadlines through the real shared coordinator and HTTP client.
`test/bootstrap-hosted-sharing.test.js` exercises real bootstrap entry points in
JSDOM. These tests use no production data or network and do not replace manual
Zotero acceptance testing.

## Figure corpus regression

`test/fixtures/figure-corpus/` stores the figure decisions (composed figures,
preserved pages, bounding boxes) for papers that shipped figure-restoration
fixes. The matching test stays skipped unless you point it at local MinerU
result archives; the archives themselves are never committed.

```bash
export MKTERO_FIGURE_CORPUS="$HOME/mktero-figure-corpus"  # <id>.zip or <id>/result.zip
node scripts/figure-corpus-check.mjs                      # compare and print a diff
node scripts/figure-corpus-check.mjs --update             # refresh after review
```

After changing figure rules, run the check and review the diff. When you verify
another paper, add its archive to the corpus directory and commit the generated
`<id>.expected.json`. Missing archives are skipped; an archive whose bytes
changed fails until it is re-verified and updated.

The figure input now comes from the MinerU document IR. The ten expectations
recorded before it (`beyond-alignment`, `brainbench`, `clinical-llm`,
`envharness`, `externalization`, `menstrual-wearable`, `mosaic`, `neuradock`,
`olfactory`, `parsimonious`) were written by the earlier figure adapter. Re-run
`--update` for them on a machine that has those archives and review the diff.

## Reading corpus regression

`scripts/reading-corpus-check.mjs` measures how the MinerU pipeline reads each
local archive (`<id>.zip`) and compares the numbers with
`test/fixtures/reading-corpus/<id>.expected.json`. The expectations hold counts
and 12-character heading hashes only, never paper text. The directory comes from
`MKTERO_READING_CORPUS`, falling back to `MKTERO_FIGURE_CORPUS`.

```bash
node scripts/reading-corpus-check.mjs --pipeline ir            # compare and print a table
node scripts/reading-corpus-check.mjs --pipeline ir --update   # refresh after review
node scripts/reading-corpus-check.mjs --pipeline ir-pdf        # also read the archive's PDF with PDF.js
node scripts/reading-corpus-check.mjs --ids a,b --json         # full report for some papers
```

`ir` reads the MinerU result alone. `ir-pdf` also reads the `*_origin.pdf` that
MinerU puts in its archive with PDF.js, as the extension does, so paragraph
joins and heading levels use the PDF's lines and fonts. Both have committed
expectations; refresh each with `--update` after review.

| Metric | Meaning |
| --- | --- |
| `breaks` | Two text paragraphs that read as one sentence (the first ends open, the second starts in lower case) with only floats or display math between them, split by the PDF boundary the source map reports: `page`, `column`, `float`, `math`, `adjacent`, or `unmapped` |
| `chrome` | Discarded headers, footers, page numbers, and side text (8+ normalized characters) that survive as a visible block |
| `textCoverage` | Share of layout text-span shingles (8 characters) found in the visible text |
| `pageNotes` | Page footnotes with at least 80% of their shingles visible |
| `headings` | Outline size, level histogram, and the hashed `level:title` sequence |
| `sourceMap` | Share of visible top-level blocks covered by a source-map entry, and entries that span several pages |
| `floats` | Images, tables, algorithms, code, and display math in the output versus the layout |
| `references` | Parsed reference entries versus layout `ref_text` blocks |

## Browser preview

`preview/` mounts the real Markdown reader (`createMarkdownTabView`) in a plain
web page, inside a Zotero-style window with a sample paper, for the website and
for browser compatibility checks. The paper, translation, annotations, and
simulated PDF pages are fixtures; the page makes no network requests and its
CSP blocks connections. The XPI does not include it.

```bash
npm run build:preview   # writes build/preview/; serve that directory to open it
```

Add `?lang=zh` for the Chinese interface and `?diagnostics=1` to run the
in-page checks and show their results. To check several engines, point
`MKTERO_PLAYWRIGHT_PATH` at an installed Playwright module (it is not a
dependency of this repository):

```bash
export MKTERO_PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs
MKTERO_PREVIEW_BROWSERS=chromium,chrome,firefox,webkit,safari \
  node scripts/validate-preview-browser.mjs
```

Reports and screenshots go to `build/preview-validation/`. Real Safari runs
through `safaridriver` and needs Safari's "Allow remote automation" setting;
without it the Safari run is reported as skipped.

Each release also publishes the preview, which the website downloads and
verifies at deploy time instead of keeping a copy:

```bash
npm run package:preview   # build/mktero-preview-<version>.tar.gz and .sha256
```

The archive holds regular files only, sorted, with fixed modes and times, plus
`mktero-preview.json` (`version`, `commit`, `embed`). `embed` is
`PREVIEW_EMBED_VERSION` in `scripts/build-preview.mjs`; bump it when the
query parameters (`lang`, `frame`, `theme`), the `mktero-preview-ready`
message, the sandbox, or the 1280x800 layout change, so an older site skips
the preview instead of embedding one it cannot drive.

The website runs the preview in a sandboxed iframe with the CSP in
`preview/embed.js`: an opaque origin with no storage or cookies, no network,
and no top-level navigation. The preview must not need any of them. The
validator also loads it that way (`/__embed.html`) and fails if it does not
start, its checks fail, or storage is readable.
