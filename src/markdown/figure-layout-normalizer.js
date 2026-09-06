import {
    describesSharedABFigurePanels,
    parseAcademicFigureCaption,
    parseFigureLayoutMarker,
} from './markdown-figures.js';

const IMAGE_LINE_PATTERN = /^( {0,3})!\[([^\]\r\n]*)\]\(\s*(<[^>\r\n]+>|[^)\s]+)([^)]*)\)[ \t]*(?:\r?\n)?$/;

/**
 * Restore the layout of an academic figure whose OCR output contains one
 * image per Markdown paragraph. Providers supply normalized image blocks;
 * this module deliberately knows nothing about their response formats.
 */
export function normalizeFigureLayouts(markdown, imageBlocks = [], {
    allowFallback = false,
    skipExistingPanelLayout = false,
} = {}) {
    if (typeof markdown !== 'string'
        || !markdown
        || !Array.isArray(imageBlocks)) {
        return markdown;
    }

    const blocksByAssetPath = new Map();
    for (const block of imageBlocks) {
        if (!isUsableImageBlock(block)) continue;
        const entries = blocksByAssetPath.get(block.assetPath) || [];
        entries.push(block);
        blocksByAssetPath.set(block.assetPath, entries);
    }

    const lines = markdownLineRecords(markdown);
    const markers = new Map();
    const lineOverrides = new Map();
    for (let index = 0; index < lines.length; index++) {
        const existingMarker = parseExistingLayoutMarker(lines[index].text);
        if (existingMarker) {
            index = skipExistingLayout(lines, index, existingMarker);
            continue;
        }
        const firstImage = parseStandaloneImage(lines[index].text);
        if (!firstImage) continue;
        // A captioned first image is already a complete single-image figure
        // (typically the previous figure on the page). Do not absorb the next
        // image run merely because the provider omitted prose between them.
        if (parseAcademicFigureCaption(firstImage.alt)) continue;

        const imageLines = [
            { index, line: lines[index], image: firstImage },
        ];
        let cursor = index + 1;
        while (cursor < lines.length) {
            while (cursor < lines.length && !lines[cursor].text.trim()) cursor++;
            const image = parseStandaloneImage(lines[cursor]?.text);
            if (!image) break;
            imageLines.push({ index: cursor, line: lines[cursor], image });
            cursor++;
            // An embedded caption terminates this figure so adjacent
            // captioned figures cannot be merged.
            if (parseAcademicFigureCaption(image.alt)) break;
        }
        if (imageLines.length < 2) continue;

        const captionIndex = nextNonBlankLine(lines, cursor);
        const trailingCaption = captionIndex < lines.length
            ? parseAcademicFigureCaption(lines[captionIndex].text)
            : null;
        const embeddedCaption = imageLines
            .slice()
            .reverse()
            .map(({ image }) => parseAcademicFigureCaption(image.alt))
            .find(Boolean);
        const precedingCaptionIndex = previousNonBlankLine(lines, index - 1);
        const precedingCaption = precedingCaptionIndex >= 0
            ? parseAcademicFigureCaption(lines[precedingCaptionIndex].text)
            : null;
        const caption = trailingCaption || embeddedCaption || precedingCaption;
        if (!caption) continue;
        // Two academic captions around one image run are a boundary between
        // adjacent figures, not a shared caption. Leave the source untouched
        // so the figure analyzer can assign the first image to the leading
        // caption and the remaining images to the trailing caption.
        if (precedingCaption && trailingCaption) continue;
        if (skipExistingPanelLayout
            && isExistingHorizontalPanelLayout(imageLines, caption)) {
            continue;
        }

        const blocks = imageLines.map(({ image }) => (
            findUniqueImageBlock(blocksByAssetPath, image.destination)
        ));
        const layout = inferFigureLayout(imageLines.length, blocks, allowFallback);
        if (!layout) continue;

        for (const [targetIndex, sourceIndex] of layout.order.entries()) {
            const targetLine = imageLines[targetIndex];
            const sourceLine = imageLines[sourceIndex];
            if (targetLine.index !== sourceLine.index) {
                lineOverrides.set(targetLine.index, sourceLine.line.raw);
            }
        }

        const ending = lineEnding(lines[index].raw) || '\n';
        let marker = `<!-- mktero-figure-layout: columns=${layout.columns}`
            + ` rows=${layout.rows.join(',')}`;
        if (layout.spans.some(span => span > 1)) {
            marker += ` spans=${layout.spans.join(',')}`;
        }
        const markerIndex = precedingCaption ? precedingCaptionIndex : index;
        markers.set(markerIndex, `${marker} -->${ending}`);
        index = trailingCaption ? captionIndex : imageLines.at(-1).index;
    }

    if (!markers.size) return markdown;
    return lines.map((line, index) => (
        `${markers.get(index) || ''}${lineOverrides.get(index) || line.raw}`
    )).join('');
}

function isUsableImageBlock(block) {
    return Boolean(block)
        && typeof block.assetPath === 'string'
        && block.assetPath
        && Number.isSafeInteger(block.pageIndex)
        && block.pageIndex >= 0
        && isValidBBox(block.bbox);
}

function isValidBBox(value) {
    return Array.isArray(value)
        && value.length === 4
        && value.every(coordinate => (
            Number.isFinite(coordinate)
            && coordinate >= 0
            && coordinate <= 1000
        ))
        && value[0] < value[2]
        && value[1] < value[3];
}

function isExistingHorizontalPanelLayout(imageLines, caption) {
    return imageLines.length === 2
        && describesSharedABFigurePanels(caption)
        && /(?:^|[^ \t]) {2}(?:\r?\n)?$/u.test(imageLines[0].line.raw);
}

