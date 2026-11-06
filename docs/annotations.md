# Annotations, notes, and corrections

[English](./annotations.md) · [简体中文](./annotations.zh-CN.md) · [Back to README](../README.md)

Create annotations from Markdown, write Zotero notes beside the paper, and correct recognition errors without changing the cached OCR result. An annotation is a PDF annotation or a local Markdown highlight; its text field is a comment, and a note is a Zotero note item.

## Annotate from Markdown

Existing Zotero text highlights and underlines load when a document opens. To add an annotation:

1. Drag across a heading or body text, including text immediately below a figure or display formula. A drag can start on a citation, figure/table reference, or footnote mark; clicking without dragging still opens that reference.
2. Choose `Add highlight` in the selection popup. A local annotation appears immediately; Mktero creates its Zotero PDF annotation only when the local PDF text index finds one reliable match.
3. Use the annotation popup to change its color, choose `Add comment` or `Edit comment`, or delete it.

A local highlight not yet in the PDF has a dashed underline. A failed sync has a dotted warning underline; hover to see the reason. Repeated or ambiguous text stays local and can be retried instead of receiving a guessed PDF position.

The left column's `Annotations` segment lists the paper's annotations. It offers search, a color filter, a jump to the Markdown position, `View in PDF`, delete, `Retry Zotero sync` for a local highlight, and `Add to Note`.

## Zotero notes beside the reader

The left column has `Headings`, `Figures`, and `Annotations`. The right column is `Notes`, with two tabs:

| Tab | Notes shown |
| --- | --- |
| `Item notes` | Child notes of the paper being read, newest first |
| `Standalone notes` | Top-level notes in the same Zotero library, newest first |

Other papers' child notes and notes from other libraries are not shown. Search note titles or previews in this column. `Mktero Markdown Snapshot` notes are excluded.

### Open or create a note

1. Click a note to edit it in Zotero's own note editor inside the Mktero tab. Or open the plus menu and choose `New note for this item` or `New standalone note`.
2. Use `Back to notes` to return to the list, or `Edit in a Separate Window` to open Zotero's note window.
3. Right-click a listed note for `Show in Library` (selects it in the library tab), `Edit in a Separate Window`, or `Move to Trash`. A trashed note can be restored from Zotero trash.

