export const MAX_CHROME_RANGES = 10_000;
export const MAX_CHROME_RANGES_BYTES = 1024 * 1024;

const BLANK_LINE = /^[ \t]*$/;

const PUBLISHER_UI_PATTERN = /^(?:check for updates|review article(?:\s+open)?|open access|download pdf|view (?:pdf|article|full text)|full text(?: html)?|accepted manuscript)$/i;
const ATX_HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const PAPER_TITLE_HEADING_PATTERN = /^ {0,3}#{1,2}(?:[ \t]+|$)/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

export function visibleDocumentChromeRanges(markdown, storedRanges, itemTitle) {
    if (typeof markdown !== 'string') return [];
    const title = findPaperTitleHeading(markdown, itemTitle);
    return clipChromeAwayFromHeading(
        markdown,
        normalizeChromeRanges([
            ...normalizeChromeRanges(storedRanges, markdown.length),
            ...findLeadingPublisherChromeRanges(markdown),
            ...findLeadingPreambleChromeRanges(markdown, title?.from ?? null),
        ], markdown.length),
        title
    );
}

// OCR often splits "Title: subtitle" across consecutive headings and drops
// the joining punctuation. A run matches only when rejoining it reproduces
// the bibliographic title.
export function findPaperTitleHeading(markdown, itemTitle) {
    if (typeof markdown !== 'string' || !markdown) return null;
    const itemKey = titleHeadingKey(itemTitle);
    if (!itemKey) return null;
    const headings = collectTitleHeadings(markdown);
    const singles = headings.filter(heading => heading.key === itemKey);
    const chosen = chooseCoverTitle(
        markdown,
        singles.map(heading => [heading])
    ) || chooseCoverTitle(
        markdown,
        collectSplitTitleGroups(markdown, headings, itemKey)
    );
    if (!chosen) return null;
    return {
        from: chosen[0].from,
        to: lineEnd(markdown, chosen.at(-1).from),
        partOffsets: chosen.map(part => part.from),
        text: String(itemTitle).replace(/\s+/gu, ' ').trim(),
    };
}

function findLeadingPreambleChromeRanges(markdown, titleFrom) {
    if (typeof markdown !== 'string' || !markdown) return [];
    if (!Number.isSafeInteger(titleFrom) || titleFrom <= 0) return [];
    const to = lineBreakBefore(markdown, titleFrom);
    if (to <= 0) return [];
    return [{ from: 0, to }];
}

function lineBreakBefore(markdown, offset) {
    let to = offset;
    if (to > 0 && markdown[to - 1] === '\n') to--;
    if (to > 0 && markdown[to - 1] === '\r') to--;
    return to;
}

const MAX_SPLIT_TITLE_PARTS = 4;
const SPLIT_TITLE_SEPARATORS = [': ', ' - ', ' \u2014 ', ' \u2013 ', ':'];

function collectSplitTitleGroups(markdown, headings, itemKey) {
    const groups = [];
    for (let start = 0; start < headings.length; start++) {
        const limit = Math.min(
            headings.length,
            start + MAX_SPLIT_TITLE_PARTS
        );
        for (let end = start + 2; end <= limit; end++) {
            const parts = headings.slice(start, end);
            if (!titlePartsAreContiguous(markdown, parts)) break;
            if (!splitTitleMatches(parts, itemKey)) continue;
            groups.push(parts);
            break;
        }
    }
    return groups;
}

function chooseCoverTitle(markdown, groups) {
    if (!groups.length) return null;
    if (groups.length >= 2
        && isCoverTitleDuplicate(
            markdown,
            groups[0].at(-1).from,
            groups[1][0].from
        )) {
        return groups[1];
    }
    return groups[0];
}

function titlePartsAreContiguous(markdown, parts) {
    for (let index = 1; index < parts.length; index++) {
        const between = markdown.slice(
            lineEnd(markdown, parts[index - 1].from),
            parts[index].from
        );
        if (between.trim()) return false;
    }
    return true;
}

