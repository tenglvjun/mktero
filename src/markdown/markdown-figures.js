import { parseGFMTableRow } from './markdown-tables.js';

const ACADEMIC_FIGURE_CAPTION_PATTERN = /^((?:(?:algorithm|chart|fig\.?|figure|scheme|table)[ \t]+(?:s?\d+[a-z]?|[ivxlcdm]+[a-z]?)[.:]|fig\.[ \t]+(?:s?\d+[a-z]?|[ivxlcdm]+[a-z]?)))[ \t]+(\S[\s\S]*)$/iu;
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
const MAX_PANEL_LABEL_LENGTH = 80;

export function parseAcademicFigureCaption(value) {
    const text = String(value || '').trim();
    const match = ACADEMIC_FIGURE_CAPTION_PATTERN.exec(text);
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
    const groups = [];

    for (let index = 0; index < lines.length; index++) {
        if (blockedLines.has(index)) continue;

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
            if (images.length > 1) {
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
        if (images.length < 2) continue;

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
    const groups = [];

    for (let index = 0; index < lines.length; index++) {
        if (blockedLines.has(index)) continue;
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

    if (images.length < 2 || !caption) return null;
    const sharedLabel = images[0].panelLabel;
    if (images.some(image => image.panelLabel !== sharedLabel)) return null;

    return {
        from: lines[startIndex].from,
        to: lines[captionIndex].to,
        caption,
        captionIndex,
        images,
    };
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
