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

### Read several papers with one research note

A research note is an ordinary standalone Zotero note that you choose as the target for passages from several papers. Each library has its own choice.

When no research note is set, the `Notes` column explains how to use one across papers and offers `Create research note` and `Choose existing note`.

1. Choose `Create research note` to create an ordinary standalone Zotero note in the same library, titled `Research note` by default. Once saved, it is pinned and opened in Zotero's native note editor, where you can change its title.
2. Choose `Choose existing note` to enter a selection mode for standalone notes in the same library. Click an editable note to pin and open it, or cancel.
3. Click the pinned title in the research-note strip to continue editing. The same target appears in other Mktero reading tabs for that library. You can also choose `Add to Note` on an original-text selection or an annotation to open that target and insert the passage. Check the target title shown by the action before adding it.
4. Write your question, critique, or connection beside the inserted passage in Zotero's note editor. The citation and page link let you return to the PDF source.
5. After restarting Zotero, open a paper in that library to continue with the saved research-note target. The editor opens when you choose to continue or add a passage; restoring the target does not restore reading tabs.

You can still set an editable standalone note as the research note using its card's pin button, the right-click action `Set as Research Note`, or the pin button above its open editor. Pinning from a card keeps the list open and does not open the editor.

Opening a different note changes the target in that reading tab only. It does not replace the pinned research note; click the pinned title in the research-note strip when you want to return to it. To change the pinned target, choose `Change research note` in the strip to enter the same selection mode, or return to `Standalone notes` and click another note's card pin. Cancelling selection keeps the current target. Click the selected card's pin again, or use `Unpin Research Note` in the strip, to clear the choice and keep the note and its contents. If the destination changes while an Add to Note popup is open, that old action is refused; close the popup and select the content again.

A deleted note, a note moved under a paper, or a note that is no longer editable cannot receive passages as the research-note target. Mktero shows the reason so you can restore access, choose another note, or clear the choice; it does not silently write to another note.

### Reread the excerpts behind a research question

1. In the pinned research note strip, click `Reread Excerpts`. Text selections, highlights, and underlines with a saved PDF position appear with their paper and page. Use the page button to reopen the original PDF.
2. Select the passages you want to compare. Use `Selected Excerpts` to look at them together, then click `Record in Note`. Mktero appends a record with the selected excerpts and their sources to the ordinary Zotero note.
3. Write your question and your reasoning in the native editor. Use Zotero’s `Show on Page` on an excerpt to return to its exact source later.

The list uses the current pinned note. A missing PDF is marked unavailable. A read-only note can still be reviewed. The record is stored by Zotero and the workflow runs offline.

### Add passages and annotations to a note

Open a note in the `Notes` column, including a standalone note if that is your target, or use the pinned research note. Then choose `Add to Note` from a text-selection popup, an annotation popup, or an item in the `Annotations` segment. The action identifies the actual target note; if another note is already open, it receives the passage.

The passage is inserted the same way as in Zotero's PDF reader: highlighted text, a citation, and the page. Clicking that citation opens Zotero's PDF reader. Adding an ordinary selection does not save a highlight.

After a successful `Add to Note`, a dismissible prompt appears outside the editor: `Excerpt added. You can now write your questions, critiques or connections.` Simply selecting text does not show it.

You can expand the initially collapsed thinking prompts for four starting points:

- What assumptions are implicit here?
- Would the result still hold with a different method or control?
- Which paper does this remind me of, and why?
- What do I still not understand or agree with?

Continue writing directly in Zotero's native note editor; there is no extra input box, template, category, or AI step. The success message and these static questions stay out of the note's content. Expanding or collapsing them does not edit the note.

Adding another passage in the same open editor preserves your expanded or collapsed choice. Dismissing the whole prompt clears that choice; the next successful `Add to Note` shows it collapsed again. Closing or switching the note editor also clears the state. You can collapse or dismiss the prompt at any time and continue reading or writing.

Insertion needs an editable target note and a PDF position. With a valid pinned research note, Mktero opens its editor on demand before inserting. A local highlight not yet in the PDF, or a selection the local PDF index cannot locate (not found or ambiguous), is refused with the reason; Mktero does not insert it without a source.

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

A drag that starts in a figure caption stays within that caption while the pointer remains there or over its image. Dragging into other selectable text releases that boundary. The selection toolbar keeps the selected text and source ranges together when saving a highlight or comment.

A selection split into more than 512 separate parts is refused with a message rather than saved incompletely. When a highlight overlaps a citation, table reference, or figure reference, that reference keeps interaction priority. Annotation actions remain available from surrounding highlighted text or its comment marker.

