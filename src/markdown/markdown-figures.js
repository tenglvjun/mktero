import { parseGFMTableRow } from './markdown-tables.js';

const ACADEMIC_REFERENCE_SPACE_SOURCE = '[\\p{Zs}\\t]';
const ACADEMIC_REFERENCE_IDENTIFIER_SOURCE =
    '(?:s?\\d+[a-z]?|[ivxlcdm]+[a-z]?)';
const ACADEMIC_FIGURE_CAPTION_SEPARATOR_SOURCE =
    '(?:[.:：。]|[\\p{Zs}\\t]*[|｜])';
const ACADEMIC_FIGURE_CAPTION_PATTERNS = [
    new RegExp(
        `^((?:(?:algorithm|chart|fig\\.?|figure|scheme|table)`
            + `${ACADEMIC_REFERENCE_SPACE_SOURCE}+`
            + `${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE}`
            + `${ACADEMIC_FIGURE_CAPTION_SEPARATOR_SOURCE}`
            + `|fig[.．]${ACADEMIC_REFERENCE_SPACE_SOURCE}+`
            + `${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE}[.:：。]?))`
            + `${ACADEMIC_REFERENCE_SPACE_SOURCE}+(\\S[\\s\\S]*)$`,
        'iu'
    ),
    new RegExp(
        `^((?:图表|图)${ACADEMIC_REFERENCE_SPACE_SOURCE}*`
            + `${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE}[.:：。])`
            + `${ACADEMIC_REFERENCE_SPACE_SOURCE}*(\\S[\\s\\S]*)$`,
        'iu'
    ),
    new RegExp(
        `^((?:fig[.．]${ACADEMIC_REFERENCE_SPACE_SOURCE}*`
            + `${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE}[.:：。]?))`
            + `${ACADEMIC_REFERENCE_SPACE_SOURCE}*(\\S[\\s\\S]*)$`,
        'iu'
    ),
    new RegExp(
        `^((?:图表|图)${ACADEMIC_REFERENCE_SPACE_SOURCE}*`
            + `${ACADEMIC_REFERENCE_IDENTIFIER_SOURCE})`
            + `${ACADEMIC_REFERENCE_SPACE_SOURCE}+(\\S[\\s\\S]*)$`,
        'iu'
    ),
];
const ACADEMIC_TABLE_CAPTION_PATTERN = /^(table[ \t]+(?:s?\d+[a-z]?|[ivxlcdm]+[a-z]?))([.:])?[ \t]+(\S[\s\S]*)$/iu;
const ACADEMIC_TABLE_HEADING_PATTERN = /^ {0,3}#{1,6}[ \t]+(table[ \t]+(?:s?\d+[a-z]?|[ivxlcdm]+[a-z]?))([.:])?(?:[ \t]+#+)?[ \t]*$/iu;
const ACADEMIC_TABLE_PLAIN_HEADING_PATTERN = /^ {0,3}(table[ \t]+(?:s?\d+[a-z]?|[ivxlcdm]+[a-z]?))([.:])?[ \t]*$/iu;
const EMPTY_IMAGE_LINE_PATTERN = /^( {0,3})!\[[ \t]*\](\([^\r\n]+\))[ \t]*(?:\r?\n)?$/;
const MARKDOWN_IMAGE_LINE_PATTERN = /^ {0,3}!\[[^\]\r\n]*\]\([^\r\n]+\)[ \t]*(?:\r?\n)?$/;
const CAPTIONED_IMAGE_LINE_PATTERN = /^ {0,3}!\[((?:\\.|[^\]\\])*)\]\([^\r\n]+\)[ \t]*(?:\r?\n)?$/;
const RAW_HTML_TABLE_START_PATTERN = /^ {0,3}<table(?:\s|>)/i;
const RAW_HTML_TABLE_END_PATTERN = /<\/table>[ \t]*$/i;
const BLANK_LINE_PATTERN = /^[ \t]*(?:\r?\n)?$/;
const MARKDOWN_HARD_BREAK_PATTERN = /[ \t]{2,}(?:\r?\n)?$/;
// Both markers are Markdown hard breaks; the extra space records vertical layout.
const MINERU_VERTICAL_PANEL_MARKER_SPACES = 3;
const MAX_PANEL_LABEL_LENGTH = 80;
const FIGURE_LAYOUT_MARKER_PATTERN = /^<!--\s*(?:mktero-figure-layout|mktero-mistral-figure-grid):\s*columns=(\d{1,2})\s+rows=([\d,]{1,80})(?:\s+spans=([\d,]{1,256}))?\s*-->$/iu;

