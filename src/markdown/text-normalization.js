const NUMERIC_CITATION_CONTENT = /^\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,，;；]\s*\d+(?:\s*[-–—]\s*\d+)?)*$/u;

export function isNumericCitationContent(text) {
    return NUMERIC_CITATION_CONTENT.test(text);
}

export function normalizeText(text) {
    return String(text)
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function createNormalizedTextIndex(
    text,
    sourceOffsetAt = offset => offset,
    normalizeCharacter = character => character.normalize('NFKC')
) {
    const output = [];
    const sourceStarts = [];
    const sourceEnds = [];
    for (let offset = 0; offset < text.length;) {
        const character = String.fromCodePoint(text.codePointAt(offset));
        const nextOffset = offset + character.length;
        const result = normalizeCharacter(character, offset, text);
        const normalized = typeof result === 'string' ? result : result.text;
        const normalizedSourceFrom = typeof result === 'string'
            ? offset
            : result.sourceFrom;
        const normalizedSourceTo = typeof result === 'string'
            ? nextOffset
            : result.sourceTo;
        const sourceFrom = sourceOffsetAt(normalizedSourceFrom);
        const sourceTo = sourceOffsetAt(normalizedSourceTo - 1) + 1;
        if (/^\s+$/u.test(normalized)) {
            if (output.at(-1) === ' ') {
                sourceEnds[sourceEnds.length - 1] = sourceTo;
            }
            else {
                output.push(' ');
                sourceStarts.push(sourceFrom);
                sourceEnds.push(sourceTo);
            }
        }
        else {
            for (const unit of normalized) {
                output.push(unit);
                sourceStarts.push(sourceFrom);
                sourceEnds.push(sourceTo);
            }
        }
        offset = nextOffset;
    }
    return {
        text: output.join(''),
        sourceRange(from, length) {
            return {
                from: sourceStarts[from],
                to: sourceEnds[from + length - 1],
            };
        },
    };
}

export function findTextOccurrences(source, target, limit = 10_000) {
    if (!target || !Number.isInteger(limit) || limit <= 0) {
        return { offsets: [], truncated: false };
    }
    const offsets = [];
    let from = 0;
    const step = Math.max(1, target.length);
    while (from <= source.length - target.length) {
        const index = source.indexOf(target, from);
        if (index < 0) break;
        offsets.push(index);
        from = index + step;
        if (offsets.length === limit) {
            return {
                offsets,
                truncated: source.indexOf(target, from) >= 0,
            };
        }
    }
    return { offsets, truncated: false };
}
