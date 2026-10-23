# Reading and annotation workflows

[English](./workflows.md) · [简体中文](./workflows.zh-CN.md) · [Back to README](../README.md)

## Source-aware reading

OCR content mappings connect Markdown blocks to physical PDF pages and
regions. Source links and source-aware copy use those mappings when they are
reliable; Mktero does not guess a location when a match is ambiguous. Selecting
PDF text offers `Open in Markdown` when that PDF already has a readable cache.
A unique source region focuses the Markdown paragraph. If no region overlaps
the selection, a passage that occurs in exactly one cached paragraph still opens.
A complete translation
for that passage switches an original view to bilingual and leaves an existing
translation or bilingual view unchanged. No translation request is started.
Markdown is rendered in an isolated shadow root with a restricted link and image policy.
Academic figure captions are recognized in common publisher formats, including
`Figure N | ...` captions that follow an empty OCR image, so prose figure
references remain previewable in cached documents.

## Footnotes and article information

In a MinerU result, a footnote at the foot of a PDF page appears as a small,
muted note right after the first paragraph of that page that carries its mark
(a superscript number, `*`, or `†`). A note whose mark is not found follows the
last paragraph of its page, without crossing a heading. Table and figure notes
use the same style directly below their table or figure. Notes are ordinary
quoted text: you can search, annotate, translate, and copy them. A footnote
mark in the text is a link to its note, and the mark at the start of the note
links back; both are recorded as jumps, so `Alt+Left` (`Cmd+[` on macOS)
returns to where you were.

Article metadata that is not part of the reading text goes into a collapsed
section: affiliations, contact and contribution notes, funding, dates, and a
journal's first-page sidebar appear under `Article information` below the
title and author line, so the first screen shows the title, the authors, and
the abstract. Author biographies after the references appear under `Author
biographies`, and a Nature reporting summary under `Reporting summary`. A
section is collapsed whenever the document opens. Its header is a button you
can click or activate with `Enter` or `Space`. Search results, annotations,
and other jumps into a collapsed section open it first. Headings inside a
section are not listed in the outline. Snapshots and Zotero notes show the
section label in bold followed by its content. Markdown and Obsidian exports
keep the content as ordinary text; the section markers are HTML comments and
do not show in Obsidian.

Mktero recognizes these parts from the layout and the wording of the page.
A note can land after a different paragraph when its mark is printed in an
unusual way, and metadata that does not look like metadata stays in the text.

## Copy a formula, a code block, or a table

A display formula and a table show their copy actions in the top corner when
you point at them, and a code block has one in its toolbar.

Copying a formula puts the TeX behind the rendered formula on the clipboard,
including the OCR repairs Mktero applied so the formula could be typeset. A
formula that was too large to render, or that used a command Mktero refuses to
render, copies its source instead. Every display formula in a saved snapshot
offers the same action when that snapshot is open in the reader.

A table offers `Copy as Markdown` and `Copy as CSV`. When the reader rendered
the table from a GFM block, the Markdown action is that block, so it pastes
back as the same table. A table the paper carries as HTML, and every table in a
saved snapshot, is converted back into a pipe table instead: the `thead` row
becomes the header (the first row is promoted when there is none), merged cells
are expanded, column alignment comes from the cells' own `align` attribute, and
bold, italic, code, links, formulas, and superscripts keep their meaning.

The CSV action writes comma-separated rows with plain-text cells: inline markup
such as bold text, links, and formulas is reduced to what you read on screen,
and a citation keeps its `[1]` marker. Cells that contain a comma or a quote are
quoted the RFC 4180 way, and the caption is not part of the data. A copy is
refused, rather than truncated, when a table is larger than the reader's export
budget.

All of these actions read the rendered document only. They send nothing, and
they do not change the cached OCR Markdown, the corrections, or the note.

## Find your place and get back

A thin bar along the bottom edge of the reading pane shows how far through the
document you are. It appears only while the document is long enough to scroll
and is hidden in focus mode.

