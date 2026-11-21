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
- A numbered caption between two panel rows keeps those figures separate.
  Panels of the same figure retain their PDF arrangement, including rows of
  unequal-width charts and groups spread over several rows.
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
matches. A merged group is still provisional until that check passes; if it
fails, the original fragments stay in place. The full caption remains separate.
Expansion cannot overlap other layout content or native PDF text outside the
existing region; failed checks
keep the original safe crop. This does not infer relationships between
independent images or extend the recovery to arbitrary vector figures.

### Captioned grids and misfiled legends

A multi-row figure is often printed as independently detected subplots that
share one legend. Before a native caption can change any ownership, Mktero
builds whole picture components from the PDF geometry: projection overlap plus
the panel gap budget, closed by a printed legend, body text, or another picture.
Subplot letters may be listed individually (`(a)`, `(b)`) or as a range
(`(a–f)`, `(a–i)`, also written with `to`). When the letters and the component
agree, the legend stays with the complete component and the group takes the
ordinary region path, so a composite figure does not have to be one native PDF
image. An OCR image may already contain multiple lettered subfigures, or the
same logical panel may be split between OCR images; image count is not a panel
count. The printed caption is reconciled with the complete OCR caption before
it is emitted once for the whole group.

The OCR pictures are fragments, not logical panels: one picture can already
hold several lettered subfigures, and one subfigure can be split across several
pictures. The letter count therefore never has to equal the component's picture
count; the letters have to describe the same printed figure the component
covers. A complete legend anchored on any one fragment of a closed component
belongs to the whole component, so a second fragment of the same row is not
left behind as an uncaptioned figure.

A panel letter already attached to its own subplot may sit just above or
outside the tight image box. When the complete shared caption agrees with the
PDF text, the picture component is closed, and a bounded position check gives
the letter one owner, Mktero keeps it in the crop at its original position.
Raster letters need no separate PDF text item for this check. Moving a letter
to another subplot still requires native text evidence. A conflicting letter
or owner keeps the component intact; a fallback cannot repair only part of it.

A chart footer reported as a caption (an axis note printed inside the plot) is
not a legend. Mktero confirms it against the PDF's own text at that place and
keeps it as figure text: it leaves the reading flow only after a successful
crop, and it never blocks the picture's real numbered legend. Two axis titles
printed side by side share one PDF baseline, so each is matched against the
native runs at its own box rather than against the whole printed row. A misfiled legend
whose destination or component is not unique retains its original ownership
and fragments; dependent figures are not repaired in separate partial steps.

A short figure title may be filed as an original footnote of another float,
including the table above it. The PDF text layer can split a word into touching
glyph runs, so native verification joins those runs while preserving real word
spacing and checks the title's complete text at its printed location. Only an
original float footnote with that text agreement, a complete shared caption,
and one unobstructed picture owner in the closed component can move into figure
text. Its own position extends the ordinary region crop, including for vector
charts. Original fragments and their source remain traceable, and the title
leaves the reading flow only after a successful crop; a failed crop keeps it
visible. Explicit footnote markers or note prefixes, notes continuing directly
from their float body, and consecutive original footnote rows retain their
source float even when the last row is close to a picture. Ordinary prose,
multiple owners, and conflicting content also retain their original placement.

Mixing a table with a chart still requires one native PDF image and verified
panel pixels, as described below.

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

### Captions from the PDF text layer

MinerU can lose a figure number, print the number and its legend as separate
paragraphs, or file the number under the float below it. For MinerU results,
Mktero reads the PDF's own text layer to restore those captions before the
reading document is written. It accepts captions written on one line or wrapped
across lines, with or without a trailing period, and captions aligned with the
outer frame rather than centred over the picture.

On a two-column page, caption lines and body lines in the neighbouring column
can share a baseline even when the gutter is narrow. Layout bounds of independent
paragraphs or a complete numbered OCR caption split native lines into separate
text runs. Each run uses its own character height and baseline when reading the
caption and its continuation, so larger type in the adjacent column cannot change
those measurements. The same boundaries also separate columns set in the same
font size. A complete numbered OCR caption can provide the boundary even when no
independent body paragraph box is available.

This prevents native recovery from mixing neighbouring body text into an already
correct legend and inventing a second, truncated caption with the same number on
an uncaptioned fragment. When two stacked OCR images share a complete legend
stored only on the lower fragment, the shared-caption grouping checks can then
keep them in one figure with one complete caption. Adjacent body text stays in
the reading flow. Split runs still count towards reading budgets; missing or
conflicting layout evidence does not justify consuming body text or forcing a
merge.

A complete caption can also be misclassified as a separate body paragraph
above, below, or on either side of a figure on the same page. Mktero checks
native PDF text inside that paragraph's region before assigning it to a single
figure. Regional reading avoids mixing the caption with nearby plot labels
and is independent of the whole-page discovery pass's eight-line window; item,
line, character, and comparison limits still apply. Only complete text agreement
and a unique, unobstructed owner allow the original OCR content, including its
formula and link spans, to move into the caption. The source paragraph is then
consumed once, so the full caption is not repeated in the body. Body references,
incomplete readings, conflicting owners, and exhausted budgets leave the
original paragraph intact.

When OCR already identifies the region's opening caption keyword, verification
can normalize letter spacing in that keyword in the PDF text layer, such as
`F I G U R E` → `FIGURE`. Only that opening keyword receives this normalization;
the figure number, description order, and repeated words must still agree under
the existing text comparison rules. The complete region must verify and have a
unique, unobstructed owner before its original OCR content moves into the caption.