function markdownLineRecords(markdown) {
    const rawLines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const lines = [];
    let offset = 0;
    for (const raw of rawLines) {
        const ending = lineEnding(raw);
        lines.push({
            raw,
            text: raw.slice(0, raw.length - ending.length),
            from: offset,
            to: offset + raw.length,
        });
        offset += raw.length;
    }
    return lines;
}

function parseStandaloneImage(line) {
    const match = IMAGE_LINE_PATTERN.exec(`${line}\n`);
    if (!match) return null;
    const rawDestination = match[3];
    const destination = rawDestination.startsWith('<')
        ? rawDestination.slice(1, -1)
        : rawDestination;
    return {
        alt: match[2],
        destination,
    };
}

function nextNonBlankLine(lines, index) {
    let cursor = index;
    while (cursor < lines.length && !lines[cursor].text.trim()) cursor++;
    return cursor;
}

function previousNonBlankLine(lines, index) {
    let cursor = index;
    while (cursor >= 0 && !lines[cursor].text.trim()) cursor--;
    return cursor;
}

function findUniqueImageBlock(blocksByAssetPath, destination) {
    const entries = blocksByAssetPath.get(destination);
    if (entries?.length === 1) return entries[0];
    try {
        const decoded = decodeURIComponent(destination);
        const decodedEntries = blocksByAssetPath.get(decoded);
        return decodedEntries?.length === 1 ? decodedEntries[0] : null;
    }
    catch {
        return null;
    }
}

function inferFigureLayout(imageCount, blocks, allowFallback) {
    if (blocks.every(Boolean)) {
        const pageIndex = blocks[0].pageIndex;
        if (blocks.every(block => block.pageIndex === pageIndex)) {
            return inferGeometryLayout(blocks);
        }
    }
    return allowFallback ? inferFallbackLayout(imageCount) : null;
}

function inferGeometryLayout(blocks) {
    const items = blocks.map((block, index) => {
        const box = block.bbox;
        return {
            index,
            box,
            centerY: (box[1] + box[3]) / 2,
            width: box[2] - box[0],
        };
    }).sort((left, right) => (
        left.box[1] - right.box[1]
        || left.box[0] - right.box[0]
        || left.index - right.index
    ));

    const rows = [];
    for (const item of items) {
        const row = rows.at(-1);
        if (!row || !sameGridRow(row, item)) rows.push([item]);
        else row.push(item);
    }

    const sortedRows = rows.map(row => row.slice().sort(
        (left, right) => left.box[0] - right.box[0]
    ));
    const rowMajor = sortedRows.flat();
    const columns = Math.max(...sortedRows.map(row => row.length));
    if (columns > 16 || sortedRows.length > 16 || rowMajor.length > 256) {
        return null;
    }
    const widths = rowMajor
        .map(item => item.width)
        .sort((left, right) => left - right);
    const medianWidth = widths[Math.floor(widths.length / 2)] || 0;
    const spans = rowMajor.map(item => {
        const row = sortedRows.find(candidate => candidate.includes(item));
        return columns > 1
            && row?.length === 1
            && medianWidth > 0
            && item.width >= medianWidth * 1.6
            ? columns
            : 1;
    });
    return {
        columns,
        rows: sortedRows.map(row => row.length),
        spans,
        order: rowMajor.map(item => item.index),
    };
}

function inferFallbackLayout(imageCount) {
    if (!Number.isSafeInteger(imageCount) || imageCount < 2) return null;
    const columns = imageCount === 4
        ? 2
        : Math.min(3, imageCount);
    const rows = [];
    let remaining = imageCount;
    while (remaining > 0) {
        const row = Math.min(columns, remaining);
        rows.push(row);
        remaining -= row;
    }
    if (rows.length > 16) return null;
    return {
        columns,
        rows,
        spans: Array(imageCount).fill(1),
        order: Array.from({ length: imageCount }, (_, index) => index),
    };
}

function sameGridRow(row, item) {
    const rowTop = Math.min(...row.map(entry => entry.box[1]));
    const rowBottom = Math.max(...row.map(entry => entry.box[3]));
    const overlap = Math.min(rowBottom, item.box[3])
        - Math.max(rowTop, item.box[1]);
    const itemHeight = item.box[3] - item.box[1];
    const rowHeight = rowBottom - rowTop;
    const minimumHeight = Math.min(itemHeight, rowHeight);
    const rowCenter = row
        .reduce((sum, entry) => sum + entry.centerY, 0) / row.length;
    return overlap > 0
        && overlap / minimumHeight >= 0.35
        && Math.abs(item.centerY - rowCenter) <= minimumHeight * 0.65;
}

function parseExistingLayoutMarker(line) {
    return parseFigureLayoutMarker(line);
}

function skipExistingLayout(lines, markerIndex, marker) {
    const imageCount = marker.rows.reduce((sum, row) => sum + row, 0);
    let cursor = nextNonBlankLine(lines, markerIndex + 1);
    if (parseAcademicFigureCaption(lines[cursor]?.text)) {
        cursor = nextNonBlankLine(lines, cursor + 1);
    }
    let seenImages = 0;
    while (cursor < lines.length && seenImages < imageCount) {
        if (!parseStandaloneImage(lines[cursor].text)) break;
        seenImages++;
        cursor = nextNonBlankLine(lines, cursor + 1);
    }
    if (seenImages === imageCount) {
        const trailingCaption = parseAcademicFigureCaption(lines[cursor]?.text);
        if (trailingCaption) cursor = nextNonBlankLine(lines, cursor + 1);
    }
    return Math.max(markerIndex, cursor - 1);
}

function lineEnding(value) {
    return value.endsWith('\r\n')
        ? '\r\n'
        : value.endsWith('\n')
            ? '\n'
            : '';
}
