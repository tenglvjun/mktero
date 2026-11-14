# Figure pipeline

[English](./figure-pipeline.md) · [简体中文](./figure-pipeline.zh-CN.md) · [Back to README](../README.md)

When the evidence is strong enough, Mktero rebuilds complete figures from the
local PDF at reading resolution (144 DPI and a 1600-pixel long edge, not print
resolution) and replaces OCR fragments in the reading flow. Rasterization runs
in a background worker, keeping the reader and the rest of Zotero responsive.
MinerU supports coordinate-based region restoration; MinerU and Mistral both
support the image-evidence passes described below. When the evidence is weak,
Mktero keeps the provider's original images and text.

## Region restoration

A figure candidate combines provider blocks with exact Markdown ranges. Mktero
crops a complete figure from the local PDF only when the layout evidence, page
coordinates, and Markdown ranges agree. The generated local PNG preserves
`2x2`, `4x4`, missing-cell, spanning, and irregular panel arrangements.

- Interior OCR (labels and text belonging to the figure) leaves the reading flow
  only after a successful crop.
- Captions remain selectable, searchable, and translatable, including publisher
  captions with a dash after the figure number (`Figure 1—A and B: ...`).
  Panel letters and column headings stay inside the figure; the full caption
  appears once below it. Body references to the figure are untouched.
- A local pass upgrades compatible cached results without another OCR upload
  and leaves user corrections intact. It does not rasterize completed figures
  again.
- Ambiguous, rotated, or unverifiable groups retain their original images and
  text.

For a resolved MinerU figure, OCR coordinates can still miss a shared heading or
an outer subplot. Mktero expands the crop to the original PDF image only when
that image is unique, every panel matches its pixels, and its PDF caption
matches. The full caption remains separate. Expansion cannot overlap other
layout content or native PDF text outside the existing region; failed checks
keep the original safe crop. This does not infer relationships between
independent images or extend the recovery to arbitrary vector figures.

### Captions on the following page

For MinerU results, a single figure occupying a full page can be restored even
when its complete caption starts on the immediately following page and there
is no “See next page” notice. The page must contain one complete figure group,
its panel letters must agree with the caption, and the top of the next page
must provide a unique caption whose ownership is unambiguous. The caption
page must contain no other figure, including one farther down the page. Body
text must not intervene or fall inside the crop.

The crop comes from the figure's own PDF page. Panel letters and internal
headings stay in their original positions, while the complete caption remains
separate and appears once. Geometry checks keep the two pages separate, so a
caption's position on the next page cannot overlap a panel on the figure page.
This is a limited recovery rule: multiple possible figures or captions,
conflicting text, or unverifiable geometry leave the original fragments intact.
It does not join arbitrary figures across pages.

### MinerU document rewrite

1. Mktero writes reading Markdown from MinerU's layout. Every figure's image,
   caption, and interior text has an exact Markdown range from the start;
   nothing is matched by text.
2. A composed figure is written back at its first member. Mktero rewrites the
   document from the same layout, keeping its source map exact.
3. Unfinished restoration is not stored in the cache. After a restart, it runs
   again from the stored MinerU result. If that result is gone, the provisional
   document stays readable.

MinerU sometimes files a caption under the wrong float. Two figures stacked on
one page can end up sharing a single float: the upper picture has no caption,
and the lower one carries both its own caption and the caption printed between
the two pictures. Mktero moves a caption onto the adjacent figure of the same
kind that has none, both downward and upward, so each figure is restored with
its own caption. A figure that already has a caption keeps it, and a caption
further from the picture than a printed caption can be stays where MinerU put
it.

## Progressive rendering

Reading starts as soon as conversion finishes. Each pending figure shows an
animated placeholder (a lucide image with a spinner). The reader replaces each
finished figure without rebuilding the article, so a slow figure never delays
the rest.

Ordinary region crops share one page rasterization in the background worker.
Image-boundary and pixel verification may require additional page rendering.
Closing the reader tab does not stop a running restoration; it finishes and
updates the cache. Export and snapshot stay disabled until every figure is
resolved.

## Labeled panels

From a single complete PDF image, both MinerU and Mistral can recover labeled
panels when three kinds of evidence agree: the image bounds, a matching PDF
caption, and every panel's pixels.

Independent OCR label rows such as `(A)`, `(B)`, and their fullwidth equivalents
leave the text only after the complete image is recovered. Body references and
labels inside captions remain intact.

## Unnumbered graphical abstracts

For MinerU results, Mktero can restore an unnumbered graphical abstract when
its panels and embedded text belong to one original PDF image. It verifies
the page coordinates, image boundary, and every panel's pixels before replacing
the fragments. The image keeps its internal title, labels, and explanations in
their original positions; these are not repeated as article paragraphs or
invented figure captions. External article text remains in the reading flow.

The OCR fragments remain visible while this additional verification runs;
the completed document replaces them together. If the image boundary, text
ownership, or pixels cannot be verified, the original fragments remain.
This recovery uses the local PDF and stored MinerU
result, without another OCR upload.

## Reuniting groups split by a misplaced title

Both providers can reunite image groups split by a misplaced title when the PDF
text positions, a shared caption, and every image's pixels verify the
relationship. This includes vector charts.

The title stays searchable above the group. Images return to PDF row order,
and stale layout markers are rebuilt, including for images that span a whole
row.

## Provider support

- **MinerU:** Region restoration uses a `layout.json` page size that matches the
  PDF page. A 90° or 270° rotation swaps width and height, and each dimension
  must agree within 1%. A page that does not match keeps its figures as MinerU
  returned them.
- **Mistral:** Pixel dimensions do not establish the PDF CropBox origin or
  rotation, and that is not independently verified. The production adapter
  therefore does not perform coordinate-based region restoration and preserves
  the original images and OCR text. The image-evidence passes above still apply.
- **Caching:** MinerU and Mistral use independent parser profiles. Their figure
  results are cached separately and are not reused across providers.

## Limits

Figure work has limits on pages, layout blocks, candidate comparisons, crop
pixels, canvas memory, generated bytes, and render time. Anything over budget
is preserved rather than cropped. See [Development](./development.md) for the
figure corpus regression.