export function parseFigureLayoutMarker(value) {
    const source = String(value || '').replace(/\r?\n$/, '').trim();
    const match = FIGURE_LAYOUT_MARKER_PATTERN.exec(source);
    if (!match) return null;
    const columns = Number(match[1]);
    const rows = match[2].split(',').map(Number);
    const imageCount = rows.reduce((sum, row) => sum + row, 0);
    const spans = match[3] ? match[3].split(',').map(Number) : null;
    const spansFitRows = spans
        ? rows.every((rowCount, rowIndex) => {
            const offset = rows
                .slice(0, rowIndex)
                .reduce((sum, count) => sum + count, 0);
            const usedColumns = spans
                .slice(offset, offset + rowCount)
                .reduce((sum, span) => sum + span, 0);
            return usedColumns <= columns;
        })
        : true;
    if (!Number.isInteger(columns)
        || columns < 1
        || columns > 16
        || !rows.length
        || rows.some(row => !Number.isInteger(row) || row < 1 || row > 16)
        || rows.length > 16
        || imageCount > 256
        || (spans
            && (spans.length !== imageCount
                || spans.some(span => (
                    !Number.isInteger(span) || span < 1 || span > columns
                ))
                || !spansFitRows))) {
        return null;
    }
    return { columns, rows, spans };
}

// Kept as an API alias for cached Mistral Markdown and existing integrations.
export const parseMistralFigureGridMarker = parseFigureLayoutMarker;

export function parseAcademicFigureCaption(value) {
    const text = String(value || '').trim();
    const match = ACADEMIC_FIGURE_CAPTION_PATTERNS
        .map(pattern => pattern.exec(text))
        .find(Boolean);
    if (!match) return null;
    return {
        text,
        label: match[1],
        description: match[2],
    };
}

export function parseAcademicTableCaption(value) {
    const text = String(value || '').trim();
    const match = ACADEMIC_TABLE_CAPTION_PATTERN.exec(text);
    if (!match) return null;
    return {
        text,
        label: match[1] + (match[2] || ''),
        description: match[3],
    };
}

export function normalizeMarkdownFigureCaptions(markdown) {
    const lines = String(markdown).match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const output = [];
    let activeFence = null;

    for (let index = 0; index < lines.length; index++) {
        const fence = markdownFence(lines[index]);
        if (activeFence) {
            output.push(lines[index]);
            if (fence
                && fence.character === activeFence.character
                && fence.length >= activeFence.length
                && !fence.trailing.trim()) {
                activeFence = null;
            }
            continue;
        }
        if (fence) {
            activeFence = fence;
            output.push(lines[index]);
            continue;
        }

        const precedingCaption = isIndentedCodeLine(lines[index])
            ? null
            : parseCaptionLine(lines[index]);
        if (precedingCaption) {
            let imageIndex = index + 1;
            if (BLANK_LINE_PATTERN.test(lines[imageIndex] || '')) {
                imageIndex++;
            }
            const imageLine = lines[imageIndex];
            const image = EMPTY_IMAGE_LINE_PATTERN.exec(imageLine || '');
            if (image && !nextNearbyLineIsImage(lines, imageIndex)) {
                output.push(formatCaptionedImage(
                    image,
                    precedingCaption.text,
                    lineEnding(imageLine)
                ));
                index = imageIndex;
                continue;
            }
        }

        const image = EMPTY_IMAGE_LINE_PATTERN.exec(lines[index]);
        if (!image || previousNearbyLineIsImage(lines, index)) {
            output.push(lines[index]);
            continue;
        }

        let captionIndex = index + 1;
        if (BLANK_LINE_PATTERN.test(lines[captionIndex] || '')) {
            captionIndex++;
        }
        const captionLine = lines[captionIndex];
        if (captionLine === undefined) {
            output.push(lines[index]);
            continue;
        }
        const captionEnding = lineEnding(captionLine);
        const caption = parseCaptionLine(captionLine);
        if (!caption) {
            output.push(lines[index]);
            continue;
        }

        output.push(formatCaptionedImage(image, caption.text, captionEnding));
        index = captionIndex;
    }

    return output.join('');
}

