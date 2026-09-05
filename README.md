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
> configured by you. Review [Privacy and data handling](#privacy-and-data-handling)
> before processing sensitive documents.

Useful links: [Product page](https://tenglvjun.github.io/mktero/) ·
[Download](https://github.com/tenglvjun/mktero/releases/latest) ·
[Discussions](https://github.com/tenglvjun/mktero/discussions) ·
[Issues](https://github.com/tenglvjun/mktero/issues)

## Features

- Reflow OCR output, multi-column text, formulas, tables, figures, lists, and
  code into a continuous academic reading document.
- Mistral uses image coordinates to suppress OCR text that belongs inside an
  extracted figure. Both OCR providers restore multi-panel layouts from image
  coordinates; MinerU keeps its bbox-backed safety checks, while Mistral also
  supports a conservative fallback when coordinates are unavailable.
- Mistral removes publisher mastheads, repeated page headers and footers, and
  page numbers from OCR Markdown, joins safe same-page and cross-page column
  continuations, and preserves matching text in the body.
- Keep reliable page and region mappings so text, formulas, tables, and figures
  can jump back to their PDF source.
- Preview citations, author affiliations, figures, and tables without losing
  the current reading position.
- See whether each Markdown reference already exists in any accessible Zotero
  library. Choose a writable personal or group library, explicitly copy a
  reference from another library, review local/online metadata matches for
  title-only references, and import missing metadata from the citation popup
  with an optional public PDF attachment.
- Display Zotero PDF highlights and underlines in Markdown, and create,
  recolor, comment on, or delete annotations.
- Correct recognition errors in existing paragraphs, headings, and GFM table
  cells without modifying the immutable OCR result. Corrections can be
  reviewed, restored, or removed.
- Translate a complete article through a configured Vercel AI SDK provider and
  switch between Original, Translation, and continuous Bilingual reading; look
  up a selected term or passage from the Original view or the source side of
  Bilingual reading.
- Explore direct reference relationships among papers already in the current
  Zotero library, using cache-first refreshes from Semantic Scholar,
  OpenCitations, and OpenAlex when identifiers are available.
- Save a portable Zotero snapshot containing HTML, Markdown, source maps, and
  embedded figures.
- Export the corrected source Markdown and its extracted figures to a
  user-selected local path.
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
for current limits. Mktero checks Mistral's documented 50 MB PDF and 1,000-page
limits before creating the Base64 request.

### Install

1. Download the latest `mktero-<version>.xpi` from
   [GitHub Releases](https://github.com/tenglvjun/mktero/releases/latest).
2. In Zotero, open `Tools -> Plugins`.
3. Open the gear menu and choose `Install Add-on From File...`.
4. Select the XPI and follow Zotero's prompts.

Formal GitHub releases receive automatic updates through Zotero. Drafts and
prereleases are not offered as automatic updates.

### Configure

Open `Settings -> Mktero` after installation.

| Setting | Required | Purpose |
| --- | --- | --- |
| Conversion provider | Yes | Select MinerU or Mistral OCR 4.1 |
| API key | Required for a cache miss | Enter the key for the selected provider; use the adjacent manage link to create or update it |
| AI features and provider settings | Optional | Translate Markdown through a hosted or loopback model service |
| Translation language | Optional | Choose Simplified/Traditional Chinese, Japanese, Korean, Spanish, French, or Brazilian Portuguese |
| Automatically translate Markdown selections | Optional, off by default | Translate a stable selection without an extra click; disabling it keeps the manual popup action |
| Body text font and size | Optional | Choose the reading font and a 16–22 px body size |
| Reuse conversion results | Optional | Reuse results for the same PDF content and parser profile |

MinerU, Mistral, and AI credentials are stored as ordinary, unencrypted
preferences in the active Zotero profile. Mistral uses a synchronous request;
it can be cancelled locally, but it has no resumable server task. MinerU keeps
its existing resumable task behavior. Use `Test connection` to validate an AI
endpoint before translating.

### Open a PDF

1. Open a PDF in Zotero and click the Mktero file icon in the reader toolbar, or
   right-click a PDF or library item and choose `Read as Markdown with Mktero`.
2. Follow the upload, conversion, and download progress in the temporary Mktero
   tab. A valid cache entry skips the remote conversion.
3. Use the outline, citations, figure/table previews, source links, and Zotero
   notes panel to navigate the document.
4. Use the reader toolbar to adjust typography, switch reading mode, translate,
   correct recognition errors, save a snapshot, or export Markdown.

Mktero tabs are session-only and are not restored after Zotero restarts. Closing
the tab or shutting down the extension cancels active conversion and
translation requests.

## Reading and annotation workflows

### Source-aware reading

OCR content mappings connect Markdown blocks to physical PDF pages and
regions. Source links and source-aware copy use those mappings when they are
reliable; Mktero does not guess a location when a match is ambiguous. Markdown
is rendered in an isolated shadow root with a restricted link and image policy.
Academic figure captions are recognized in common publisher formats, including
`Figure N | ...` captions that follow an empty OCR image, so prose figure
references remain previewable in cached documents.

### Correct recognition errors

Double-click an existing paragraph, heading, or GFM table cell to edit it, then
save or cancel explicitly. Existing paragraphs and headings can also be
deleted and restored from `Manage corrections`. Corrections are stored
separately from the conversion cache and are tied to the PDF content and the
selected provider's parser profile. They cannot insert or reorder blocks, add images, or add raw
HTML. Saving a correction preserves the reading position and keeps the full
document available while scrolling. Prose around formulas and OCR
dollar-wrapped citation tokens remains
editable, while those tokens are protected from changes; a block containing
protected content cannot be deleted as a whole. In rendered GFM tables, cells
containing protected content remain read-only while other cells stay editable.
Text covered by a matched annotation is protected in the same way: delete the
annotation before changing that text. Edits before or after it remain allowed,
and Mktero updates the annotation anchor so it still matches after reopening.
Restoring a correction is refused when it would change annotated corrected
text. Restoring all corrections and reparsing a corrected PDF use an in-reader
Mktero confirmation dialog; `Escape`, the backdrop, or the default-focused
Cancel action leaves the document unchanged.

### Annotate from Markdown

Existing Zotero text highlights and underlines are loaded when a document opens.
Selecting Markdown text can create a local annotation immediately; Mktero then
creates the corresponding Zotero annotation only when the local PDF text index
can identify one reliable match. Repeated or ambiguous text remains local and
can be retried instead of receiving a guessed PDF position. When a highlight
overlaps a citation, table reference, or figure reference, that semantic
reference keeps interaction priority; annotation actions remain available from
the surrounding highlighted text or its note marker.
Selections that cross a PDF page break are split into one single-page Zotero
highlight per page, so the complete Markdown selection remains navigable.
Common MinerU LaTeX math symbols and simple subscripts are normalized to the
PDF's extracted text so selections that include formulas can still be located.

### Translate with AI

AI translation is always opt-in and never rewrites the source Markdown. Mktero
groups the article into bounded Markdown batches, protects formulas, citations,
links, code, images, and structural placeholders, and runs at most five
requests concurrently. Choose `Original`, `Translation`, or `Bilingual` in
the reader. Translations are cached independently by source content, provider,
protocol, model, language, and prompt version, so partial work can resume.
When local Markdown corrections delete a block, translations for unchanged
blocks remain available and the deleted block disappears from `Bilingual`
reading. Earlier source versions are retained, so restoring a deleted block can
reuse its complete translation even after the corrected document was translated.
Deleting a citation marker also preserves that block's translation when its
protected placeholders can be mapped unambiguously; ambiguous changes remain
pending for block-only retranslation. Editing a translated block keeps the
other translations, marks that block as pending, and offers to retranslate only
the changed block.
Restoring all corrections reloads a complete cached translation for the
original Markdown when one is available, without sending a new AI request.

For a focused lookup, select text in `Original` or on the source side of
`Bilingual` reading. The selection popup places its manual translation action
at the end of the action row; loading, results, and errors expand below it only
when needed in a compact panel. A successful result can be translated again or
copied as plain text. With a streaming provider, incoming translation text
appears progressively while cancellation remains available; non-streaming
providers display the result after completion. The `Automatically translate
Markdown selections` setting is off by default; when enabled, a stable
selection starts one bounded request automatically after a short delay. The
translated side of `Bilingual`, `Translation` reading, and saved HTML snapshots
do not offer selection translation. Selection results stay in the popup, do not
modify Markdown or notes, and are not added to the full-document translation
cache. Each selection request sends the selected text and a bounded amount of
nearby source context to the configured AI provider and may incur provider
usage costs.

Mktero includes adapters for OpenAI, Anthropic, Google Gemini, DeepSeek,
Alibaba Cloud Model Studio, Moonshot/Kimi, MiniMax, and custom OpenAI-compatible
or Open Responses services through Vercel AI SDK Core. Remote endpoints must
use HTTPS; loopback services such as Ollama or LM Studio may use HTTP.

### Explore the citation graph

The citation graph contains the focused paper and direct references that can be
matched to items already in the current Zotero library. DOI and arXiv
identifiers are queried concurrently from Semantic Scholar, OpenCitations, and
OpenAlex when supported. Matching uses a unique normalized identifier, never a
title, and provider metadata stays local. The graph details include a button
labeled `Open with Mktero`. It opens the first local PDF attachment through the
same Markdown reading workflow as `Read as Markdown with Mktero`.

### Import references from Markdown

Open a citation popup to see local Zotero presence before any network lookup is
made. Choosing `Import reference` for a title-only reference explicitly starts
a bounded OpenAlex lookup. A unique exact title, year, and author match
continues directly into import. Mktero also accepts a one-year provider date
difference only when the cleaned title is nearly identical and the first author
matches. Otherwise it shows at most three plausible candidates, and choosing
one continues the same import. The lookup retries with a cleaned title when a
full citation is too noisy and also covers OpenAlex records such as books that
do not have a DOI. For IEEE-style references, a paired straight or typographic
double-quoted article title is searched separately from its authors, venue,
volume, and pages. For unquoted conference references, Mktero separates a
paper title from a following `In ... Conference`, proceedings, workshop, or
symposium venue. The popup lists accessible
personal and group libraries and lets you choose the import target. A read-only
library remains selectable for presence checks, while its import actions stay
disabled with a permission explanation. If a matching item exists in another
library, Mktero offers an explicit copy action rather than silently creating a
duplicate. Missing references with a reliable DOI, arXiv ID, or PMID can be
imported through Zotero's native translator; confirmed OpenAlex-only records
such as books are created directly from their bounded metadata. When the target
library permits files, Mktero also tries an arXiv or configured open-access
PDF; metadata remains available when the PDF download fails and can be retried.
The popup header contains only the target-library picker. Each reference shows
its status on the left and its own import, retry, copy, or open action on the
right, so actions always apply to one visible reference.

Grouped author-year citations resolve every matched bibliography entry. If PDF
conversion inserts a stray heading inside an APA-style bibliography, Mktero
continues the reference list only when multiple bibliography-shaped entries
clearly resume after it, so a genuine author note still ends the list.

### Save a portable snapshot

`Save snapshot` creates a dedicated `Mktero Markdown Snapshot` Note under the
PDF's parent item. The Note contains portable HTML; figures are embedded image
attachments; the original Markdown and source map are related attachments.
Mktero refuses to silently overwrite a snapshot Note that you edited. A
standalone PDF without a parent library item cannot save a snapshot.

### Export Markdown

`Export Markdown` opens the system folder picker. If the selected folder is `A`
and the paper title is `B`, Mktero creates `A/B/B.md` and writes extracted
figures under `A/B/assets/`, updating their Markdown paths accordingly. If `B`
already exists, a numbered directory such as `B-2` is created with a matching
`B-2.md`; existing exports are never overwritten. Image names that collide on
case-insensitive filesystems are numbered and their Markdown references are
updated, so distinct figures cannot overwrite each other. Export does not
include translated or bilingual views and never runs automatically.

## How it works

```text
Local Zotero PDF
        |
        v
Selected OCR provider -> Markdown + figures + content map
        |                               |
        v                               v
Local content cache             Safe normalization/rendering
                                        |
                                        v
                           Reading-first Mktero tab in Zotero
```

PDFs, OCR results, archives, image paths, API responses, and preferences are
treated as untrusted input. Archives and Markdown are checked against resource
budgets, archive paths are normalized, remote Markdown images are not loaded,
and raw HTML is escaped or sanitized before rendering.

## Privacy and data handling

| Data | Sent to or stored in | Zotero sync |
| --- | --- | --- |
| Complete PDF on a cache miss | Selected MinerU or Mistral provider | Not by Mktero |
| MinerU/Mistral API credentials and AI credentials | Active Zotero profile, unencrypted | No |
| Cached Markdown, figures, source maps, PDF indexes, corrections, and translations | Active Zotero profile, unencrypted | No |
| Focused DOI/arXiv/OpenAlex identifiers and provider-specific candidate identifiers | Semantic Scholar, OpenCitations, or OpenAlex | Not by Mktero |
| Bounded citation text after the user chooses `Import reference` for a title-only reference | OpenAlex | Not by Mktero |
| A normalized DOI, arXiv ID, PMID, or OpenAlex work ID plus confirmed metadata after the user clicks the import action; optional open-access PDF request | The selected metadata/PDF provider | Not by Mktero |
| Protected Markdown translation batches | AI provider configured by you | Not by Mktero |
| Selected Markdown text and bounded surrounding source context for selection translation | AI provider configured by you | Not by Mktero |
| Zotero PDF annotations | Local Zotero library | According to Zotero settings |
| Saved snapshot Note and attachments | Zotero items and attachments | According to Zotero settings |
| Exported Markdown and figures | User-selected local path | No |
| Imported reference metadata and PDF attachments | Active Zotero profile, unencrypted | According to Zotero settings |

Mktero does not send PDF annotations, local PDF.js indexes, Zotero notes,
complete item records, local paths, or cached Markdown to reference/PDF
providers. Reference import requests are local-first. A title-only metadata
lookup sends only bounded citation text after the explicit import action. A
unique high-confidence match continues automatically; uncertain matches require
candidate confirmation. Citation and reference requests use anonymous provider access and
contain only the bounded citation text, normalized identifiers, and confirmed
metadata described above, never Zotero keys or PDF bytes.
Translation requests contain protected Markdown and instructions; if
placeholder validation repeatedly fails, the final retry contains only the
affected block's ordinary text segments. API Tokens, presigned URLs, PDF bytes,
and authenticated responses are not written to logs. Selection translation
requests contain only the selected text and bounded nearby source context; they
are not written to the full-document translation cache.

Review the privacy policy of MinerU and any AI or citation provider Mktero uses.
Do not process confidential PDFs unless their data-handling terms are suitable
for your use case.

## Limitations

- Only local PDF attachments are supported. A scanned PDF may convert through
  OCR but still lacks the text layer needed for precise Zotero highlights.
- Source navigation depends on provider blocks and coordinates; older cached
  results may remain readable without source links. MinerU and Mistral results
  have independent parser profiles and caches.
- Navigation currently goes from Markdown to PDF. Reverse navigation is not
  implemented.
- Mktero displays text highlights and underlines, not standalone notes,
  image/area annotations, or ink annotations.
- Markdown images are limited to supported GIF, JPEG, PNG, and WebP files from
  the current result archive. Remote images are blocked.
- Links are restricted to `http`, `https`, `zotero`, and document fragments.
- Markdown correction mode only edits or removes existing blocks. Prose around
  formulas and MinerU dollar-wrapped citation tokens is editable, but those
  tokens and annotated text are protected and their blocks cannot be deleted;
  delete an annotation before changing its text. Document structure, images,
  and raw HTML also remain protected.
- AI translation is an optional cached reading layer. It does not modify source
  Markdown or get included in snapshots.
- Selection translation is a separate, on-demand reading aid. It is available
  only from source text in Markdown reading views, is not cached, and may incur
  AI provider usage costs.
- Archives, Markdown, images, source maps, PDF indexes, and KaTeX rendering have
  local resource limits and fail safely when those limits are exceeded.

## Troubleshooting

In Zotero, open `Help -> Debug Output Logging`, enable logging, reproduce the
problem, and filter for `Mktero:`. Confirm that the PDF is downloaded locally,
the selected provider's API credential is valid, and the current network can
reach that provider. Logs do
not contain API Tokens, presigned upload URLs, MinerU batch IDs, or PDF content.

For a confirmed, reproducible bug, open a [GitHub Issue](https://github.com/tenglvjun/mktero/issues)
with the Zotero and Mktero versions, operating system, PDF type, reproduction
steps, expected behavior, and actual behavior. Never attach API Tokens, private
PDFs, authenticated URLs, or local file paths.

## Development

Use the Node.js version in [`.node-version`](./.node-version), currently
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
consistent before tagging a release. See [AGENTS.md](./AGENTS.md) for the
architecture, security invariants, and contribution checklist.

## Contributing

Pull requests are welcome. For ideas, reading workflows, and beta feedback, use
[GitHub Discussions](https://github.com/tenglvjun/mktero/discussions). For
changes to runtime behavior, run the complete verification commands above and
include tests for the affected behavior. Please keep credentials, private PDFs,
and other sensitive data out of issues, pull requests, and logs.

## License

[MIT](./LICENSE) © 2026 Tony
