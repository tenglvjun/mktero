# Limitations

[English](./limitations.md) · [简体中文](./limitations.zh-CN.md) · [Back to README](../README.md)

- The item-list Markdown column appears only after Mktero has confirmed a live
  local cache for that PDF under the current conversion settings. A preparing
  spinner is session-only and disappears on shutdown. The column does not
  scan the library, modify the item, or sync. Clearing the cache, expiry, or a
  different parser profile turns the ready mark off. Items converted before the
  column existed stay unmarked until that cache is opened or written again.
  Batch preparation queues every selected PDF after skipping duplicates, and converts three at a time.
- Only local PDF attachments are supported. A scanned PDF may convert through
  OCR but still lacks the text layer needed for precise Zotero highlights.
- The hosted Mktero conversion and MinerU cloud accept at most 200 pages per
  PDF. A longer PDF stops before upload with a message to split it or choose
  another provider. Cached Markdown and corrections still open. The page
  count is read on this computer; when it cannot be read, as with an
  encrypted PDF, the PDF is sent and the service decides. A local MinerU
  service and Mistral are not checked.
- Source navigation depends on provider blocks and coordinates; older cached
  results may remain readable without source links. MinerU cloud, local MinerU,
  and Mistral results have independent parser profiles and caches.
- A footnote mark links to its note only when the note follows it in the same
  section and repeats the mark. A note placed without its mark (for example a
  printed `††` the OCR text does not carry) has no link. Collapsed article
  information, author biography, and reporting summary sections are recognized
  from the page layout and wording, so unusual front matter can stay in the
  reading text.
- MinerU cloud results locate text by OCR block, not by line, so a Markdown
  paragraph jumps to its whole block in the PDF. A paragraph joined across a
  page, column, or figure keeps one location for each part.
- A MinerU paragraph that a page or column break splits at a full stop is
  rejoined only when the PDF has a text layer showing that the line before the
  break is full and the line after it is not indented, in a paper that indents
  its paragraphs. Without a text layer (a scanned PDF), such a paragraph stays
  split. The outline of a paper without section numbers is leveled by heading
  type from the same text layer; when the types do not nest, or the PDF has no
  text layer, those headings stay at one level.
- MinerU's OCR model sometimes writes what it expects instead of what is
  printed. In a typeset PDF whose text layer agrees with MinerU almost
  everywhere, a single differing word is restored to the printed text, so an
  author's own typo or spelling stays as printed, and a heading MinerU wrote
  twice is written once. A scanned PDF's text layer is an older OCR and is
  not used; MinerU's reading stays, including any word it misread.
- Local MinerU mode talks to a MinerU 4.0 V1 service. Its result is read from
  the archive's `middle_json.json` with the same reading rules as MinerU cloud
  (page notes, joined paragraphs and tables, hidden page decoration, source
  links); an archive without a readable `middle_json.json` keeps the service's
  own Markdown. The result is kept with other stored MinerU results, so a
  Mktero update reads it again without the service. It does not restore
  cropped figures from the PDF, and a restarted local service cannot resume an
  earlier job.
- A PDF text selection opens its Markdown paragraph only when one source
  region covers it, or when the selection text occurs in exactly one cached
  paragraph and no source region overlaps it. Ambiguous, repeated, uncached,
  or unscannable text stays in the PDF and does not start a conversion.
  Zotero supplies at most two pages of selection geometry.
- Markdown selections are matched against the PDF's own text layer. A passage
  that extraction mangles beyond the tolerated edit budget, a scanned page
  without a text layer, and a repeated passage that no context can separate
  stay in Markdown as a local annotation and can be retried.
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
- On Windows, copying from the Markdown reader can collide with another
  program that has the clipboard open, and Zotero then keeps the previous
  clipboard content without an error. Mktero reads the clipboard back after
  each copy from the reader and writes the copy again while it is missing. If
  it is still missing after about two seconds, the reader toolbar says so and
  the previous content stays. Ctrl+C pressed while the selection is visible
  but focus is on another part of the window copies the reader's selection
  too. Copying in a text field, a note, or the PDF is unchanged.
- Archives, Markdown, images, source maps, PDF indexes, and KaTeX rendering have
  local resource limits and fail safely when those limits are exceeded. A
  Markdown block that cannot be rendered, such as a list nested hundreds of
  levels deep, is shown as its escaped source text; the rest of the document
  keeps its formatting.