export function findAcademicFigureGroups(markdown) {
    const source = String(markdown || '');
    const lines = markdownLineRecords(source);
    const blockedLines = findBlockedLines(lines);
    const reassignedCaptionsByImage = new Map(
        findMisassignedTableFigureCaptions(lines, blockedLines)
            .map(group => [group.imageIndex, group])
    );
    const groups = [];

    for (let index = 0; index < lines.length; index++) {
        if (blockedLines.has(index)) continue;

        const gridMarker = parseFigureLayoutMarker(lines[index].raw);
        if (gridMarker) {
            let imageStart = nextNonBlankLine(lines, index + 1);
            const leadingCaption = imageStart < lines.length
                && !blockedLines.has(imageStart)
                ? parseCaptionLine(lines[imageStart].raw)
                : null;
            if (leadingCaption) {
                imageStart = nextNonBlankLine(lines, imageStart + 1);
            }
            const images = collectNearbyImages(lines, imageStart, blockedLines);
            const captionIndex = nextNonBlankLine(
                lines,
                (images.at(-1)?.index ?? lines.length - 1) + 1
            );
            const trailingCaption = captionIndex < lines.length
                && !blockedLines.has(captionIndex)
                ? parseCaptionLine(lines[captionIndex].raw)
                : null;
            const embeddedCaption = images.length
                ? captionFromImageLine(lines[images.at(-1).index].raw)
                : null;
            const caption = leadingCaption || trailingCaption || embeddedCaption;
            const imageCount = images.length;
            if (caption
                && imageCount === gridMarker.rows.reduce((sum, row) => sum + row, 0)
                && gridMarker.columns === Math.max(...gridMarker.rows)
                && imageCount > 1) {
                const layout = gridMarker.columns === 1
                    ? 'vertical'
                    : gridMarker.rows.length === 1
                        ? 'horizontal'
                        : 'grid';
                groups.push({
                    from: lines[index].from,
                    to: lines[trailingCaption ? captionIndex : images.at(-1).index].to,
                    caption,
                    images,
                    layout,
                    gridColumns: gridMarker.columns,
                    gridRows: gridMarker.rows,
                    ...(gridMarker.spans ? { gridSpans: gridMarker.spans } : {}),
                });
                index = trailingCaption
                    ? captionIndex
                    : images.at(-1).index;
                continue;
            }
        }

        const reassigned = reassignedCaptionsByImage.get(index);
        if (reassigned) {
            groups.push({
                from: lines[index].from,
                to: lines[reassigned.figureCaptionIndex].to,
                caption: reassigned.figureCaption,
                images: [{
                    index,
                    source: lines[index].text.trim(),
                }],
                renderSource: replaceImageDescription(
                    lines[index].text.trim(),
                    reassigned.figureCaption.text
                ),
            });
            index = reassigned.figureCaptionIndex;
            continue;
        }

        const verticalGroup = leadingVerticalABPanelGroup(
            lines,
            index,
            blockedLines
        );
        if (verticalGroup) {
            const { lastIndex, ...group } = verticalGroup;
            groups.push(group);
            index = lastIndex;
            continue;
        }

        const labeledGroup = trailingSharedPanelLabelGroup(
            lines,
            index,
            blockedLines
        );
        if (labeledGroup) {
            const { captionIndex, ...group } = labeledGroup;
            groups.push(group);
            index = captionIndex;
            continue;
        }

        const caption = parseCaptionLine(lines[index].raw);
        if (caption) {
            const images = collectNearbyImages(lines, index + 1, blockedLines);
            const trailingCaptionIndex = nearbyLineIndex(
                lines,
                images.at(-1)?.index + 1 || index + 1
            );
            const trailingCaption = trailingCaptionIndex < lines.length
                ? parseCaptionLine(lines[trailingCaptionIndex].raw)
                : null;
            // When captions surround a run of images, treat the first image
            // as the leading figure and let the next pass attach the rest to
            // the trailing caption. This prevents adjacent figures from
            // being merged into one shared-caption group.
            if (trailingCaption
                && images.length > 1
                && !blockedLines.has(images[0].index)) {
                groups.push({
                    from: lines[index].from,
                    to: lines[images[0].index].to,
                    caption,
                    images: [images[0]],
                });
                index = images[0].index;
                continue;
            }
            if (images.length > 1
                || (images.length === 1
                    && isEmptyImageLine(lines[images[0].index].raw))) {
                groups.push({
                    from: lines[index].from,
                    to: lines[images.at(-1).index].to,
                    caption,
                    images,
                });
                index = images.at(-1).index;
                continue;
            }
        }

        if (!isMarkdownImageLine(lines[index].raw)) continue;
        const images = collectNearbyImages(lines, index, blockedLines);
        const singleEmptyImage = images.length === 1
            && isEmptyImageLine(lines[images[0].index].raw);
        if (images.length < 2 && !singleEmptyImage) continue;

        const embeddedCaptions = images
            .map(image => captionFromImageLine(lines[image.index].raw))
            .filter(Boolean);
        const horizontal = images.slice(0, -1).every(image => (
            hasExactTrailingSpaces(lines[image.index].raw, 2)
        ));
        if (images.length === 2
            && embeddedCaptions.length === 1
            && horizontal
            && describesSharedABFigurePanels(embeddedCaptions[0])) {
            groups.push({
                from: lines[index].from,
                to: lines[images.at(-1).index].to,
                caption: embeddedCaptions[0],
                images,
                layout: 'horizontal',
            });
            index = images.at(-1).index;
            continue;
        }

        const captionIndex = nearbyLineIndex(lines, images.at(-1).index + 1);
        if (captionIndex >= lines.length || blockedLines.has(captionIndex)) continue;
        const trailingCaption = parseCaptionLine(lines[captionIndex].raw);
        if (!trailingCaption) continue;

        groups.push({
            from: lines[index].from,
            to: lines[captionIndex].to,
            caption: trailingCaption,
            images,
        });
        index = captionIndex;
    }

    return groups;
}

