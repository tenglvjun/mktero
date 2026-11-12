# Development

[English](./development.md) · [简体中文](./development.zh-CN.md) · [Back to README](../README.md)

This page covers building Mktero, checking local regression corpora, and running
the browser preview. It also documents the lifecycle rules for shared hosted
conversions.

## Quick reference

- Install, check, test, and package: `npm ci`, `npm run check`, `npm test`, `npm run build`.
- Run one test: `node --test test/<name>.test.js`.
- Check local figures: `node scripts/figure-corpus-check.mjs`.
- Check local reading results: `node scripts/reading-corpus-check.mjs --pipeline ir`.
- Build the browser preview: `npm run build:preview`.
- Regenerate the iOS reader artifacts (renderer, stylesheet, KaTeX fonts): `npm run build:ios-renderer` and `npm run build:ios-reader`; `npm run check:ios-reader` fails when the committed copy is stale.

## Build and release

Use the Node.js version in [`.node-version`](../.node-version), currently
`24.15.0`. Node.js 25 is outside the supported dependency range.

```bash
npm ci
npm run check
npm test
npm run build
```

The build creates a reproducible XPI, a SHA-256 checksum, and
`build/updates.json` under `build/`. Both `build/` and `node_modules/` are
generated and ignored.

Before tagging a release, keep the versions in `manifest.json`, `package.json`,
and `package-lock.json` consistent. See [AGENTS.md](../AGENTS.md) for the
architecture, security invariants, and contribution checklist.

## Hosted conversion sharing

### Acquisition and cache publication

Bootstrap creates `src/mktero/shared-conversion.js` once. It shares raw-cache
lookup, hosted transport, and one raw-archive save for requests with the same:

- API base and account-session scope;
- request profile;
- full PDF SHA-256 and byte length.

Each attachment holds a lease through its own processing and annotation loading.
The following rules prevent an older run from publishing over a newer result:

1. Force replacement reserves the new acquisition before aborting the old run.
   A release identifies the exact run signal.
2. A new generation immediately revokes older generations' cache publication
   rights. Stores check `canCommit` inside their serial queue before publishing
   metadata. A failed new generation does not restore the old one's write
   permission.
3. Local cache restoration captures an offline publication guard, so delayed
   recovery cannot overwrite a parallel forced conversion.
4. Shutdown waits for outstanding archive writes within the bounded cleanup
   period.

### Session identity

The opaque `accountSessionEpoch` preference rotates on explicit login/logout,
including login with the same email. Token refresh preserves it.

The separate runtime scope also observes API and provider changes. Neither
identity contains access or refresh tokens. Disk cache identities and schema
stay unchanged.

### Deadlines and cancellation

Cancellation cleanup is best effort and bounded. This module provides no hosted
job recovery after restart or a lost create response.

HTTP deadlines and cancellation cover both response headers and body reads:

1. Cancelling a create rejects the caller immediately.
2. If headers have arrived, the body can still reveal a job id during a recovery
   window: by default at most 2 seconds, also limited by the remaining request
   deadline. Cleanup then sends one independent DELETE.
3. That DELETE has its own 2-second total budget for token lookup, transfer, and
   body consumption.

The shared layer separately limits how long shutdown or a replacement waits.
None of these limits proves that the remote task was cancelled.

### Lifecycle tests

| Test | Coverage |
| --- | --- |
| `test/shared-mktero-conversion*.test.js` | Lifecycle races controlled with explicit gates |
| `test/mktero-sharing-boundaries.test.js` | Real service, extractor, and HTTP client with simulated transport |
| `test/mktero-sharing-response-cleanup.test.js` | Late create responses and DELETE body deadlines through the real shared coordinator and HTTP client |
| `test/bootstrap-hosted-sharing.test.js` | Real bootstrap entry points in JSDOM |

These tests use no production data or network. They do not replace manual
Zotero acceptance testing.

## Figure corpus regression

`test/fixtures/figure-corpus/` stores figure decisions (composed figures,
preserved pages, and bounding boxes) for papers that shipped figure-restoration
fixes. The matching test stays skipped unless you point it at local MinerU
result archives. Never commit the archives themselves.

```bash
export MKTERO_FIGURE_CORPUS="$HOME/mktero-figure-corpus"  # <id>.zip or <id>/result.zip
node scripts/figure-corpus-check.mjs                      # compare and print a diff
node scripts/figure-corpus-check.mjs --update             # refresh after review
```

1. After changing figure rules, run the check and review the diff.
2. When you verify another paper, add its archive to the corpus directory and
   commit the generated `<id>.expected.json`.
3. Missing archives are skipped. An archive whose bytes changed fails until it
   is re-verified and updated.

Figure input now comes from the MinerU document IR. The ten expectations below
were recorded by the earlier figure adapter:

`beyond-alignment`, `brainbench`, `clinical-llm`, `envharness`, `externalization`,
`menstrual-wearable`, `mosaic`, `neuradock`, `olfactory`, `parsimonious`.

Re-run `--update` for them on a machine that has those archives and review the
diff.

## Reading corpus regression

`scripts/reading-corpus-check.mjs` measures how the MinerU pipeline reads each
local archive (`<id>.zip`) and compares the numbers with
`test/fixtures/reading-corpus/<id>.expected.json`. Expectations hold counts and
12-character heading hashes only, never paper text. The directory comes from
`MKTERO_READING_CORPUS`, falling back to `MKTERO_FIGURE_CORPUS`.