function splitTitleMatches(parts, itemKey) {
    const keys = parts.map(part => part.key);
    const rest = keys.slice(1).join(' ');
    const candidates = [
        keys.join(' '),
        ...SPLIT_TITLE_SEPARATORS.map(separator => (
            `${keys[0]}${separator}${rest}`
        )),
    ];
    return candidates.some(candidate => titleHeadingKey(candidate) === itemKey);
}

function isCoverTitleDuplicate(markdown, firstFrom, secondFrom) {
    if (secondFrom <= firstFrom) return false;
    const body = markdown.slice(lineEnd(markdown, firstFrom), secondFrom);
    const paragraphs = body.split(/\n\s*\n/)
        .map(part => part.trim())
        .filter(Boolean);
    if (paragraphs.length >= 2) return false;
    return body.replace(/\s+/g, '').length <= 400;
}

function collectTitleHeadings(markdown) {
    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const headings = [];
    let offset = 0;
    let fence = null;
    for (const raw of lines) {
        const ending = /\r?\n$/.exec(raw)?.[0] || '';
        const text = raw.slice(0, raw.length - ending.length);
        const lineFrom = offset;
        offset += raw.length;
        const fenceMark = FENCE_PATTERN.exec(text);
        if (fence) {
            if (closesFence(fence, fenceMark, text)) fence = null;
            continue;
        }
        if (fenceMark) {
            fence = {
                marker: fenceMark[1][0],
                length: fenceMark[1].length,
            };
            continue;
        }
        if (!PAPER_TITLE_HEADING_PATTERN.test(text)) continue;
        const key = titleHeadingKey(text);
        if (!key) continue;
        headings.push({ from: lineFrom, key });
    }
    return headings;
}