Both kinds are normal Zotero note items. Zotero handles their sync, search, and recovery; Mktero stores no notes. [Library permissions and editor fallback](#zotero-notes-beside-the-reader-1) are covered below.

### Add passages and annotations to a note

Open a note in the `Notes` column, including a standalone note if that is your target. Then choose `Add to Note` from a text-selection popup, an annotation popup, or an item in the `Annotations` segment.

The passage is inserted the same way as in Zotero's PDF reader: highlighted text, a citation, and the page. Clicking that citation opens Zotero's PDF reader. Adding an ordinary selection does not save a highlight.

Insertion needs both an open note and a PDF position. A local highlight not yet in the PDF, or a selection the local PDF index cannot locate (not found or ambiguous), is refused with the reason; Mktero does not insert it without a source.

To collect the PDF's annotations, choose `Add Note from Annotations` in the `Annotations` segment. Like Zotero's command, it creates a child note containing all of that PDF's annotations except ink annotations, and opens it in the `Notes` column.

## Correct recognition errors

1. In the document actions menu (`⋯` at the end of the toolbar), choose `Manage corrections`. A banner below the toolbar explains the controls.
2. Double-click an existing paragraph, heading, or GFM table cell to edit it. Choose `Save changes`, or discard the edit with `Escape` or `Cancel`.
3. In correction mode, existing paragraphs and headings can also be deleted and restored.
4. Choose `Finish correction` in the banner to leave correction mode.

Closing the tab, the main window, or Zotero saves an edit that is still open. Saving preserves the reading position and leaves the full document available while scrolling. Corrections cannot insert or reorder blocks, add images, or add raw HTML.

Corrections are separate from the immutable conversion cache. [Correction details](#correct-recognition-errors-1) explain identity, protected text, recovery, and confirmation dialogs; [translation rules](./reading.md#translate-with-ai-1) explain what happens to translated blocks.

## Details

### Annotate from Markdown

#### Selection text and matching

The saved text follows what the reader shows:

- A superscript such as `$^{*}$` is saved as its glyph.
- Text from two table cells keeps a space between them.
- A link's title is excluded.
- Formulas are saved as TeX, including formulas in figure captions and table cells; their highlights appear over the rendered formulas.

A selection split into more than 512 separate parts is refused with a message rather than saved incompletely. When a highlight overlaps a citation, table reference, or figure reference, that reference keeps interaction priority. Annotation actions remain available from surrounding highlighted text or its comment marker.

Common MinerU LaTeX math symbols and simple subscripts are normalized to the PDF's extracted text. Matching tolerates a few characters mangled by the PDF text layer, so selections containing formulas can still be located. A display formula whose LaTeX does not survive extraction falls back to that block's recorded OCR region.

A cross-page selection becomes one single-page Zotero highlight per page, keeping the whole Markdown selection navigable. A paragraph that resumes a page or two later is located the same way, across a full-page figure or running footer in between.

#### Cross-page groups

Changing one part's color, or deleting it from Markdown, affects every part Mktero created for that selection. A comment stays on the part where it was written.

Mktero stores group membership in `mktero-annotations/groups-v1` in the Zotero profile, using only Zotero annotation keys. Parts that matched pre-existing Zotero highlights are never grouped or deleted this way; parts already deleted in Zotero's reader are skipped. Cross-page highlights created before grouping was available have no group and change one part at a time.

#### Unreadable local annotations

If saved local annotations cannot be fully read, Mktero preserves the original file as `item-<id>.corrupt-<timestamp>.json` in `mktero-annotations/v1` in the Zotero profile. It shows a warning, keeps readable annotations, and still accepts new ones.

### Zotero notes beside the reader

#### Permissions and editor fallback

All note actions respect the note's library permissions. A standalone PDF without a parent item can show and create standalone notes but cannot have a child note. In a read-only library, notes open read-only and creation or deletion is unavailable.

If Zotero cannot host its note editor inside the tab, the note opens in Zotero's note window instead.

#### Formulas in added passages

A formula inserted with a passage becomes a rendered note formula. Zotero's highlights cannot contain formulas, so the highlight stops before each formula and resumes after it; a display formula becomes its own block. Text keeps its highlight color and page link, while the formula has neither. The PDF annotation is unchanged.

These cases keep Zotero's plain text:

- A passage split across pages.
- An annotation Mktero cannot place in Markdown.
- An annotation whose text no longer matches its position.

If Zotero's note editor changes in an unrecognized way, insertion falls back to Zotero's behavior without rendered formulas. For `Add Note from Annotations`, Zotero writes the note first; Mktero then saves it once more with formulas for each annotation it could place in Markdown, using the same rules.

#### Side panels and saved layout

While a Mktero tab is selected, Mktero hides Zotero's right-hand item pane, the context pane. It returns when another tab is selected. Zotero does not update it for Mktero tabs, so it would otherwise show the previous tab's paper.

Zotero preferences save which columns are open, their widths, and the selected left segment: `extensions.mktero.readerOutlineVisible`, `readerOutlineWidth`, `readerOutlineSegment`, `readerNotesVisible`, and `readerNotesWidth`. The next Mktero tab uses them. Automatic collapsing in a narrow window is not saved.

### Correct recognition errors

#### Identity and unreadable data

Corrections are tied to the PDF content and the selected source's parser profile; imported results also identify the particular imported snapshot. If saved corrections cannot be read, the original recognition result opens with a warning. The next saved correction or a reparse replaces the unreadable data.

#### Protected content

Prose around formulas and OCR dollar-wrapped citation tokens remains editable, but those tokens are protected. A whole block containing protected content cannot be deleted. In rendered GFM tables, cells with protected content are read-only; other cells remain editable.

Text covered by a matched annotation has the same protection. Delete the annotation before changing that text; edits before or after it remain allowed. Mktero updates the annotation anchor so it still matches after reopening. Restoring a correction is refused if it would change annotated corrected text.

#### Restore or reparse

`Restore all corrections` and reparsing a corrected PDF use an in-reader Mktero confirmation dialog. `Escape`, clicking the backdrop, or the default-focused `Cancel` action leaves the document unchanged. See [conversion](./conversion.md#tabs-cancellation-and-reparsing) for reparsing behavior.