```bash
node scripts/reading-corpus-check.mjs --pipeline ir            # compare and print a table
node scripts/reading-corpus-check.mjs --pipeline ir --update   # refresh after review
node scripts/reading-corpus-check.mjs --pipeline ir-pdf        # also read the archive's PDF with PDF.js
node scripts/reading-corpus-check.mjs --ids a,b --json         # full report for some papers
```

- `ir` reads the MinerU result alone.
- `ir-pdf` also reads the `*_origin.pdf` that MinerU puts in its archive with
  PDF.js, as the extension does. Paragraph joins and heading levels then use
  the PDF's lines and fonts.
- Both pipelines have committed expectations. Refresh each with `--update` after
  review.

| Metric | Meaning |
| --- | --- |
| `breaks` | Two text paragraphs that read as one sentence (the first ends open, the second starts in lower case), with only floats or display math between them. Grouped by the PDF boundary the source map reports: `page`, `column`, `float`, `math`, `adjacent`, or `unmapped`. |
| `chrome` | Discarded headers, footers, page numbers, and side text (8+ normalized characters) that survive as a visible block |
| `textCoverage` | Share of layout text-span shingles (8 characters) found in the visible text |
| `pageNotes` | Page footnotes with at least 80% of their shingles visible |
| `headings` | Outline size, level histogram, and the hashed `level:title` sequence |
| `sourceMap` | Share of visible top-level blocks covered by a source-map entry, and entries that span several pages |
| `floats` | Images, tables, algorithms, code, and display math in the output versus the layout |
| `references` | Parsed reference entries versus layout `ref_text` blocks |

## iOS reader artifacts

`mktero-iOS` does not import this repository. It carries build outputs produced
here, and both outputs are committed so building the app needs no Node:

```bash
npm run build:ios-renderer   # Mktero/Resources/Renderer/renderer.js
npm run build:ios-reader     # Mktero/Resources/Reader/{reader.css,katex.css,fonts/}
npm run check:ios-reader     # fails when the committed stylesheet is stale
```

Changing `ui/markdown.css` means running `build:ios-reader`.
`scripts/build-ios-reader-styles.mjs` takes three parts of that stylesheet:

- the `:host` variable block, with both palettes and every `--reader-*`;
- the block typography the extension writes for a saved snapshot (`p`,
  `h1`–`h6`, `table`, `pre`, `figure`, `figcaption`, `blockquote`, `code`,
  links);
- the translation table in `EDITOR_MODULE_RULES`: each figure, math and table
  selector of the editor branch, mapped onto the flat markup the renderer
  actually produces. Any editor rule not in the table is dropped and listed in
  the artifact's `dropped.unmapped`, so a new desktop rule shows up in the build
  summary instead of disappearing.

KaTeX MathML is laid out from font metrics: `katex.css` keeps only woff2 and the
20 fonts ship with the app. The app writes the page into a temporary directory
before loading it, so the stylesheet's relative font URLs need the fonts beside
the page; `ReaderStyleSheet.installFonts(into:)` does that.

## Browser preview

`preview/` mounts the real Markdown reader (`createMarkdownTabView`) in a plain
web page, inside a Zotero-style window with a sample paper. It serves the
website and browser compatibility checks. The paper, translation, annotations,
and simulated PDF pages are fixtures; the page makes no network requests and
its CSP blocks connections. The XPI does not include it.

### Build and inspect

```bash
npm run build:preview   # writes build/preview/; serve that directory to open it
```

- Add `?lang=zh` for the Chinese interface.
- Add `?diagnostics=1` to run the in-page checks and show their results.

To check several engines, point `MKTERO_PLAYWRIGHT_PATH` at an installed
Playwright module. Playwright is not a dependency of this repository.

```bash
export MKTERO_PLAYWRIGHT_PATH=/path/to/node_modules/playwright/index.mjs
MKTERO_PREVIEW_BROWSERS=chromium,chrome,firefox,webkit,safari \
  node scripts/validate-preview-browser.mjs
```

Reports and screenshots go to `build/preview-validation/`. Real Safari runs
through `safaridriver` and needs Safari's "Allow remote automation" setting.
Without it, the Safari run is reported as skipped.

### Package and embed

Each release publishes the preview. The website downloads and verifies it at
deploy time instead of keeping a copy.

```bash
npm run package:preview   # build/mktero-preview-<version>.tar.gz and .sha256
```

The archive holds only regular files, sorted, with fixed modes and times. It
also contains `mktero-preview.json` with `version`, `commit`, and `embed`.

`embed` is `PREVIEW_EMBED_VERSION` in `scripts/build-preview.mjs`. Bump it when
any of these change, so an older site skips a preview it cannot drive:

- Query parameters (`lang`, `frame`, `theme`);
- The `mktero-preview-ready` message;
- The sandbox;
- The 1280x800 layout.

The website runs the preview in a sandboxed iframe with the CSP in
`preview/embed.js`. Its opaque origin has no storage or cookies, no network,
and no top-level navigation. The preview must not need any of them.

The validator also loads it that way (`/__embed.html`). It fails if the preview
does not start, its checks fail, or storage is readable.