function titleHeadingKey(text) {
    return stripHeadingMarks(text)
        .replace(/[ \t]+#+$/u, '')
        .replace(/\u00ad/gu, '')
        .replace(/[\u2010-\u2015\u2212]/gu, '-')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
}

function closesFence(fence, fenceMark, text) {
    return Boolean(fenceMark)
        && fenceMark[1][0] === fence.marker
        && fenceMark[1].length >= fence.length
        && !text.slice(fenceMark[0].length).trim();
}

export function findLeadingPublisherChromeRanges(markdown) {
    if (typeof markdown !== 'string' || !markdown) return [];
    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const ranges = [];
    let offset = 0;
    for (const raw of lines) {
        const ending = /\r?\n$/.exec(raw)?.[0] || '';
        const text = raw.slice(0, raw.length - ending.length);
        const from = offset;
        offset += raw.length;
        const visible = stripHeadingMarks(text);
        if (!visible) continue;
        if (isPublisherUIText(visible)) {
            ranges.push({ from, to: from + text.length });
            continue;
        }
        break;
    }
    return clipChromeBeforeOffset(
        markdown,
        absorbBlankLines(markdown, ranges),
        firstPaperHeadingOffset(markdown)
    );
}

function clipChromeAwayFromHeading(markdown, ranges, title) {
    const headingFrom = title?.from;
    const headingTo = title?.to;
    if (!Number.isSafeInteger(headingFrom)
        || !Number.isSafeInteger(headingTo)
        || headingFrom < 0
        || headingTo <= headingFrom
        || headingFrom >= markdown.length) {
        return normalizeChromeRanges(ranges, markdown.length);
    }
    const protectedFrom = lineBreakBefore(markdown, headingFrom);
    if (headingTo <= protectedFrom) {
        return normalizeChromeRanges(ranges, markdown.length);
    }
    return normalizeChromeRanges(
        (Array.isArray(ranges) ? ranges : []).flatMap(range => (
            subtractChromeRanges(range, [{ from: protectedFrom, to: headingTo }])
        )),
        markdown.length
    );
}

function clipChromeBeforeOffset(markdown, ranges, headingFrom) {
    if (headingFrom === null) return ranges;
    const limit = headingFrom > 0 ? headingFrom - 1 : headingFrom;
    return normalizeChromeRanges(
        ranges
            .map(range => ({
                from: range.from,
                to: Math.min(range.to, limit),
            }))
            .filter(range => range.to > range.from),
        markdown.length
    );
}

function firstPaperHeadingOffset(markdown) {
    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    let offset = 0;
    for (let index = 0; index < lines.length; index++) {
        const raw = lines[index];
        const ending = /\r?\n$/.exec(raw)?.[0] || '';
        const text = raw.slice(0, raw.length - ending.length);
        const visible = stripHeadingMarks(text);
        const lineFrom = offset;
        offset += raw.length;
        if (!visible || isPublisherUIText(visible)) continue;
        if (ATX_HEADING_PATTERN.test(text)) return lineFrom;
        const next = lines[index + 1];
        if (next && /^( {0,3})(?:=+|-+)[ \t]*$/.test(
            next.replace(/\r?\n$/, '')
        )) {
            return lineFrom;
        }
        return null;
    }
    return null;
}

function stripHeadingMarks(text) {
    return String(text || '')
        .replace(ATX_HEADING_PATTERN, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isPublisherUIText(text) {
    return PUBLISHER_UI_PATTERN.test(text);
}

export function normalizeChromeRanges(ranges, markdownLength) {
    if (!Array.isArray(ranges)
        || ranges.length > MAX_CHROME_RANGES
        || !Number.isSafeInteger(markdownLength)
        || markdownLength < 0) {
        return [];
    }
    const normalized = [];
    for (const range of ranges) {
        if (!isHalfOpenRange(range, markdownLength)) return [];
        normalized.push({ from: range.from, to: range.to });
    }
    normalized.sort((left, right) => left.from - right.from || left.to - right.to);
    return mergeRanges(normalized);
}

export function absorbBlankLines(markdown, ranges) {
    if (typeof markdown !== 'string') return [];
    const normalized = normalizeChromeRanges(ranges, markdown.length);
    const expanded = normalized.map(range => (
        expandOverBlankLines(markdown, range)
    ));
    return normalizeChromeRanges(expanded, markdown.length);
}

export function subtractChromeRanges(range, chromeRanges) {
    if (!isHalfOpenRange(range, Number.MAX_SAFE_INTEGER)) return [];
    const hidden = mergeRanges(
        (Array.isArray(chromeRanges) ? chromeRanges : [])
            .filter(candidate => isHalfOpenRange(candidate, Number.MAX_SAFE_INTEGER))
            .map(candidate => ({ from: candidate.from, to: candidate.to }))
            .sort((left, right) => left.from - right.from || left.to - right.to)
    );
    const visible = [];
    let cursor = range.from;
    for (const chrome of hidden) {
        if (chrome.to <= cursor) continue;
        if (chrome.from >= range.to) break;
        if (chrome.from > cursor) {
            visible.push({
                from: cursor,
                to: Math.min(chrome.from, range.to),
            });
        }
        cursor = Math.max(cursor, chrome.to);
        if (cursor >= range.to) break;
    }
    if (cursor < range.to) {
        visible.push({ from: cursor, to: range.to });
    }
    return visible;
}

export function visibleTextForRanges(markdown, ranges) {
    if (typeof markdown !== 'string' || !Array.isArray(ranges)) return '';
    let text = '';
    for (const range of ranges) {
        text += markdown.slice(range.from, range.to);
    }
    return text;
}

export function mapChromeRanges(ranges, transforms, markdownLength) {
    const steps = Array.isArray(transforms) ? transforms : [];
    const mapped = [];
    for (const range of Array.isArray(ranges) ? ranges : []) {
        if (!isHalfOpenRange(range, Number.MAX_SAFE_INTEGER)) continue;
        if (steps.some(transform => (
            isTransform(transform) && rangesOverlap(range, transform)
        ))) {
            continue;
        }
        mapped.push({
            from: mapPosition(range.from, -1, steps),
            to: mapPosition(range.to, 1, steps),
        });
    }
    return normalizeChromeRanges(mapped, markdownLength);
}

function isHalfOpenRange(range, markdownLength) {
    return Boolean(range)
        && typeof range === 'object'
        && Number.isSafeInteger(range.from)
        && Number.isSafeInteger(range.to)
        && range.from >= 0
        && range.to <= markdownLength
        && range.from < range.to;
}

function mergeRanges(ranges) {
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (!previous || range.from > previous.to) {
            merged.push({ from: range.from, to: range.to });
        }
        else {
            previous.to = Math.max(previous.to, range.to);
        }
    }
    return merged;
}

function expandOverBlankLines(markdown, range) {
    let from = range.from;
    let to = range.to;
    to = absorbLineTail(markdown, to);
    to = absorbFollowingBlankLines(markdown, to);
    from = absorbLineHead(markdown, from);
    from = absorbPrecedingBlankLines(markdown, from);
    return { from, to };
}

function absorbLineTail(markdown, to) {
    if (to >= markdown.length || isLineStart(markdown, to)) return to;
    const end = lineEnd(markdown, to);
    if (!BLANK_LINE.test(markdown.slice(to, lineContentEnd(markdown, end)))) {
        return to;
    }
    return end;
}

function absorbFollowingBlankLines(markdown, to) {
    while (to < markdown.length) {
        const end = lineEnd(markdown, to);
        if (end === to) break;
        if (!BLANK_LINE.test(markdown.slice(to, lineContentEnd(markdown, end)))) {
            break;
        }
        to = end;
    }
    return to;
}

function absorbLineHead(markdown, from) {
    if (from <= 0 || isLineStart(markdown, from)) return from;
    const start = lineStart(markdown, from);
    if (!BLANK_LINE.test(markdown.slice(start, from))) return from;
    return start;
}

function absorbPrecedingBlankLines(markdown, from) {
    let absorbedBlank = false;
    while (from > 0 && markdown[from - 1] === '\n') {
        const start = lineStart(markdown, from - 1);
        if (!BLANK_LINE.test(markdown.slice(start, lineContentEnd(markdown, from)))) {
            break;
        }
        from = start;
        absorbedBlank = true;
    }
    if (absorbedBlank && from > 0 && markdown[from - 1] === '\n') {
        from--;
        if (from > 0 && markdown[from - 1] === '\r') from--;
    }
    return from;
}

function isLineStart(markdown, position) {
    return position <= 0 || markdown[position - 1] === '\n';
}

function lineStart(markdown, position) {
    let start = position;
    while (start > 0 && markdown[start - 1] !== '\n') start--;
    return start;
}

function lineEnd(markdown, position) {
    let end = position;
    while (end < markdown.length && markdown[end] !== '\n') {
        if (markdown[end] === '\r' && markdown[end + 1] === '\n') return end + 2;
        if (markdown[end] === '\r') return end + 1;
        end++;
    }
    if (end < markdown.length && markdown[end] === '\n') return end + 1;
    return end;
}

function lineContentEnd(markdown, end) {
    if (end > 0 && markdown[end - 1] === '\n') {
        end--;
        if (end > 0 && markdown[end - 1] === '\r') end--;
    }
    return end;
}

function isTransform(transform) {
    return Boolean(transform)
        && typeof transform === 'object'
        && Number.isSafeInteger(transform.from)
        && Number.isSafeInteger(transform.to)
        && Number.isSafeInteger(transform.replacementLength)
        && transform.from >= 0
        && transform.from <= transform.to
        && transform.replacementLength >= 0;
}

function rangesOverlap(left, right) {
    return left.from < right.to && left.to > right.from;
}

function mapPosition(position, association, transforms) {
    let delta = 0;
    for (const transform of transforms) {
        if (!isTransform(transform)) continue;
        const replacementFrom = transform.from + delta;
        const replacementTo = replacementFrom + transform.replacementLength;
        if (position < transform.from
            || (position === transform.from && association < 0)) {
            return position + delta;
        }
        if (position > transform.to
            || (position === transform.to && association > 0)) {
            delta += transform.replacementLength - (transform.to - transform.from);
            continue;
        }
        return association < 0 ? replacementFrom : replacementTo;
    }
    return position + delta;
}