A picture can also carry lettered panel descriptions such as `(D) Identify a
context` in place of its real caption. If a complete body-block legend names
those panels and has one owner, Mktero proposes a native-image recovery without
changing the OCR text. One unique PDF image must contain every panel description,
the OCR image pixels must match, and the full external legend must verify. Small
OCR box errors at the image edge are included only after that containment check;
the final crop must remain clear of other content and native article text. A
successful recovery preserves the descriptions inside the image and emits the
complete selectable caption once, restoring its figure navigation entry. Any
failed check leaves the original image, descriptions and paragraph in place.

- The printed number and legend are kept as they appear in the PDF. Mktero does
  not exchange two captions because a picture looks like a different chart.
- Full-width, multi-line legends are not treated as prose merely because they
  fill the text column. A complete OCR legend stays intact when the native
  reading is shorter or reaches its line budget; it never gains a second,
  truncated copy on another panel. When the native reading ends at a line-final
  hyphen inside a word or compound, a same-number OCR caption at the same
  printed location that continues that ordered prefix stays intact. Intact
  chart groups use ordinary region restoration, including when the PDF charts
  are vector drawings.
- A caption moves to another figure only when the PDF text locates it once,
  the figure it should belong to has no caption of its own, and no body text or
  other figure stands between them. Ambiguous ownership keeps MinerU's
  placement.
- Spacing inside brackets is ignored when comparing the PDF caption with the
  OCR copy, so `( A )` and `(A)` name the same legend. Caption comparison keeps
  word order and repeated words while normalizing line breaks, ligatures,
  hyphenation and equivalent mathematical text such as TeX commands and PDF
  glyphs. The printed figure number must still agree; similar wording cannot
  exchange different figures.
- When OCR files the upper figure's legend under a row of lettered panels and
  files one of those panel letters under the upper figure, Mktero plans both
  moves together. This requires an explicit shared legend such as `(a)` and
  `(b)`, a unique destination for every displaced caption, and a unique
  geometric owner for each relocated panel letter. Missing evidence skips
  this joint repair.
- Text that merely mentions a figure inside a sentence is not a caption, and a
  real table heading is never taken from a table. Whole-page discovery does not
  read a numbered sentence in the body's own type as a native legend without
  separate caption evidence, even when it begins with the printed figure number.
- A legend longer than the whole-page pass's eight-line read budget keeps the
  complete OCR copy; the bounded native read never truncates it to its first
  line. An independently verified paragraph region uses the regional limits
  described above.
- Without a PDF text layer the earlier OCR-only rules still apply, including the
  same-page float repair described below.

### Splitting a figure MinerU stored as a table

MinerU sometimes splits one printed figure into several chart and table
fragments. A unique, complete shared Figure caption can propose a mixed group,
including when OCR stored the caption in the final fragment's image description
or attached a panel letter to the wrong fragment. The number of OCR fragments
need not equal the number of logical panels. A same-number OCR caption at the
same location can corroborate native continuation lines set in the body's own
font size; lines inside an article paragraph still end the caption.

The proposal keeps the original Markdown until verification succeeds. One
unique native PDF image must anchor the group, every fragment must match the
rendered page pixels, and the complete caption must match the PDF text at its
own location. The crop keeps the union of that image and all original panel
bounds so vector curves, axes and panel letters outside the bitmap survive.
Expansion remains bounded and cannot cover another layout block, the caption
or selectable article text. The verified page crop replaces all fragments
together and the caption stays selectable below it.

If any check fails, the tables keep their original HTML or image fallback and
the charts keep their images.
A table with its own table heading is never converted into a figure, and the
recovery does not merge independent figures that merely sit next to each other.
An already resolved chart group takes precedence over a mixed proposal, even
when an uncaptioned table sits beside it.

### MinerU document rewrite

1. Mktero writes reading Markdown from MinerU's layout. Every figure's image,
   caption, and interior text has an exact Markdown range from the start;
   nothing is matched by text.
2. A composed figure is written back at its first member. Mktero rewrites the
   document from the same layout, keeping its source map exact.
3. Unfinished restoration is not stored in the cache. After a restart, it runs
   again from the stored MinerU result. If that result is gone, the provisional
   document stays readable. A change to these caption rules is a parser-profile
   change, so a cached document can be rebuilt offline when that stored result
   is available, without another OCR upload.

MinerU sometimes files a caption under the wrong float. Two figures stacked on
one page can end up sharing a single float: the upper picture has no caption,
and the lower one carries both its own caption and the caption printed between
the two pictures. Mktero moves a caption onto the adjacent figure of the same
kind that has none, both downward and upward, so each figure is restored with
its own caption. A figure that already has a caption keeps it, and a caption
further from the picture than a printed caption can be stays where MinerU put
it. This is the fallback used when the PDF text layer provides no evidence of
its own.

A caption is moved only when the evidence agrees: the same-page float that
wrongly carries it has a separate caption of another class and keeps its own
separate caption, the receiving float is of the same class as the moved caption
and has no caption at all, and the geometry is sufficient with no body text
between them. Anything still uncertain keeps MinerU's original ownership. The
rule does not split a caption away from body text that refers to a table, does
not split table panels that belong inside a figure, and does not stop an
image-compatible figure that MinerU labelled a table. A table that also has its
own separate table heading keeps its HTML when another figure's heading was
filed under it. This repairs only the relationships that evidence supports; it
is not a promise that any particular wrong caption is corrected.

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