function isEmptyImageLine(line) {
    return EMPTY_IMAGE_LINE_PATTERN.test(line || '');
}

function nextNonBlankLine(lines, index) {
    let cursor = index;
    while (cursor < lines.length && BLANK_LINE_PATTERN.test(lines[cursor].raw)) {
        cursor++;
    }
    return cursor;
}

export function findAcademicFigures(markdown) {
    const source = String(markdown || '');
    const lines = markdownLineRecords(source);
    const blockedLines = findBlockedLines(lines);
    const groups = findAcademicFigureGroups(source);
    const figures = groups.map(group => ({
        ...group,
        source: source.slice(group.from, group.to),
    }));

    for (const [index, line] of lines.entries()) {
        if (blockedLines.has(index)
            || groups.some(group => rangeContainsLine(group, line))) {
            continue;
        }
        const match = CAPTIONED_IMAGE_LINE_PATTERN.exec(line.raw);
        const caption = match
            ? parseAcademicFigureCaption(unescapeImageDescription(match[1]))
            : null;
        if (!caption) continue;
        figures.push({
            from: line.from,
            to: line.to,
            caption,
            images: [{ index, source: line.text.trim() }],
            source: line.text.trim(),
        });
    }

    return figures.sort((left, right) => left.from - right.from);
}

