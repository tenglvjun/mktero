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
