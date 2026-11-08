# References and export

[English](./references-and-export.md) · [简体中文](./references-and-export.zh-CN.md) · [Back to README](../README.md)

Check and import a paper's references, explore connections in your library, and save a snapshot or export Markdown or EPUB with its figures. Exported text includes your saved corrections.

## Import references from Markdown

1. Open a citation popup. Mktero checks local Zotero presence before making any network lookup.
2. Choose a target from the accessible personal and group libraries. The popup header contains only this library picker; each reference has its status on the left and its own action on the right.
3. Choose the action for the reference you want: `Open in Zotero`, `Copy to selected library` when it exists elsewhere, or `Import reference` when it is missing. Imports can include an optional public PDF attachment.

For a title-only reference, `Import reference` explicitly starts a bounded OpenAlex lookup. A unique title, year, and author match proceeds directly to import; otherwise you may choose from at most three plausible candidates. See [reference matching](#reference-matching) for date tolerance and citation parsing.

Read-only libraries remain selectable for presence checks, but their import actions are disabled with a permission explanation. A failed PDF download keeps the imported metadata; use `Retry PDF` to try the attachment again. Copying an item from another library is an explicit action, so Mktero does not silently create a duplicate.

## Explore the citation graph

Click the citation graph button on the right of the reader toolbar, beside the GitHub button when present. The graph contains the focused paper and direct references that match items already in the **current Zotero library**. Focus mode hides this button.

When supported, Mktero queries DOI and arXiv identifiers concurrently through Semantic Scholar, OpenCitations, and OpenAlex. Matching requires a unique normalized identifier, never a title; provider metadata stays local.

In a paper's graph details, `Open with Mktero` opens its first local PDF attachment through the same workflow as `Read as Markdown with Mktero`.

## Save a portable snapshot

`Save snapshot`, `Export Markdown`, `Export to Obsidian`, and `Export EPUB` share the toolbar's `Save and export` menu, the share button before `⋯`, in that order. In a reading pane **680px wide or narrower**, all four actions move into `⋯`. While figures are being restored from the PDF, the save/export entry and its actions remain visible but disabled; Focus mode hides the entry.

Choose `Save snapshot` to create a dedicated `Mktero Markdown Snapshot` Zotero note under the PDF's parent item. It contains portable HTML, figures as embedded image attachments, and the original Markdown and source map as related attachments.

A standalone PDF without a parent library item cannot save a snapshot. If you edited the snapshot note, Mktero refuses to overwrite it silently. Optional figure metadata and older-snapshot support are described in [snapshot attachments](#snapshot-attachments).

## Export Markdown

1. Switch to the reading view you want to save: `Original`, `Translation`, or `Bilingual`.
2. Choose `Export Markdown` from `Save and export` (or `⋯` in a narrow pane), then select a folder in the system folder picker.
3. If the folder is `A` and the paper title is `B`, the result is `A/B/B.md`, with extracted figures in `A/B/assets/`. Mktero updates the Markdown image paths.

This action exports the view you are reading and never runs automatically. Existing exports are not overwritten: if `B` exists, Mktero creates a numbered directory such as `B-2` with a matching `B-2.md`. See [file and path rules](#file-and-path-rules) for Windows and image-name handling.

## Export EPUB

1. Open the document and switch to the reading view you want to save: `Original`, `Translation`, or `Bilingual`.
2. Choose `Export EPUB`, the fourth action in `Save and export` (or `⋯` in a narrow pane). If figure restoration is still running, wait until the action becomes available.
3. In the local file picker, choose a location and file name, then save. The suggested name uses the paper title and ends in `.epub`; Mktero adds the extension if it is missing. Cancelling the picker writes nothing.

The reflowable EPUB contains the current document's selected reading view, including saved corrections. It packages available local images, splits chapters at top-level headings, and includes a chapter table of contents. Heading links point to their chapter, recognized citations link to the reference section, and recognized footnotes appear at chapter ends with links from the text.

Formulas, including mathematical author markers and citations, are rendered locally as PNG images so readers without MathML support retain their layout. Repeated formulas share an image, inline images scale with the text and preserve baseline alignment, and citation links remain attached. Formula symbols are images rather than selectable text. Ordinary tables remain HTML tables; tables estimated to be too wide are rendered as PNG images and packaged in the book. Link navigation depends on the EPUB reader.

EPUB export uses the Markdown and image assets already loaded for reading. It starts no OCR or conversion, reads no PDF, and writes neither Mktero caches nor the Zotero library. Only the chosen local export file is saved, and Mktero does not sync that copy. To export many papers at once, use [batch export](#batch-export).

## Export to Obsidian

Choose `Export to Obsidian` to write the original Markdown into a local vault. This action uses the original text regardless of the open reading view, and writes each complete saved translation beside it. Incomplete translations and the bilingual reading view are not exported.

The first export asks you to choose the vault folder containing `.obsidian`; later exports reuse it. Change the vault in Mktero settings when needed. Notes always go in the vault's `Mktero` folder, so they do not replace literature notes created by another plugin.

For a paper named `B`, the original is `<vault>/Mktero/B/B.md` and figures are in `<vault>/Mktero/B/assets/`, using ordinary relative image links. The Simplified Chinese translation is named `B - chinese`; other languages use the same pattern, such as `japanese` or `spanish`. For a single Markdown file in the current reading view instead, use [Export Markdown](#export-markdown).

Exporting the same Zotero item again updates its note even if the title changes. A note edited in Obsidian, or a file belonging to another item, requires confirmation before overwriting. Mktero does not delete extra files you add under `assets/`; Obsidian Sync, iCloud, or git can carry the vault, but Mktero does not sync it.

### Batch export

1. Right-click a selection and hover `Export selected Markdown` to open its submenu, or right-click a collection and use `Export collection tree Markdown`. The submenu offers four actions in the same order as the reader's `Save and export` menu: `Save snapshot`, `Export Markdown`, `Export to Obsidian`, and `Export EPUB`. The submenu appears only when at least one PDF in the selection or collection tree already has readable Markdown, using the Markdown column's readiness check.
2. A collection includes all descendants, like `Prepare collection tree Markdown`. Confirm the total number of unique PDFs and the number that currently have Markdown; only ready Markdown is exported, and the report lists the other PDFs' status.
3. A batch of `Markdown` or `EPUB` asks for one parent folder, then writes a paper-named subfolder or `.epub` file per document inside it; a repeated title gets a numbered suffix instead of overwriting an existing file. `Save snapshot` needs no folder and writes a Zotero note. `Export to Obsidian` asks for the vault once if none is saved. Cancelling the picker writes nothing. `Cancel` during the batch stops items that have not started; files already written are not rolled back.
4. A batch always writes the original Markdown rather than the current reading view, because a selection has no single active view. `Export Markdown` and `Export EPUB` in the reader toolbar still follow the view you are reading.

For one selected item, the export entry appears beside reading when Markdown is ready; it does not replace reading. A selection with no ready Markdown does not show the entry. The per-item actions (`Export to Obsidian` and `Save snapshot`) handle one parent item as one output: if it has several converted PDFs, the first with a cache wins and the others are skipped. `Export Markdown` and `Export EPUB` write one file per PDF and never merge two attachments of the same item. A standalone PDF with no parent library item cannot save a snapshot; that row reports a failure and the rest of the batch continues.

A cache miss never starts OCR or conversion. Batch export is not an account feature or automatic sync. See [batch updates and conflicts](#batch-updates-and-conflicts) for existing files.

## Details

### Reference matching

For title-only references, a unique exact title, year, and author match continues directly into import. A provider date difference of **one year** is accepted only when the cleaned title is nearly identical and the first author matches. Other results offer at most **three** plausible candidates; choosing one continues the same import.

The lookup retries with a cleaned title if a full citation is too noisy. It also covers OpenAlex records without a DOI, such as books. Citation parsing separates the title from surrounding metadata:

- For IEEE-style references, a paired straight or typographic double-quoted article title is searched separately from authors, venue, volume, and pages.
- For unquoted conference references, the paper title is separated from a following `In ... Conference`, proceedings, workshop, or symposium venue.

Missing references with a reliable DOI, arXiv ID, or PMID use Zotero's native translator. Confirmed OpenAlex-only records, including books, are created directly from their bounded metadata. If the target library permits files, Mktero also tries an arXiv or configured open-access PDF; the metadata remains available if that download fails.

Grouped author-year citations resolve every matched bibliography entry, including ACM/natbib square-bracket forms such as `Lewis et al. [2020]` and `[Kirkpatrick et al., 2017; Wei et al., 2026]`. If conversion inserts a stray heading inside an APA-style bibliography, the reference list continues only when multiple bibliography-shaped entries clearly resume after it. A genuine author note still ends the list.

### Snapshot attachments

Restored figures can include an optional `figure-map.json` attachment recording page regions, panel identities, and consumed OCR fragments. Missing or invalid metadata never prevents reading the saved Markdown and PNGs. Older snapshots remain readable.

### File and path rules

On Windows, long titles are shortened so that the folder, Markdown file, and temporary file used during writing all stay under the **260-character path limit**. The same limit applies inside an Obsidian vault.

Image names that collide on case-insensitive filesystems are numbered, and their Markdown references are updated. Distinct figures cannot overwrite each other.

### Obsidian formatting and metadata

Figure captions are written below each image, not in its alt text: Obsidian does not render an image whose alt text contains brackets.

YAML frontmatter includes the title, authors, year, DOI, tags, a `zotero://` link, and the Zotero item identity. A Better BibTeX citation key (`citekey`) is included only when Extra already contains one.

### Batch updates and conflicts

The vault is resolved once for the whole batch, and notes still go in its `Mktero` folder. Notes previously written by Mktero and not edited in Obsidian update without asking.

Notes edited in Obsidian, or files belonging to another item, are skipped during the batch. Mktero asks about those conflicts once at the end.

`Export Markdown`, `Export EPUB`, and `Save snapshot` need no such question: a repeated folder or file name gets a numbered suffix, and a snapshot updates the existing Mktero snapshot for that item. Only a snapshot note edited by hand reports a conflict.