export function findAcademicTableGroups(markdown) {
    const source = String(markdown || '');
    const lines = markdownLineRecords(source);
    const blockedLines = findBlockedLines(lines);
    const reassignedCaptionsByTable = new Map(
        findMisassignedTableFigureCaptions(lines, blockedLines)
            .map(group => [group.table.from, group])
    );
    const groups = [];

    for (let index = 0; index < lines.length; index++) {
        if (blockedLines.has(index)) continue;
        const leadingTable = academicTableAt(lines, index, blockedLines);
        if (leadingTable) {
            const reassigned = reassignedCaptionsByTable.get(leadingTable.from);
            if (reassigned) {
                groups.push({
                    from: leadingTable.from,
                    to: leadingTable.to,
                    caption: reassigned.tableCaption,
                    table: leadingTable,
                });
                index = leadingTable.lastLineIndex;
                continue;
            }
            const captionIndex = nearbyLineIndex(
                lines,
                leadingTable.lastLineIndex + 1
            );
            const trailingCaption = captionIndex < lines.length
                && !blockedLines.has(captionIndex)
                ? parseAcademicTableCaption(lines[captionIndex].text)
                : null;
            if (trailingCaption) {
                groups.push({
                    from: leadingTable.from,
                    to: lines[captionIndex].to,
                    caption: trailingCaption,
                    table: leadingTable,
                });
                index = captionIndex;
                continue;
            }
        }
        let caption = parseAcademicTableCaption(lines[index].text);
        let tableIndex = nearbyLineIndex(lines, index + 1);
        if (!caption) {
            const heading = parseAcademicTableHeading(lines[index].text);
            if (!heading) continue;
            const tableAfterHeading = academicTableAt(
                lines,
                tableIndex,
                blockedLines
            );
            if (tableAfterHeading) {
                caption = createSplitTableCaption(heading, '');
            }
            else {
                const descriptionIndex = tableIndex;
                if (descriptionIndex >= lines.length
                    || blockedLines.has(descriptionIndex)
                    || !lines[descriptionIndex].text.trim()
                    || parseAcademicTableCaption(lines[descriptionIndex].text)) {
                    continue;
                }
                tableIndex = nearbyLineIndex(lines, descriptionIndex + 1);
                if (!academicTableAt(lines, tableIndex, blockedLines)) continue;
                caption = createSplitTableCaption(
                    heading,
                    lines[descriptionIndex].text.trim()
                );
            }
        }
        const table = academicTableAt(lines, tableIndex, blockedLines);
        if (!table) continue;
        groups.push({
            from: lines[index].from,
            to: table.to,
            caption,
            table,
        });
        index = table.lastLineIndex;
    }

    return groups;
}

export function normalizeMisassignedAcademicCaptions(markdown) {
    const source = String(markdown || '');
    const lines = markdownLineRecords(source);
    const groups = findMisassignedTableFigureCaptions(
        lines,
        findBlockedLines(lines)
    );
    if (!groups.length) return source;

    const edits = [];
    for (const group of groups) {
        const tableLine = lines[group.table.lastLineIndex];
        const ending = lineEnding(tableLine.raw)
            || (source.includes('\r\n') ? '\r\n' : '\n');
        edits.push({
            from: group.table.from,
            to: group.table.from,
            text: `${group.tableCaption.text}${ending}${ending}`,
        }, {
            from: lines[group.imageIndex].from,
            to: lines[group.imageIndex].to,
            text: replaceImageDescription(
                lines[group.imageIndex].text,
                group.figureCaption.text
            ),
        }, {
            from: lines[group.figureCaptionIndex].from,
            to: lines[group.figureCaptionIndex].to
                + lineEnding(lines[group.figureCaptionIndex].raw).length,
            text: '',
        });
    }
    edits.sort((left, right) => right.from - left.from || right.to - left.to);
    let normalized = source;
    for (const edit of edits) {
        normalized = normalized.slice(0, edit.from)
            + edit.text
            + normalized.slice(edit.to);
    }
    return normalized;
}

function parseAcademicTableHeading(value) {
    const source = String(value || '');
    const match = ACADEMIC_TABLE_HEADING_PATTERN.exec(source)
        || ACADEMIC_TABLE_PLAIN_HEADING_PATTERN.exec(source);
    if (!match) return null;
    return {
        label: match[1] + (match[2] || ''),
    };
}

function createSplitTableCaption(heading, description) {
    return {
        text: [heading.label, description].filter(Boolean).join(' '),
        label: heading.label,
        description,
    };
}

function academicTableAt(lines, index, blockedLines) {
    if (index >= lines.length || blockedLines.has(index)) return null;
    const htmlTable = rawHTMLTableAt(lines, index, blockedLines);
    if (htmlTable) return htmlTable;
    const header = parseGFMTableRow(lines[index]?.text);
    const separator = parseGFMTableRow(lines[index + 1]?.text);
    if (!header.length
        || blockedLines.has(index + 1)
        || separator.length !== header.length
        || separator.some(cell => !/^:?-{3,}:?$/.test(cell))) {
        return null;
    }

    let lastLineIndex = index + 1;
    while (lastLineIndex + 1 < lines.length
        && !blockedLines.has(lastLineIndex + 1)
        && isGFMTableRow(lines[lastLineIndex + 1].text)) {
        lastLineIndex++;
    }
    return {
        kind: 'gfm',
        from: lines[index].from,
        to: lines[lastLineIndex].to,
        source: lines
            .slice(index, lastLineIndex + 1)
            .map(line => line.text)
            .join('\n'),
        lastLineIndex,
    };
}