Jumping away from where you are reading records that spot, so you can return to
it. These jumps are recorded: opening a citation, a table reference, or a
figure reference; choosing an outline entry or a note; following an in-document
link; and searching. Stepping through the matches of one search counts as a
single jump. `Alt+Left` goes back and `Alt+Right` goes forward on Windows and
Linux, and `Cmd+[` and `Cmd+]` do the same on macOS; either platform's chord
works on both, and the arrow buttons at the start of the toolbar are the same
action. Going back keeps the place you left, so forward returns to it; a new
jump after going back discards the forward steps. Up to 50 positions are kept
for the open document. They are not saved: closing the tab or replacing the
document, for example by reparsing, clears them. Scrolling by hand does not create
history entries.

## Correct recognition errors

Double-click an existing paragraph, heading, or GFM table cell to edit it, then
save or cancel explicitly. Closing the tab, the main window, or Zotero saves an
edit that is still open; press `Escape` or Cancel to discard it.
Existing paragraphs and headings can also be
deleted and restored from `Manage corrections`. Corrections are stored
separately from the conversion cache and are tied to the PDF content and the
selected provider's parser profile. If saved corrections can no longer be
read, the document opens with the original recognition result and a warning;
the next saved correction or a reparse replaces the unreadable data. They cannot insert or reorder blocks, add images, or add raw
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
can be retried instead of receiving a guessed PDF position. If saved local
annotations cannot be fully read, Mktero keeps the original file as a backup
named `item-<id>.corrupt-<timestamp>.json` in `mktero-annotations/v1` in the
Zotero profile, shows a warning, keeps the annotations that are still
readable, and accepts new annotations. When a highlight
overlaps a citation, table reference, or figure reference, that semantic
reference keeps interaction priority; annotation actions remain available from
the surrounding highlighted text or its note marker.
Selections that cross a PDF page break are split into one single-page Zotero
highlight per page, so the complete Markdown selection remains navigable. A
paragraph that resumes a page or two later is located the same way, across the
full-page figure or running footer in between.
Common MinerU LaTeX math symbols and simple subscripts are normalized to the
PDF's extracted text, and a few characters the PDF text layer mangles inside a
passage are tolerated, so selections that include formulas can still be
located. A display formula whose LaTeX never survives extraction falls back to
the OCR region recorded for that block.

## Translate with AI

AI translation is always opt-in and never rewrites the source Markdown. Mktero
groups the article into bounded Markdown batches, protects formulas, citations,
links, code, images, and structural placeholders, and runs at most five
requests concurrently. Choose `Original`, `Translation`, or `Bilingual` in
the reader. Translations are cached independently by source content, provider,
protocol, model, language, reasoning effort, and prompt version, so partial
work can resume. When a Mktero update reads a MinerU result again, the new
document keeps the translation of every block whose text did not change; only
the changed blocks are marked for translation.
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
cache. Each selection request sends only the selected text to the configured
AI provider and may incur provider usage costs.

