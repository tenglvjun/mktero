# Reading

[English](./reading.md) · [简体中文](./reading.zh-CN.md) · [Back to README](../README.md)

Mktero reflows OCR output, multi-column text, formulas, tables, figures, lists, and code into a continuous reading document. This page covers navigation, the PDF source, copying, reading controls, and optional AI translation.

Adjacent inline formulas in algorithm steps render separately, preserving their boundaries without changing the algorithm's text, indentation, or ordinary code.

## Move around the document

- Use `Headings` in the left column for the outline, or `Figures` for the figure/table index.
- Open previews of citations, author affiliations, figures, and tables without leaving the reader.
- Press `Cmd/Ctrl+F` to find text in the body.
- Watch the thin progress bar at the bottom of the reading pane. It appears when the document is long enough to scroll and is hidden in focus mode.

After a jump, use the arrows at the start of the toolbar to return or go forward. The keyboard shortcuts are:

| Action | Windows / Linux | macOS |
| --- | --- | --- |
| Back | `Alt+Left` | `Cmd+[` |
| Forward | `Alt+Right` | `Cmd+]` |

Either platform's shortcuts work on both. [History details](#move-around-the-document-1) explain which jumps are recorded and when history clears.

## Go between Markdown and the PDF

OCR mappings connect Markdown blocks to physical PDF pages and regions. Reliable source links take text, formulas, tables, and figures back to the PDF; `Copy with source` copies a passage with its source link. Ambiguous matches do not receive a guessed location.

To go from the PDF to Markdown:

1. Select text in Zotero's PDF reader. If that PDF already has a readable cache, choose `Open in Markdown`.
2. A unique overlapping source region opens its Markdown paragraph. If no region overlaps, a passage found in exactly one cached paragraph can still open it.
3. If that passage has a complete translation, an `Original` view switches to `Bilingual`. An existing `Translation` or `Bilingual` view stays as it is; no translation request starts.

The `PDF source thumbnail` shows a live PDF crop of the current paragraph. Its switch is in `Typography` (`Aa`).

When layout evidence, page coordinates, and Markdown ranges agree, Mktero rebuilds figures from the local PDF. A background worker replaces placeholders in place, so slow restoration does not block reading; see the [figure pipeline](./figure-pipeline.md).

## Footnotes and article information

In MinerU results, footnotes appear as small, muted quoted text near the paragraph that cites them. You can search, annotate, translate, and copy them. Click a mark labeled `Go to footnote` to reach its footnote, or the mark at the start of the footnote to return; both jumps enter reading history.

Metadata outside the main reading text appears in collapsed sections:

| Section | Content |
| --- | --- |
| `Article information` | Affiliations, contact and contribution notes, funding, dates, and a journal's first-page sidebar, below the title and author line |
| `Author biographies` | Author biographies after the references |
| `Reporting summary` | A Nature reporting summary |
| `Chart data` | Data read from a chart by a self-hosted MinerU service's high-effort tier; tables remain tables |

This leaves the title, authors, and abstract on the first screen. Sections start collapsed each time the document opens. Click their header button, or use `Enter` or `Space`, to expand them; search results, annotations, and other jumps into a section expand it first. Headings inside a section stay out of the outline.

## Copy a formula, a code block, or a table

Point at a display formula or table to show its copy actions in the top corner. Code blocks have a copy action in their toolbar.

| Content | Action | Clipboard text |
| --- | --- | --- |
| Display formula | `Copy LaTeX` | Standard Markdown: a `$$` block containing the rendered formula's TeX, including Mktero's OCR repairs |
| Code block | `Copy code` | The code block's text |
| Table | `Copy as Markdown` | A Markdown table |
| Table | `Copy as CSV` | Comma-separated rows with plain-text cells |

Formula copy and table `Copy as Markdown` also include HTML, so pasting into a Zotero note keeps the formula or table. A Markdown editor that renders TeX math also displays the formulas.

Use `Cmd/Ctrl+C` for a passage as standard Markdown, with formulas as inline `$…$` or `$$` blocks. A passage containing formulas or a table also includes HTML for a Zotero note; a passage without either is text only. `Copy with source` in the selection menu makes a quote with Markdown math and a source link, which pastes into a Zotero note with typeset formulas and a working link.

