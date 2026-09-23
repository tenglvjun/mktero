# Limitations

[English](./limitations.md) · [简体中文](./limitations.zh-CN.md) · [Back to README](../README.md)

- The item-list Markdown column appears only after Mktero has confirmed a live
  local cache for that PDF under the current conversion settings. It does not
  scan the library, modify the item, or sync. Clearing the cache, expiry, or a
  different parser profile turns it off. Items converted before the column
  existed stay unmarked until that cache is opened or written again.
- Only local PDF attachments are supported. A scanned PDF may convert through
  OCR but still lacks the text layer needed for precise Zotero highlights.
- Source navigation depends on provider blocks and coordinates; older cached
  results may remain readable without source links. MinerU cloud, local MinerU,
  and Mistral results have independent parser profiles and caches.
- Local MinerU mode talks to a MinerU 4.0 V1 service. It does not restore
  figures from that service's result, and a restarted local service cannot
  resume an earlier job.
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