Common MinerU LaTeX math symbols and simple subscripts are normalized to the PDF's extracted text. Matching tolerates a few characters mangled by the PDF text layer, so selections containing formulas can still be located. A display formula whose LaTeX does not survive extraction falls back to that block's recorded OCR region.

When loading a PDF annotation back into Markdown, Mktero handles line-end hyphens that either join a split word or remain part of a compound word, including both forms in one annotation. Each complete candidate must retain ordinary word boundaries and unwrapped lexical hyphens; conflicting candidates stay ambiguous. Its PDF position and surrounding text help distinguish repeated passages. If a page header or a different PDF reading order prevents one side from matching anywhere, a unique match on the other side is enough. Conflicting contexts or multiple remaining matches stay marked as ambiguous.

Cross-page matching can leave out repeated notices at the physical top or bottom of a page when their visual position and separation from the body confirm that they are page furniture. This also covers long notices whose PDF text fragments arrive out of order. Body text, unique edge text, and uncertain lines remain part of the search; an ambiguous selection is still refused.

When the PDF character stream differs from the two-column reading order, Mktero can try a derived reading order when clear column, running-header, or floating-figure evidence supports it, then map the match back to the original characters and coordinates. A caption in the body font can also use an independent caption map bound to the current PDF and Markdown, after its complete text, unique match, full region, and separation from the body have been verified. OCR text that omits body passages is not treated as one continuous selection, and a figure number alone does not justify skipping ordinary prose. A floating block without enough evidence can still prevent cross-page matching; select each page separately, or choose the exact location in Zotero's PDF reader.

A cross-page selection becomes one single-page Zotero highlight per page, keeping the whole Markdown selection navigable. A paragraph that resumes a page or two later is located the same way, across a full-page figure or running footer in between.

#### Groups for cross-page and disjoint highlights

Changing one part's color, or deleting it from Markdown, affects every part Mktero created for that selection. A comment stays on the part where it was written.

A translated selection can produce several Zotero highlights when the original passages are disjoint, even on the same PDF page. Mktero displays the group as one annotation in the reader.

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

Zotero's native sidebar shows the current paper's context in a Mktero tab. The native sidebar and Mktero's `Notes` column share the right side; their content is mutually exclusive:

- Opening the native sidebar temporarily hides Mktero's Notes while keeping its editor open.
- Closing the native sidebar restores your previous Notes choice. If Notes was closed, it stays closed; both panels can remain closed.
- Explicitly opening Mktero's Notes closes the native sidebar first.

Focus mode and tab switching suspend panel display independently of these choices. Temporary hiding for the native sidebar, focus mode, tab switching, or a narrow window does not change the saved Notes preference.

The native notes panel currently browses notes at library level in Mktero. Use Mktero's `Notes` for the current paper's note interactions, because Zotero's corresponding native actions depend on its PDF Reader. These remain ordinary Zotero notes edited with Zotero's native editor.

Third-party plugin features that depend on a real Zotero Reader or a PDF selection do not automatically work in Mktero. Having the native sidebar available does not guarantee compatibility with every plugin.

Zotero preferences save your chosen Mktero column visibility, widths, and selected left segment: `extensions.mktero.readerOutlineVisible`, `readerOutlineWidth`, `readerOutlineSegment`, `readerNotesVisible`, and `readerNotesWidth`. The next Mktero tab uses them; temporary automatic layout changes are not saved.

The separate `extensions.mktero.researchNoteTargets` preference stores a note key for each library ID. It keeps no note title or content, is unencrypted in the local profile, and is neither sent nor synced by Mktero. Research-note contents remain in Zotero note items and sync according to Zotero settings. Clearing the research-note choice removes that library's reference without deleting the note.

### Correct recognition errors

#### Identity and unreadable data

Corrections are tied to the PDF content and the selected source's parser profile; imported results also identify the particular imported snapshot. If saved corrections cannot be read, the original recognition result opens with a warning. The next saved correction or a reparse replaces the unreadable data.

#### Protected content

Prose around formulas and OCR dollar-wrapped citation tokens remains editable, but those tokens are protected. A whole block containing protected content cannot be deleted. In rendered GFM tables, cells with protected content are read-only; other cells remain editable.

Text covered by a matched annotation has the same protection. Delete the annotation before changing that text; edits before or after it remain allowed. Mktero updates the annotation anchor so it still matches after reopening. Restoring a correction is refused if it would change annotated corrected text.

#### Restore or reparse

`Restore all corrections` and reparsing a corrected PDF use an in-reader Mktero confirmation dialog. `Escape`, clicking the backdrop, or the default-focused `Cancel` action leaves the document unchanged. See [conversion](./conversion.md#tabs-cancellation-and-reparsing) for reparsing behavior.
