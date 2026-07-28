const ALGORITHM_CLASS = 'mineru-algorithm';
const CLOSING_DIV_PATTERN = /^ {0,3}<\/div>[ \t]*$/i;

export function findMinerUAlgorithmGroups(markdown) {
    const source = String(markdown || '');
    const lines = markdownLineRecords(source);
    const blockedLines = findFencedCodeLines(lines);
    const groups = [];

    for (let index = 0; index < lines.length; index++) {
        if (blockedLines.has(index)
            || !isMinerUAlgorithmOpening(lines[index].text)) {
            continue;
        }

        let closingIndex = -1;
        for (let candidate = index + 1; candidate < lines.length; candidate++) {
            if (blockedLines.has(candidate)) continue;
            if (parseDivOpeningAttributes(lines[candidate].text) !== null) {
                break;
            }
            if (CLOSING_DIV_PATTERN.test(lines[candidate].text)) {
                closingIndex = candidate;
                break;
            }
        }
        if (closingIndex < 0) continue;

        const contentFrom = lines[index].from + lines[index].raw.length;
        const contentTo = lines[closingIndex].from;
        groups.push({
            from: lines[index].from,
            to: lines[closingIndex].to,
            contentFrom,
            contentTo,
            content: source.slice(contentFrom, contentTo),
        });
        index = closingIndex;
    }

    return groups;
}

export function stripMinerUAlgorithmWrappers(markdown) {
    const source = String(markdown || '');
    const groups = findMinerUAlgorithmGroups(source);
    if (!groups.length) return source;

    let output = '';
    let sourceIndex = 0;
    for (const group of groups) {
        output += source.slice(sourceIndex, group.from);
        output += group.content;
        sourceIndex = group.to;
    }
    return output + source.slice(sourceIndex);
}

function isMinerUAlgorithmOpening(line) {
    const attributes = parseDivOpeningAttributes(line);
    if (attributes === null) return false;
    for (const match of attributes.matchAll(
        /(?:^|[ \t])class[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)')/giu
    )) {
        const classes = (match[1] || match[2] || '').split(/[ \t\f]+/u);
        if (classes.includes(ALGORITHM_CLASS)) return true;
    }
    return false;
}

function parseDivOpeningAttributes(line) {
    const match = /^ {0,3}<div\b([^>\r\n]*)>[ \t]*$/i.exec(String(line || ''));
    return match ? match[1] : null;
}

function markdownLineRecords(markdown) {
    const rawLines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const lines = [];
    let offset = 0;
    for (const raw of rawLines) {
        const ending = /\r?\n$/.exec(raw)?.[0] || '';
        lines.push({
            raw,
            text: raw.slice(0, raw.length - ending.length),
            from: offset,
            to: offset + raw.length - ending.length,
        });
        offset += raw.length;
    }
    return lines;
}

function findFencedCodeLines(lines) {
    const blocked = new Set();
    let activeFence = null;
    for (const [index, line] of lines.entries()) {
        const fence = markdownFence(line.text);
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
        if (!fence) continue;
        activeFence = fence;
        blocked.add(index);
    }
    return blocked;
}

function markdownFence(line) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(String(line || ''));
    if (!match) return null;
    return {
        character: match[1][0],
        length: match[1].length,
        trailing: match[2],
    };
}
