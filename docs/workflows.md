# Reading and annotation workflows

[English](./workflows.md) · [简体中文](./workflows.zh-CN.md) · [Back to README](../README.md)

## Source-aware reading

OCR content mappings connect Markdown blocks to physical PDF pages and
regions. Source links and source-aware copy use those mappings when they are
reliable; Mktero does not guess a location when a match is ambiguous. Markdown
is rendered in an isolated shadow root with a restricted link and image policy.
Academic figure captions are recognized in common publisher formats, including
`Figure N | ...` captions that follow an empty OCR image, so prose figure
references remain previewable in cached documents.

## Correct recognition errors

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

## Annotate from Markdown

Existing Zotero text highlights and underlines are loaded when a document opens.
Drag across headings or body text to select it, including headings and paragraph
endings immediately below figures and display formulas.
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

## Translate with AI

AI translation is always opt-in and never rewrites the source Markdown. Mktero
groups the article into bounded Markdown batches, protects formulas, citations,
links, code, images, and structural placeholders, and runs at most five
requests concurrently. Choose `Original`, `Translation`, or `Bilingual` in
the reader. Translations are cached independently by source content, provider,
protocol, model, language, reasoning effort, and prompt version, so partial
work can resume.
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
use HTTPS; loopback services such as Ollama or LM Studio may use HTTP. Custom
OpenCode Go bases such as `https://opencode.ai/zen/go/v1` also receive a
per-conversation `x-opencode-session` header. Reasoning effort can be set to
`none`, `low`, `medium`, `high`, or `xhigh`; reasoning output is not saved as
translation text.

## Explore the citation graph

The citation graph contains the focused paper and direct references that can be
matched to items already in the current Zotero library. DOI and arXiv
identifiers are queried concurrently from Semantic Scholar, OpenCitations, and
OpenAlex when supported. Matching uses a unique normalized identifier, never a
title, and provider metadata stays local. The graph details include a button
labeled `Open with Mktero`. It opens the first local PDF attachment through the
same Markdown reading workflow as `Read as Markdown with Mktero`.

## Import references from Markdown

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

Grouped author-year citations resolve every matched bibliography entry, including ACM/natbib square-bracket forms such as `Lewis et al. [2020]` and `[Kirkpatrick et al., 2017; Wei et al., 2026]`. If PDF
conversion inserts a stray heading inside an APA-style bibliography, Mktero
continues the reference list only when multiple bibliography-shaped entries
clearly resume after it, so a genuine author note still ends the list.

## Save a portable snapshot

`Save snapshot` creates a dedicated `Mktero Markdown Snapshot` Note under the
PDF's parent item. The Note contains portable HTML; figures are embedded image
attachments; the original Markdown and source map are related attachments.
Restored figures also include an optional `figure-map.json` attachment with
page regions, panel identities, and consumed OCR fragments. Missing or invalid
metadata never prevents reading the saved Markdown and PNGs; older snapshots
remain readable.
Mktero refuses to silently overwrite a snapshot Note that you edited. A
standalone PDF without a parent library item cannot save a snapshot.

## Export Markdown

`Export Markdown` opens the system folder picker. If the selected folder is `A`
and the paper title is `B`, Mktero creates `A/B/B.md` and writes extracted
figures under `A/B/assets/`, updating their Markdown paths accordingly. If `B`
already exists, a numbered directory such as `B-2` is created with a matching
`B-2.md`; existing exports are never overwritten. Image names that collide on
case-insensitive filesystems are numbered and their Markdown references are
updated, so distinct figures cannot overwrite each other. Export does not
include translated or bilingual views and never runs automatically.
