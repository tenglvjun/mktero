export const MAX_CHROME_RANGES = 10_000;
export const MAX_CHROME_RANGES_BYTES = 1024 * 1024;

const BLANK_LINE = /^[ \t]*$/;

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
    let mapped = Array.isArray(ranges)
        ? ranges.map(range => ({ from: range.from, to: range.to }))
        : [];
    for (const transform of steps) {
        if (!isTransform(transform)) continue;
        mapped = mapped
            .filter(range => !rangesOverlap(range, transform))
            .map(range => ({
                from: mapPosition(range.from, -1, transform),
                to: mapPosition(range.to, 1, transform),
            }));
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

function mapPosition(position, association, transform) {
    if (position < transform.from
        || (position === transform.from && association < 0)) {
        return position;
    }
    if (position > transform.to
        || (position === transform.to && association > 0)) {
        return position + transform.replacementLength - (transform.to - transform.from);
    }
    return association < 0
        ? transform.from
        : transform.from + transform.replacementLength;
}