These actions read only the rendered document. They send nothing and do not change cached OCR Markdown, corrections, or comments. [Copy details](#copy-a-formula-a-code-block-or-a-table-1) cover table conversion, selections inside formulas and cells, and other applications.

## Adjust the reading view

Open `Typography` (`Aa`) in the toolbar to choose:

- The text font and a body size from 14 to 28 px.
- Tight, standard, or loose line height.
- A narrow, standard, or wide column.
- Left alignment, the default, or justified body text.
- `PDF source thumbnail`, on by default.

The column follows the window width up to the chosen maximum; text, figures, tables, and code share that width. The same options are available in [Configuration](./configuration.md), which lists their defaults and width limits.

`Focus mode` hides the side panels and toolbar controls for back/forward, the citation graph, `Save and export`, and `⋯`; the progress bar is hidden too. Use `Exit focus mode` or press `Escape` to leave. If a reader menu or search is open, `Escape` closes it first.

## Translate with AI

### Translate the article

1. Configure and enable AI translation in [Mktero settings](./configuration.md).
2. Choose `Translate document`. Translation starts only when requested and never rewrites the source Markdown.
3. Switch between `Original`, `Translation`, and continuous `Bilingual` reading. Partial work can resume block by block.

Once a complete translation exists, the `Translation` tab opens the language menu. `Retranslate document` at the end of that menu translates the whole document again in the current language.

Mktero groups the article into bounded Markdown batches, protects formulas, citations, links, code, images, and structural placeholders, and runs at most five requests concurrently. Cache and correction rules are in [translation details](#translate-with-ai-1).

### Translate a selection

1. Select a term or passage in `Original`, or on the source side of `Bilingual`.
2. Choose `Translate selection` at the end of the selection popup's action row. A compact panel expands below it for loading, results, or errors.
3. With a streaming provider, text appears as it arrives and you can still cancel. A non-streaming provider shows the result when finished.
4. After success, use `Translate selection again` or `Copy selection translation` to copy plain text.

`Automatically translate Markdown selections` is off by default. When enabled, a stable selection starts one bounded request after a short delay. Selection translation is unavailable on the translated side of `Bilingual`, in `Translation`, and in saved HTML snapshots.

Each request sends only the selected text to your configured AI provider and may incur provider usage costs. The result stays in the popup: it does not change Markdown or comments and does not enter the full-document translation cache.

## Details

### Move around the document

History records opening a citation, table reference, or figure reference; choosing an outline entry or annotation; following an in-document link; and searching. Moving through matches of one search counts as one jump. Scrolling by hand creates no history entries.

Going back saves the spot you leave so forward can return to it. A new jump after going back discards the forward steps. Each open document keeps up to 50 positions in memory; closing its tab or replacing the document, such as by reparsing, clears them.

### Go between Markdown and the PDF

For MinerU documents, safe PDF-native HTTP(S) link annotations and MinerU hyperlinks retain their original destinations, including underscores in URLs. Mktero does not infer a destination from the visible text; missing or unsafe targets stay ordinary text. Markdown renders in an isolated shadow root with a restricted link and image policy.

Academic captions are recognized in common publisher formats, including `Figure N | ...` after an empty OCR image. This keeps prose figure references previewable in cached documents.

Mktero reads the PDF's text layer locally to repair MinerU reading text: it rejoins a paragraph split at a full stop by a page or column break, levels headings by type in papers without section numbers, and restores single words that OCR changed in a typeset PDF, such as a name or an author's spelling.

### Footnotes and article information

#### Placement and recognition

- A page-bottom footnote follows the first paragraph on that page carrying its mark: a superscript number, `*`, or `†`.
- If no mark is found, the footnote follows that page's last paragraph without crossing a heading.
- Table and figure notes use the same style immediately below their table or figure.
- Layout and page wording guide recognition. An unusual mark can put a footnote after a different paragraph; unrecognized metadata remains in the text.

Mktero hides publisher mastheads, first-page copyright notices, repeated headers and footers, and page numbers. Long article titles retain their heading style.

For a confirmed publisher cover followed by the same article title and an abstract or introduction, MinerU reading uses the article page's title and authors and omits the cover's duplicate title and byline. It omits submission prompts, view counts, related-article controls, and associated icons. Citation, DOI, and publication-date fields stay in `Article information` alongside metadata from the article page. Physical PDF page numbers and source locations stay unchanged.

#### Saved and exported sections

[Snapshots](./references-and-export.md#save-a-portable-snapshot) and [Zotero notes](./annotations.md#zotero-notes-beside-the-reader) show a section's label in bold followed by its content. [Markdown](./references-and-export.md#export-markdown) and [Obsidian](./references-and-export.md#export-to-obsidian) exports keep the content as ordinary text. Section markers are HTML comments and do not show in Obsidian.

### Copy a formula, a code block, or a table

#### Formulas and tables

- A display formula too large to render, or using a command Mktero refuses to render, copies its source alone. Display formulas in saved snapshots offer the same copy action when opened in the reader.
- For a table rendered from GFM, `Copy as Markdown` copies that GFM block, so it pastes back as the same table.
- An HTML table from the paper, or any table in a saved snapshot, becomes a pipe table. The `thead` row is the header; without one, the first row is promoted. Merged cells expand, alignment follows cells' own `align` attributes, and bold, italic, code, links, formulas, superscripts, and subscripts keep their meaning.
- CSV reduces inline formatting, links, and formulas to the text shown on screen, retaining a citation's `[1]` marker. Cells containing commas or quotes use RFC 4180 quoting; captions are excluded.
- A table beyond the reader's export budget is refused rather than truncated.

#### Keyboard selections and paste destinations

`Cmd/Ctrl+C` uses the TeX the reader typesets, turns HTML tables into pipe tables with their formulas, and omits hidden headers, footers, and page labels. When HTML is included for a Zotero note, it contains every formula, even a single letter such as `$i$`.

| Selection | Result |
| --- | --- |
| Inside a rendered formula | The whole formula |
| Inside a table cell | That cell's text and formulas |
| Across cells of a rendered table | Those cells as a table |
| A formula too large or refused for rendering | Its source |
| A long passage with very many formulas | Markdown only |

An application that reads clipboard HTML, such as a word processor or browser editor, receives the passage with formulas as TeX between `$` signs. Paste as plain text there to get Markdown. CSV and code copy are unchanged by these formula and table rules.

### Translate with AI

#### Cache and corrections

Translations are cached independently by source content, provider, protocol, model, language, reasoning effort, and prompt version. This lets partial work resume. When an update rereads a MinerU result, unchanged blocks keep their translations; changed blocks become pending.

| Change | Translation behavior |
| --- | --- |
| Delete a block with a local correction | Other blocks keep their translations; the deleted block disappears from `Bilingual` |
| Restore a deleted block | Earlier source versions are retained, so a complete translation can be reused even after the corrected document was translated |
| Delete a citation marker | That block keeps its translation if protected placeholders can be mapped unambiguously; ambiguous changes remain pending for block-only retranslation |
| Edit a translated block | Other translations stay; the changed block becomes pending and Mktero offers to retranslate only that block |
| Restore all corrections | A complete cached translation of the original Markdown reloads when available, without a new AI request |

#### Providers and connection rules

Vercel AI SDK Core adapters support OpenAI, Anthropic, Google Gemini, DeepSeek, Alibaba Cloud Model Studio, Moonshot/Kimi, MiniMax, and custom OpenAI-compatible or Open Responses services. Remote endpoints must use HTTPS; loopback services such as Ollama or LM Studio may use HTTP. A custom OpenCode Go base such as `https://opencode.ai/zen/go/v1` also receives a per-conversation `x-opencode-session` header.

#### Reasoning effort

Mktero fetches the catalog from `https://models.dev` once when Zotero starts, keeps it only in memory, and drops it when Zotero quits. For models known to the catalog:

- Models without reasoning support offer only `none`.
- Models that cannot disable thinking omit `none`.
- Other known models offer their supported levels, which may include `on`, `minimal`, or `max`.

Unknown models, or a failed catalog fetch, use `none`, `low`, `medium`, `high`, and `xhigh`. Reasoning output is not saved as translation text.
