# Limitations

[English](./limitations.md) · [简体中文](./limitations.zh-CN.md) · [Back to README](../README.md)

This page groups the limits of conversion, reading, annotations, and local data. Format-specific rules and cleanup checks are in [Details](#details).

## PDFs and conversion

- Only local PDF attachments are supported. A scanned PDF may convert through OCR but still lacks the text layer needed for precise Zotero highlights.
- Hosted Mktero conversion and MinerU cloud accept at most 200 pages per PDF. Longer PDFs stop before upload, with a message to split the PDF or choose another provider. Cached Markdown and corrections still open.
- The page count is read on this computer. If it cannot be read, as with an encrypted PDF, the PDF is sent and the service decides. Local MinerU and Mistral are not checked.

## Local llm-for-zotero imports

- Import handles one PDF at a time from its local cache. It requires `full.md` and either a standard content list with valid page numbers and bounding boxes, or a supported layout.
- Plain Markdown, older loose Markdown files, unrestored synced ZIPs, and local MinerU V1 content lists without bounding boxes are unsupported. Compatibility follows the result format, not the plugin version alone.
- Required figures must be available or safely recoverable. Ambiguous crop associations or unsupported page geometry can prevent import. The local PDF limit is 256 MiB; existing document and image resource limits also apply.
- Attachment metadata and cache source records cannot prove an old parse matches the current PDF. The menu detects a local candidate; choosing import validates and copies the result, then opens it. If a parent item has several candidate PDFs, choose the attachment from the submenu.

See [import retention and fallback rules](#local-llm-for-zotero-imports-1) before relying on a saved copy.

## Cache and preparation

- The item-list Markdown column appears only after Mktero confirms a live local cache for the PDF under the current conversion settings or its selected import. It does not scan the library, modify the item, or sync.
- Clearing the cache turns the ready mark off. Changing parser profiles changes the converted cache used; an import selection without readable content is not ready. Items converted before this column existed stay unmarked until that cache is opened or written again.
- A preparing spinner is session-only and disappears on shutdown. Batch preparation skips duplicates, queues every selected PDF, and converts three at a time.
- Orphan cleanup has no extra retention period after confirmed permanent attachment deletion, but it must complete conservative local checks. See [cleanup checks](#cache-and-preparation-1).

## Reading and navigation

- Source links depend on provider blocks and coordinates. Older caches may remain readable without them. MinerU cloud, local MinerU, and Mistral have independent parser profiles and caches.
- MinerU cloud locates text by OCR block, not line. A Markdown paragraph jumps to the whole PDF block; a paragraph joined across a page, column, or figure keeps one location for each part.
- Footnote links, folded article information, paragraph repairs, and heading levels depend on the page layout and text layer. The exact conditions are under [reading details](#reading-and-navigation-1).

## Annotations and notes

- Markdown selections are matched against the PDF's text layer. Badly extracted text beyond the tolerated edit budget, scanned pages without a text layer, and repeated passages that context cannot separate stay as local Markdown annotations and can be retried.
- Mktero displays text highlights and underlines. It does not display standalone note annotations, image/area annotations, or ink annotations.
- `Add to Note` needs a PDF position. It refuses a local highlight not yet in the PDF, or a selection the local PDF index cannot locate or distinguish, and explains why. Mktero does not insert it without a source.
- A citation in a note opens Zotero's PDF reader. A standalone PDF without a parent item has no child notes.
- The editor inside a Mktero tab is Zotero's note editor. If it cannot be shown there, the note opens in Zotero's note window.

Formula handling in notes is described under [annotation and note details](#annotations-and-notes-1).

## Corrections

Correction mode edits or removes only existing Markdown blocks:

- Prose around formulas and MinerU dollar-wrapped citation tokens is editable.
- Those tokens and annotated text are protected; their blocks cannot be deleted. Delete an annotation before changing its text.
- Document structure, images, and raw HTML remain protected.

## Translation

- AI translation is an optional cached reading layer. It does not modify source Markdown or get included in snapshots.
- Selection translation is a separate, on-demand reading aid, available only from source text in Markdown reading views. It is not cached and may incur AI provider usage costs.

## Copy and clipboard

On Windows, another program may have the clipboard open when you copy from the Markdown reader. Zotero then keeps the previous content without an error. Mktero reads back the clipboard after each reader copy and retries while the copy is missing. If it is still missing after about two seconds, the toolbar says so and the previous content stays.

Ctrl+C also copies the reader's visible selection when focus is elsewhere in the window. Copying in a text field, a note, or the PDF is unchanged.

## Resource limits

- Markdown images are limited to supported GIF, JPEG, PNG, and WebP files from the current result archive. Remote images are blocked.
- Links allow only `http`, `https`, `zotero`, and document fragments.
- Archives, Markdown, images, source maps, PDF indexes, and KaTeX rendering have local resource limits and fail safely when exceeded.
- A Markdown block that cannot be rendered, such as a list nested hundreds of levels deep, appears as escaped source text. The rest of the document keeps its formatting.

## Details

### PDFs and conversion

Local MinerU mode connects to a MinerU 4.0 V1 service. It reads `middle_json.json` from the archive with the same reading rules as MinerU cloud: page notes, joined paragraphs and tables, hidden page decoration, and source links. Without a readable `middle_json.json`, the result keeps the service's own Markdown.

The result is kept with other stored MinerU results, so a Mktero update can read it again without the service. Local MinerU does not restore cropped figures from the PDF. A restarted local service cannot resume an earlier job.

### Local llm-for-zotero imports

Imported copies use Mktero's local cache. They are subject to manual clearing, [orphan cleanup](./conversion.md#local-cache-cleanup) after permanent attachment deletion, self-healing of damaged entries, and profile filesystem availability. Individual archive and document resource limits still apply.

- Deleting only the llm-for-zotero source does not affect a retained Mktero copy. A retained raw result can rebuild the document offline; keep the original result if you need to import it again.
- If all local content for the selected import is missing, a later ordinary `Read as Markdown with Mktero` uses the current converter and may upload the PDF.
- Import failure, corrupt content, read errors, or cancellation do not trigger conversion. The import action itself stays local.
- An explicit reparse also uses the current service and may upload the PDF.
- Source recognition and display errors can remain in imported text.

### Cache and preparation

Cleanup checks use these limits:

| Check | Limit or behaviour |
| --- | --- |
| Library enumeration | At most 50,000 items |
| Verification batch | At most 100 items, or yield once cumulative PDF reads reach 32 MiB |
| Continuation | Resume from the saved position after 250 ms, without restarting |
| Single PDF | May take a batch above 32 MiB, but cannot exceed 256 MiB |
| Different-size PDFs | No hashing needed |

Trash and valid shared references protect data. Only use of the affected attachment or cache postpones its cleanup; unrelated reading does not block it. Inaccessible libraries, incomplete scans, unknown ownership or uncertain shared references retain the affected data; failed deletions are retried.

Enumeration continues past missing or unreadable PDFs. Uncertainty affects only candidates that verified local file information cannot rule out:

- A completely missing PDF does not pin unrelated caches. Its derived Markdown, raw conversion results and PDF text index are released because conversion can rebuild them; corrections and reading positions cannot be rebuilt and are kept.
- A file that exists but cannot be verified, a PDF that changes during checking, or an incomplete scan retains everything. An old synchronized MD5 or historical owner hash cannot safely exclude anything.

Settings explain the reason, show released counts, list released and unidentified items and missing local PDFs, and offer `Check again`. Cleanup timing depends on completing these checks, not just the short notification delay. Recorded permanent deletions follow the same policy; historical data with unknown ownership remains on disk.

### Reading and navigation

Footnotes and article information:

- A footnote mark links to its note only if the note follows it in the same section and repeats the mark. A note without its mark, such as a printed `††` missing from OCR text, has no link.
- Collapsed article information, author biography, and reporting summary sections are recognized by layout and wording. Unusual front matter can stay in the reading text.
- Publisher-cover cleanup requires multiple distinct platform controls, citation/link metadata, and a matching title followed by an abstract or introduction on the next page. Ambiguous pages and images without a clear control association stay visible; small size alone never identifies decoration.

Paragraphs and headings:

- A MinerU paragraph split at a full stop by a page or column break is rejoined only if the PDF text layer shows a full line before the break and no indentation after it, in a paper that indents paragraphs. Without a text layer, as in a scanned PDF, it stays split.
- An unnumbered outline uses heading types from that same text layer. If the types do not nest, or there is no text layer, the headings stay at one level.
- MinerU's OCR sometimes writes what it expects instead of what is printed. In a typeset PDF whose text layer agrees with MinerU almost everywhere, a single differing word is restored to the printed text, preserving the author's typo or spelling; a heading MinerU wrote twice appears once.
- A scanned PDF's text layer is older OCR and is not used for that repair. MinerU's reading stays, including misread words.

Opening Markdown from a PDF selection:

- One source region must cover the selection, or its text must occur in exactly one cached paragraph with no source region overlapping the selection.
- Ambiguous, repeated, uncached, or unscannable text stays in the PDF and does not start conversion.
- Zotero supplies at most two pages of selection geometry.

### Annotations and notes

A formula inserted with `Add to Note` sits outside the adjacent highlight. It has no highlight color or link back to the page.

These cases keep Zotero's plain text:

- A passage split across pages.
- A formula in a table the paper carries as HTML.
- An annotation Mktero cannot place in the Markdown.

A `$$…$$` inside a table cell is not typeset in the reader and is copied as written.