function rawHTMLTableAt(lines, index, blockedLines) {
    if (!RAW_HTML_TABLE_START_PATTERN.test(lines[index]?.text || '')) {
        return null;
    }
    for (let lastLineIndex = index;
        lastLineIndex < lines.length;
        lastLineIndex++) {
        if (blockedLines.has(lastLineIndex)) return null;
        if (!RAW_HTML_TABLE_END_PATTERN.test(lines[lastLineIndex].text)) {
            continue;
        }
        return {
            kind: 'html',
            from: lines[index].from,
            to: lines[lastLineIndex].to,
            source: lines
                .slice(index, lastLineIndex + 1)
                .map(line => line.text)
                .join('\n')
                .trim(),
            lastLineIndex,
        };
    }
    return null;
}

function findMisassignedTableFigureCaptions(lines, blockedLines) {
    const groups = [];
    for (let index = 0; index < lines.length; index++) {
        if (blockedLines.has(index)) continue;
        const table = academicTableAt(lines, index, blockedLines);
        if (!table) continue;

        const imageIndex = nearbyLineIndex(lines, table.lastLineIndex + 1);
        if (imageIndex >= lines.length || blockedLines.has(imageIndex)) continue;
        const tableCaption = tableCaptionFromImageLine(lines[imageIndex].raw);
        if (!tableCaption) continue;

        const figureCaptionIndex = nearbyLineIndex(lines, imageIndex + 1);
        if (figureCaptionIndex >= lines.length
            || blockedLines.has(figureCaptionIndex)) {
            continue;
        }
        const figureCaption = parseCaptionLine(
            lines[figureCaptionIndex].raw
        );
        if (!figureCaption
            || parseAcademicTableCaption(lines[figureCaptionIndex].text)) {
            continue;
        }
        groups.push({
            table,
            tableCaption,
            imageIndex,
            figureCaption,
            figureCaptionIndex,
        });
        index = table.lastLineIndex;
    }
    return groups;
}

function isGFMTableRow(line) {
    return /\|/.test(line || '') && !BLANK_LINE_PATTERN.test(line || '');
}

function markdownLineRecords(markdown) {
    const rawLines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const lines = [];
    let offset = 0;
    for (const raw of rawLines) {
        const ending = lineEnding(raw);
        const text = raw.slice(0, raw.length - ending.length);
        lines.push({
            raw,
            text,
            from: offset,
            to: offset + text.length,
        });
        offset += raw.length;
    }
    return lines;
}

function findBlockedLines(lines) {
    const blocked = new Set();
    let activeFence = null;
    for (const [index, line] of lines.entries()) {
        const fence = markdownFence(line.raw);
        if (activeFence) {
            blocked.add(index);
            if (fence
                && fence.character === activeFence.character
                && fence.length >= activeFence.length
                && !fence.trailing.trim()) {
                activeFence = null;
            }
            continue;
        }
        if (fence) {
            activeFence = fence;
            blocked.add(index);
            continue;
        }
        if (isIndentedCodeLine(line.raw)) blocked.add(index);
    }
    return blocked;
}

function collectNearbyImages(lines, startIndex, blockedLines) {
    const images = [];
    let index = nearbyLineIndex(lines, startIndex);
    while (index < lines.length
        && !blockedLines.has(index)
        && isMarkdownImageLine(lines[index].raw)) {
        images.push({
            index,
            source: lines[index].text.trim(),
        });
        const nextIndex = nearbyLineIndex(lines, index + 1);
        if (nextIndex <= index) break;
        index = nextIndex;
    }
    return images;
}

