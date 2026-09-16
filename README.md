# Mktero

**English** · [简体中文](./README.zh-CN.md)

[![Test](https://github.com/tenglvjun/mktero/actions/workflows/test.yml/badge.svg)](https://github.com/tenglvjun/mktero/actions/workflows/test.yml)
[![Latest release](https://img.shields.io/github/v/release/tenglvjun/mktero)](https://github.com/tenglvjun/mktero/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%20%7C%208%20%7C%209%20%7C%2010-cc2936.svg)](https://www.zotero.org/)

**Read Zotero PDFs as source-linked Markdown.**

Mktero is a restartless Zotero extension for Zotero 7, 8, 9, and 10. It sends a
local PDF to your selected OCR service, [MinerU](https://mineru.net/) or
[Mistral OCR 4.1](https://docs.mistral.ai/models/ocr-4-1), when needed, then
opens the resulting Markdown, formulas, tables, figures, citations, and
annotations in a temporary, reading-first Zotero tab. A content-addressed
local cache avoids repeating conversions for the same PDF and parser profile.

![Mktero converting, reading, and annotating an academic PDF in Zotero](./docs/assets/mktero-demo.gif)

> [!IMPORTANT]
> Mktero is in beta. On a cache miss, the complete PDF is sent to the selected
> conversion provider, so configure either a MinerU API Token or a Mistral API
> Key. Optional AI translation sends protected Markdown batches to the provider
> configured by you. Review [Privacy and data handling](./docs/privacy.md)
> before processing sensitive documents.

Useful links: [Product page](https://mktero.com/) ·
[Download](https://github.com/tenglvjun/mktero/releases/latest) ·
[Discussions](https://github.com/tenglvjun/mktero/discussions) ·
[Issues](https://github.com/tenglvjun/mktero/issues)

## Features

- Reflow OCR output, multi-column text, formulas, tables, figures, lists, and
  code into a continuous academic reading document.
- Rebuild figures from the local PDF when layout evidence, page coordinates,
  and Markdown ranges agree. Restoration runs in a background worker and
  replaces placeholders in place, so slow figures never block reading.
- Hide publisher mastheads, repeated headers/footers, and page numbers, and
  keep reliable page/region mappings so text, formulas, tables, and figures can
  jump back to their PDF source.
- Browse the outline or a figure/table index, preview citations, affiliations,
  figures, and tables, and find text in the body with `Cmd/Ctrl+F`.
- Display Zotero PDF highlights and underlines in Markdown, and create,
  recolor, comment on, or delete annotations.
- Correct recognition errors in existing paragraphs, headings, and GFM table
  cells without modifying the immutable OCR result.
- Translate a complete article through a configured Vercel AI SDK provider and
  switch between Original, Translation, and continuous Bilingual reading; look
  up a selected term or passage on demand.
- Check whether each Markdown reference already exists in any accessible Zotero
  library, copy a reference from another library, and import missing metadata
  with an optional public PDF attachment.
- Explore direct reference relationships among papers already in the current
  Zotero library, using Semantic Scholar, OpenCitations, and OpenAlex when
  identifiers are available.
- Save a portable Zotero snapshot, or export corrected Markdown and its
  extracted figures to a local folder.
- Follow Zotero's English or Simplified Chinese display language; other locales
  fall back to English.

## Quick start

### Requirements

- Desktop Zotero `7.0` through `10.0.*`
- A PDF attachment downloaded and available as a local file
- An API key for the selected conversion provider: [MinerU](https://mineru.net/apiManage/token)
  or [Mistral](https://console.mistral.ai/api-keys/)
- Network access to the selected conversion API

MinerU and Mistral control file-size, page-count, quota, and service-availability
limits. See the [MinerU API documentation](https://mineru.net/apiManage/docs) or
[Mistral OCR documentation](https://docs.mistral.ai/studio/document-processing/basic_ocr)
for current limits.

### Install

1. Download the latest `mktero-<version>.xpi` from
   [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest).
2. In Zotero, open `Tools -> Plugins`.
3. Open the gear menu and choose `Install Add-on From File...`.
4. Select the XPI and follow Zotero's prompts.

Formal GitHub releases receive automatic updates through Zotero. Drafts and
prereleases are not offered as automatic updates.

### Configure

Open `Settings -> Mktero` after installation, choose a conversion provider, and
enter its API key. AI features and reading options are optional; each AI
provider keeps its own model, key, and related settings. Credentials are
stored as ordinary, unencrypted preferences in the active Zotero profile.

See [Configuration](./docs/configuration.md) for every setting and
[Privacy and data handling](./docs/privacy.md) for what is sent where.

### Open a PDF

1. Open a PDF in Zotero and click the Mktero file icon in the reader toolbar, or
   right-click a PDF or library item and choose `Read as Markdown with Mktero`.
2. Follow the upload, conversion, and download progress in the temporary Mktero
   tab. A valid cache entry skips the remote conversion.
3. Use the outline, find, citations, figure/table previews, source links, and
   Zotero notes panel to navigate the document.

Mktero tabs are session-only and are not restored after Zotero restarts. Closing
the tab or shutting down the extension cancels active conversion and
translation requests. Reopening the same PDF and conversion profile restores the
last reading paragraph.

## Documentation

- [Configuration](./docs/configuration.md) — every setting and its default.
- [Reading and annotation workflows](./docs/workflows.md) — corrections,
  annotations, AI translation, citations, references, snapshots, and export.
- [Figure pipeline](./docs/figure-pipeline.md) — how figures are rebuilt from
  the local PDF.
- [Privacy and data handling](./docs/privacy.md) — what Mktero sends and where
  it is stored.
- [Limitations](./docs/limitations.md) — supported PDFs, navigation, and
  resource limits.
- [Development](./docs/development.md) — build, test, figure corpus, and
  contributing.

## Privacy

- On a cache miss, the complete PDF is sent to the selected MinerU or Mistral
  provider.
- Credentials, cached Markdown and figures, corrections, translations, and
  reading positions are stored unencrypted in the active Zotero profile and are
  not synced by Mktero.
- Reference, citation, and translation requests are bounded and local-first;
  logs never contain API tokens, presigned URLs, PDF bytes, or authenticated
  responses.

Full details and the complete data table are in
[Privacy and data handling](./docs/privacy.md).

## Development

Use the Node.js version in [`.node-version`](./.node-version), currently
`24.15.0`. Node.js 25 is outside the supported dependency range.

```bash
npm ci
npm run check
npm test
npm run build
```

See [Development](./docs/development.md) for the figure corpus regression.

## Contributing

Pull requests are welcome. For ideas, reading workflows, and beta feedback, use
[GitHub Discussions](https://github.com/tenglvjun/mktero/discussions). For
changes to runtime behavior, run the complete verification commands above and
include tests for the affected behavior. Please keep credentials, private PDFs,
and other sensitive data out of issues, pull requests, and logs.

## License

[MIT](./LICENSE) © 2026 Tony
