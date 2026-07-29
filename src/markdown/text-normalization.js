export function normalizeText(text) {
    return String(text)
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function createNormalizedTextIndex(
    text,
    sourceOffsetAt = offset => offset
) {
    const output = [];
    const sourceStarts = [];
    const sourceEnds = [];
    for (let offset = 0; offset < text.length;) {
        const character = String.fromCodePoint(text.codePointAt(offset));
        const nextOffset = offset + character.length;
        const normalized = character.normalize('NFKC');
        const sourceFrom = sourceOffsetAt(offset);
        const sourceTo = sourceOffsetAt(nextOffset - 1) + 1;
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