Mktero includes adapters for OpenAI, Anthropic, Google Gemini, DeepSeek,
Alibaba Cloud Model Studio, Moonshot/Kimi, MiniMax, and custom OpenAI-compatible
or Open Responses services through Vercel AI SDK Core. Remote endpoints must
use HTTPS; loopback services such as Ollama or LM Studio may use HTTP. Custom
OpenCode Go bases such as `https://opencode.ai/zen/go/v1` also receive a
per-conversation `x-opencode-session` header. Reasoning effort follows the selected model when Mktero knows it from
[models.dev](https://models.dev): Mktero fetches that catalog once when Zotero
starts, keeps it in memory, and drops it when Zotero quits. Unsupported models
only offer `none`, models that cannot disable thinking omit `none`, and other
known models list their supported levels, which may include `on`, `minimal`, or
`max`. Unknown models, or a failed catalog fetch, keep `none`, `low`, `medium`,
`high`, and `xhigh`. Reasoning output is not saved as translation text.

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

## See which items already have Markdown

The item list has a Markdown column. A mark means this computer can open that
PDF's cached Markdown with the current conversion settings. A spinner means
the PDF is queued or converting in this session; it is not stored. Clearing
the cache, letting a result expire, or switching provider or MinerU service
turns the ready mark off. It does not sync, and it does not change the Zotero
item. You can hide the column from the item-list column picker; that choice is
remembered.

Select several library items or PDF attachments and choose `Prepare selected
Markdown`, or right-click one collection and choose `Prepare collection
Markdown`. Both actions queue every selected PDF and do not
open a reader tab. A collection action includes only that collection's own
items, not items that belong only to a subcollection. Right-clicking one paper
still opens it for reading. Already cached or already preparing items
are skipped. Zotero's progress window
shows each item; minimizing it continues the queue, and Cancel stops items
that have not finished. Opening one of those PDFs joins the existing
preparation instead of uploading it again. Closing a tab during conversion
does not cancel it; the PDF continues in the background queue.

## Export Markdown

`Export Markdown` opens the system folder picker. If the selected folder is `A`
and the paper title is `B`, Mktero creates `A/B/B.md` and writes extracted
figures under `A/B/assets/`, updating their Markdown paths accordingly. If `B`
already exists, a numbered directory such as `B-2` is created with a matching
`B-2.md`; existing exports are never overwritten. On Windows, a long title is
shortened so the folder, the Markdown file, and the temporary file used while
writing stay under the 260-character path limit. The same limit applies inside
an Obsidian vault. Image names that collide on
case-insensitive filesystems are numbered and their Markdown references are
updated, so distinct figures cannot overwrite each other. Export does not
include translated or bilingual views and never runs automatically.

## Export to Obsidian

`Export to Obsidian` writes the original Markdown, not the view currently
open, into a folder inside a local Obsidian vault. Each complete saved
translation is written beside it: a paper named `B` stays `B`, and its
Simplified Chinese translation is `B - chinese`. Other languages use the same
pattern, such as `japanese` or `spanish`. Incomplete translations and the
bilingual reading view are not exported. `Export Markdown` still saves only
the view you are reading. The first export asks for the vault folder that
contains `.obsidian`. Later exports reuse it. Settings can change the vault.
Notes always go in the `Mktero` folder, so they do not replace a literature
note created by another plugin.

A paper titled `B` becomes `<vault>/Mktero/B/B.md`, with figures in
`<vault>/Mktero/B/assets/` and ordinary relative image links. Figure captions
are written below each image, not inside its alt text, because Obsidian does
not render an image when the alt text contains brackets. YAML frontmatter
carries the title, authors, year, DOI, tags, a `zotero://` link, and the
Zotero item identity. A Better BibTeX citation key is included only when Extra
already contains one. Exporting the same item again updates that note even if
the title changes. If the note was edited in Obsidian, or the file belongs to
another item, Mktero asks before overwriting it. Mktero does not delete extra
files you later add under `assets/`. Obsidian Sync, iCloud, or git can carry
the vault; Mktero does not.

### Batch export

The item menu shows `Export selected Markdown to Obsidian` only when at
least one selected item already has converted Markdown, using the same check
as the Markdown column. One selected item shows the export beside reading
only when that item has Markdown; reading is not replaced. A selection with
no converted Markdown does not show it. A collection shows `Export collection
Markdown to Obsidian` only when at least one of that collection's own items
has converted Markdown. It uses the same collection scope as `Prepare
collection Markdown`: that collection's own items, not items that belong only
to a subcollection.

Only Markdown that has already been converted is exported. A cache miss does
not start OCR or conversion. One Zotero parent item becomes one note. If
several converted PDFs belong to the same item, the first one with a cache is
exported and the others are skipped.

The vault is resolved once for the batch. If none is saved, Mktero asks once;
cancelling that choice writes nothing. Notes still go in the vault's `Mktero`
folder. Mktero does not sync the vault. Notes Mktero previously wrote, and
that were not edited in Obsidian, update without asking. Notes edited in
Obsidian, or files that belong to another item, are skipped and asked about
once at the end. Cancel stops items that have not started. Files already
written are not rolled back. This is not an account feature and not automatic
sync.
