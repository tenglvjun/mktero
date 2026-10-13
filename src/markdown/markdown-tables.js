export function parseGFMTableRow(line) {
    let source = String(line || '').trim();
    if (!source.includes('|')) return [];
    if (source.startsWith('|')) source = source.slice(1);
    if (source.endsWith('|') && !source.endsWith('\\|')) {
        source = source.slice(0, -1);
    }

    const cells = [];
    let cell = '';
    for (let index = 0; index < source.length; index++) {
        if (source[index] === '\\' && source[index + 1] === '|') {
            cell += '|';
            index++;
        }
        else if (source[index] === '|') {
            cells.push(cell.trim());
            cell = '';
        }
        else {
            cell += source[index];
        }
    }
    cells.push(cell.trim());
    return cells;
}

/**
 * Parse a GFM table block into its rows, alignment, and the source range of
 * every cell.
 *
 * The cell ranges index into the table source, so a caller that already holds
 * a visible-text index for that source can read any cell without parsing the
 * Markdown again. Ragged rows are padded to the header width, matching how the
 * table renders.
 *
 * Returns null when the block is not a table: fewer than two lines, no header
 * cells, or a separator row that is not made of `---` cells with the header's
 * width.
 */
export function parseGFMTable(source) {
    const value = String(source);
    const trimmed = value.trim();
    const sourceOffset = value.indexOf(trimmed);
    const lines = tableSourceLines(trimmed, sourceOffset);
    if (lines.length < 2) return null;
    const header = parseGFMTableRow(lines[0].text);
    const separator = parseGFMTableRow(lines[1].text);
    if (!header.length || separator.length !== header.length) return null;
    const alignment = separator.map(cell => {
        const value = cell.trim();
        if (!/^:?-{3,}:?$/.test(value)) return null;
        if (value.startsWith(':') && value.endsWith(':')) return 'center';
        if (value.endsWith(':')) return 'right';
        if (value.startsWith(':')) return 'left';
        return 'none';
    });
    if (alignment.includes(null)) return null;
    const headerRanges = tableRowCellRanges(lines[0]);
    const bodyRanges = [];
    const body = lines.slice(2).map(line => {
        const row = parseGFMTableRow(line.text);
        const ranges = tableRowCellRanges(line);
        while (row.length < header.length) row.push('');
        while (ranges.length < header.length) ranges.push(null);
        bodyRanges.push(ranges.slice(0, header.length));
        return row.slice(0, header.length);
    });
    return {
        header,
        alignment,
        body,
        cellRanges: [
            ...headerRanges.slice(0, header.length),
            ...bodyRanges.flat(),
        ],
    };
}

function tableSourceLines(source, sourceOffset) {
    const lines = [];
    let from = 0;
    while (from < source.length) {
        const newline = source.indexOf('\n', from);
        const rawTo = newline === -1 ? source.length : newline;
        const to = rawTo > from && source[rawTo - 1] === '\r'
            ? rawTo - 1
            : rawTo;
        lines.push({
            text: source.slice(from, to),
            from: sourceOffset + from,
        });
        if (newline === -1) break;
        from = newline + 1;
    }
    return lines;
}

function tableRowCellRanges(line) {
    const leadingWhitespace = line.text.match(/^\s*/)?.[0].length || 0;
    const trailingWhitespace = line.text.match(/\s*$/)?.[0].length || 0;
    const trimmedTo = line.text.length - trailingWhitespace;
    const source = line.text.slice(leadingWhitespace, trimmedTo);
    if (!source.includes('|')) return [];
    let from = source.startsWith('|') ? 1 : 0;
    let to = source.length;
    if (source.endsWith('|') && !source.endsWith('\\|')) to--;
    const ranges = [];
    let cellFrom = from;
    for (let index = from; index < to; index++) {
        if (source[index] === '\\' && source[index + 1] === '|') {
            index++;
            continue;
        }
        if (source[index] !== '|') continue;
        ranges.push({
            from: line.from + leadingWhitespace + cellFrom,
            to: line.from + leadingWhitespace + index,
        });
        cellFrom = index + 1;
    }
    ranges.push({
        from: line.from + leadingWhitespace + cellFrom,
        to: line.from + leadingWhitespace + to,
    });
    return ranges;
}