function leadingVerticalABPanelGroup(lines, startIndex, blockedLines) {
    const firstLabel = markedVerticalPanelLabel(lines[startIndex], 'a');
    if (!firstLabel) return null;

    const firstImageIndex = startIndex + 1;
    if (firstImageIndex >= lines.length
        || blockedLines.has(firstImageIndex)
        || !isMarkdownImageLine(lines[firstImageIndex].raw)
        || captionFromImageLine(lines[firstImageIndex].raw)
        || !hasExactTrailingSpaces(
            lines[firstImageIndex].raw,
            MINERU_VERTICAL_PANEL_MARKER_SPACES
        )) {
        return null;
    }

    const secondLabelIndex = firstImageIndex + 1;
    const secondLabel = plainPanelLabel(lines[secondLabelIndex], 'b');
    if (!secondLabel || blockedLines.has(secondLabelIndex)) return null;

    const secondImageIndex = nearbyLineIndex(lines, secondLabelIndex + 1);
    if (secondImageIndex >= lines.length
        || blockedLines.has(secondImageIndex)
        || !isMarkdownImageLine(lines[secondImageIndex].raw)) {
        return null;
    }
    const caption = captionFromImageLine(lines[secondImageIndex].raw);
    if (!describesSharedABFigurePanels(caption)) return null;

    return {
        from: lines[startIndex].from,
        to: lines[secondImageIndex].to,
        caption,
        images: [{
            index: firstImageIndex,
            source: lines[firstImageIndex].text.trim(),
            panelLabel: firstLabel,
            panelLabelPosition: 'before',
        }, {
            index: secondImageIndex,
            source: lines[secondImageIndex].text.trim(),
            panelLabel: secondLabel,
            panelLabelPosition: 'before',
        }],
        layout: 'vertical',
        lastIndex: secondImageIndex,
    };
}

function markedVerticalPanelLabel(line, expectedLabel) {
    return hasExactTrailingSpaces(
        line?.raw,
        MINERU_VERTICAL_PANEL_MARKER_SPACES
    ) ? plainPanelLabel(line, expectedLabel) : null;
}

function plainPanelLabel(line, expectedLabel) {
    const text = line?.text?.trim() || '';
    const match = /^\(\s*([ab])\s*\)$/iu.exec(text);
    return match?.[1].toLowerCase() === expectedLabel ? text : null;
}

function hasExactTrailingSpaces(line, count) {
    const text = String(line || '').replace(/\r?\n$/, '');
    const marker = ' '.repeat(count);
    return text.endsWith(marker) && !text.endsWith(`${marker} `);
}

function trailingSharedPanelLabelGroup(lines, startIndex, blockedLines) {
    const images = [];
    let index = startIndex;
    let caption = null;
    let captionIndex = -1;

    while (index < lines.length
        && !blockedLines.has(index)
        && isMarkdownImageLine(lines[index].raw)
        && MARKDOWN_HARD_BREAK_PATTERN.test(lines[index].raw)) {
        const labelIndex = index + 1;
        if (labelIndex >= lines.length || blockedLines.has(labelIndex)) {
            return null;
        }
        const panelLabel = extractedPanelLabel(lines[labelIndex]);
        if (!panelLabel) return null;

        images.push({
            index,
            source: lines[index].text.trim(),
            panelLabel,
        });

        index = nearbyLineIndex(lines, labelIndex + 1);
        // Bilingual comparison inserts the translated axis label between panels.
        while (index < lines.length && !blockedLines.has(index)
            && !isMarkdownImageLine(lines[index].raw)) {
            const repeatedPanelLabel = extractedPanelLabel(lines[index]);
            if (!panelLabelsMayRepeat(panelLabel, repeatedPanelLabel)) break;
            index = nearbyLineIndex(lines, index + 1);
        }
        if (index < lines.length
            && !blockedLines.has(index)
            && isMarkdownImageLine(lines[index].raw)) {
            continue;
        }

        if (index < lines.length && !blockedLines.has(index)) {
            caption = parseCaptionLine(lines[index].raw);
            captionIndex = index;
        }
        break;
    }

    if (!images.length || !caption) return null;
    if (images.length === 1
        && (!isTrailingCompositePanelLabel(images[0].panelLabel)
            || !describesSharedABFigurePanels(caption))) {
        return null;
    }
    const sharedLabel = images[0].panelLabel;
    if (images.some(image => !panelLabelsMatch(
        image.panelLabel,
        sharedLabel
    ))) return null;

    return {
        from: lines[startIndex].from,
        to: lines[captionIndex].to,
        caption,
        captionIndex,
        images,
    };
}

function isTrailingCompositePanelLabel(label) {
    return /^\(\s*b\s*\)[ \t]+\S/iu.test(String(label || ''));
}

function extractedPanelLabel(line) {
    const text = line?.text?.trim() || '';
    if (!text
        || text.length > MAX_PANEL_LABEL_LENGTH
        || isMarkdownImageLine(line.raw)
        || parseAcademicFigureCaption(text)) {
        return null;
    }
    return text;
}

function panelLabelsMatch(left, right) {
    const normalizedLeft = normalizePanelLabel(left);
    return normalizedLeft !== ''
        && normalizedLeft === normalizePanelLabel(right);
}

function panelLabelsMayRepeat(left, right) {
    if (!right) return false;
    if (panelLabelsMatch(left, right)) return true;
    const candidate = String(right || '');
    return hasNonASCIIWord(left) !== hasNonASCIIWord(candidate)
        && !/[.!?。！？]$/u.test(candidate);
}

function hasNonASCIIWord(value) {
    return [...String(value || '')].some(character => (
        /\p{L}/u.test(character)
        && character.codePointAt(0) > 0x7f
    ));
}

function normalizePanelLabel(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/\s+/gu, '')
        .toLowerCase();
}

function nearbyLineIndex(lines, index) {
    return index < lines.length && BLANK_LINE_PATTERN.test(lines[index].raw)
        ? index + 1
        : index;
}

function isMarkdownImageLine(line) {
    return MARKDOWN_IMAGE_LINE_PATTERN.test(line || '');
}

function previousNearbyLineIsImage(lines, index) {
    let previousIndex = index - 1;
    if (BLANK_LINE_PATTERN.test(lines[previousIndex] || '')) previousIndex--;
    return MARKDOWN_IMAGE_LINE_PATTERN.test(lines[previousIndex] || '');
}

function nextNearbyLineIsImage(lines, index) {
    let nextIndex = index + 1;
    if (BLANK_LINE_PATTERN.test(lines[nextIndex] || '')) nextIndex++;
    return MARKDOWN_IMAGE_LINE_PATTERN.test(lines[nextIndex] || '');
}

function parseCaptionLine(line) {
    const source = String(line || '');
    const ending = lineEnding(source);
    return parseAcademicFigureCaption(
        source.slice(0, source.length - ending.length)
    );
}

function captionFromImageLine(line) {
    const match = CAPTIONED_IMAGE_LINE_PATTERN.exec(line || '');
    return match
        ? parseAcademicFigureCaption(unescapeImageDescription(match[1]))
        : null;
}

function tableCaptionFromImageLine(line) {
    const match = CAPTIONED_IMAGE_LINE_PATTERN.exec(line || '');
    return match
        ? parseAcademicTableCaption(unescapeImageDescription(match[1]))
        : null;
}

export function describesSharedABFigurePanels(caption) {
    return /\(\s*a\s*\)/iu.test(caption?.description || '')
        && /\(\s*b\s*\)/iu.test(caption?.description || '');
}

function isIndentedCodeLine(line) {
    return /^(?: {4}|\t)/.test(line || '');
}

function lineEnding(line) {
    return /\r?\n$/.exec(line || '')?.[0] || '';
}

function rangeContainsLine(range, line) {
    return line.from >= range.from && line.to <= range.to;
}

function unescapeImageDescription(value) {
    return String(value).replace(/\\([\\\[\]])/g, '$1');
}

function formatCaptionedImage(image, caption, ending) {
    return `${image[1]}![${escapeImageDescription(caption)}]`
        + `${image[2]}${ending}`;
}

function markdownFence(line) {
    const source = String(line).replace(/\r?\n$/, '');
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(source);
    if (!match) return null;
    return {
        character: match[1][0],
        length: match[1].length,
        trailing: match[2],
    };
}

function escapeImageDescription(value) {
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

function replaceImageDescription(line, caption) {
    const source = String(line || '');
    const match = CAPTIONED_IMAGE_LINE_PATTERN.exec(source);
    if (!match) return source;
    const descriptionFrom = source.indexOf('![') + 2;
    const descriptionTo = descriptionFrom + match[1].length;
    return source.slice(0, descriptionFrom)
        + escapeImageDescription(caption)
        + source.slice(descriptionTo);
}
