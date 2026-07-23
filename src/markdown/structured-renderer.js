const DEFAULT_HEADING_LEVEL = 2;

/**
 * Convert Zotero's Structured Document Text tree to Markdown.
 *
 * The renderer deliberately emits a small, predictable Markdown subset. PDF
 * content is untrusted input, so source text is escaped and raw HTML is never
 * copied into the output.
 */
export function renderStructuredDocument(document) {
    if (!document || !Array.isArray(document.content)) {
        throw new TypeError('A structured document with a content array is required');
    }

    const outlineLevels = buildOutlineLevels(document.catalog?.outline);
    const pageMarkers = buildPageMarkers(document.catalog?.pages);
    const output = [];

    document.content.forEach((block, index) => {
        if (pageMarkers.has(index)) {
            output.push(`<!-- zotero-page: ${escapeComment(pageMarkers.get(index))} -->\n\n`);
        }

        output.push(renderBlock(block, {
            path: [index],
            outlineLevels,
        }));
    });

    return normalizeMarkdown(output.join(''));
}

export function renderPlainText(text) {
    if (typeof text !== 'string') {
        throw new TypeError('Plain text must be a string');
    }

    const pages = text.split('\f');
    const output = [];
    pages.forEach((page, index) => {
        if (index > 0) {
            output.push(`<!-- zotero-page: ${index + 1} -->\n\n`);
        }
        const normalized = page.replace(/\r\n?/g, '\n').trim();
        if (normalized) {
            output.push(`${escapeMarkdownText(normalized)}\n\n`);
        }
    });
    return normalizeMarkdown(output.join(''));
}

function renderBlock(block, context) {
    if (!block || block.flowClass === 'excluded') {
        return '';
    }

    switch (block.type) {
        case 'heading': {
            const level = context.outlineLevels.get(context.path.join('.')) ?? DEFAULT_HEADING_LEVEL;
            return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${renderInline(block.content)}\n\n`;
        }
        case 'paragraph':
            return `${renderInline(block.content)}\n\n`;
        case 'blockquote':
            return renderBlockquote(block.content, context);
        case 'list':
            return renderList(block, context);
        case 'table':
            return renderTable(block, context);
        case 'math':
            return renderMathBlock(block.content);
        case 'image': {
            const alt = renderInline(block.content) || 'Figure';
            return `**Figure:** ${alt}\n\n`;
        }
        case 'caption':
            return `*${renderInline(block.content)}*\n\n`;
        case 'note':
            return `> **Note:** ${renderInline(block.content)}\n\n`;
        case 'preformatted':
            return renderFencedCode(block.content);
        default:
            return '';
    }
}

function renderBlockquote(blocks, context) {
    const body = renderBlocks(blocks, context).trim();
    if (!body) return '';
    return `${body.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
}

function renderBlocks(blocks, context) {
    if (!Array.isArray(blocks)) return '';
    return blocks.map((block, index) => renderBlock(block, {
        ...context,
        path: [...context.path, index],
    })).join('');
}

function renderList(block, context) {
    if (!Array.isArray(block.content)) return '';
    const ordered = Boolean(block.ordered);
    const start = Number.isInteger(block.startIndex) ? block.startIndex : 1;
    const lines = [];

    block.content.forEach((item, index) => {
        const marker = ordered ? `${start + index}.` : '-';
        const itemContent = Array.isArray(item.content) ? item.content : [];
        const textNodes = itemContent.length === 0 || itemContent.every(node => node?.text !== undefined);
        const body = textNodes
            ? renderInline(stripExtractedListMarker(itemContent, ordered))
            : renderBlocks(itemContent, { ...context, path: [...context.path, index] }).trim();
        if (!body) return;

        const itemLines = body.split('\n');
        lines.push(`${marker} ${itemLines[0]}`);
        lines.push(...itemLines.slice(1).map(line => `   ${line}`));
    });

    return lines.length ? `${lines.join('\n')}\n\n` : '';
}

function renderTable(block, context) {
    const rows = (block.content || []).filter(row => row?.type === 'tablerow');
    if (!rows.length) {
        const fallback = renderInline(block.content).trim();
        return fallback ? `${fallback}\n\n` : '';
    }

    const renderedRows = rows.map(row => (row.content || [])
        .filter(cell => cell?.type === 'tablecell')
        .map(cell => renderTableCell(cell, context)));
    const width = Math.max(1, ...renderedRows.map(row => row.length));
    renderedRows.forEach(row => {
        while (row.length < width) row.push('');
    });

    const header = renderedRows[0];
    const separator = header.map(() => '---');
    const lines = [formatTableRow(header), formatTableRow(separator)];
    lines.push(...renderedRows.slice(1).map(formatTableRow));
    return `${lines.join('\n')}\n\n`;
}

function renderTableCell(cell, context) {
    const body = renderBlocks(cell.content, context).trim();
    return body.replace(/\s*\n\s*/g, '<br>').replace(/\|/g, '\\|');
}

function formatTableRow(cells) {
    return `| ${cells.join(' | ')} |`;
}

function renderInline(nodes) {
    if (!Array.isArray(nodes)) return '';
    return nodes.map(node => {
        if (!node || typeof node.text !== 'string') return '';
        const text = escapeMarkdownText(node.text);
        const style = node.style || {};
        let result = text;
        if (style.monospace) result = wrapCode(result);
        if (style.bold) result = `**${result}**`;
        if (style.italic) result = `*${result}*`;
        if (style.sup) result = `<sup>${result}</sup>`;
        if (style.sub) result = `<sub>${result}</sub>`;
        return result;
    }).join('');
}

function renderVerbatimText(nodes) {
    if (!Array.isArray(nodes)) return '';
    return nodes
        .map(node => typeof node?.text === 'string' ? node.text : '')
        .join('')
        .replace(/\r\n?/g, '\n');
}

function renderFencedCode(nodes) {
    const body = renderVerbatimText(nodes);
    const longestRun = Math.max(0, ...Array.from(body.matchAll(/`+/g), match => match[0].length));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    const closingBreak = body.endsWith('\n') ? '' : '\n';
    return `${fence}\n${body}${closingBreak}${fence}\n\n`;
}

function renderMathBlock(nodes) {
    const body = renderVerbatimText(nodes);
    const collidesWithDelimiter = /^\s*\$\$\s*$/m.test(body);
    const containsHTMLTag = /<\/?[a-z][^>]*>/i.test(body);
    if (collidesWithDelimiter || containsHTMLTag) {
        return renderFencedCode(nodes);
    }
    return `$$\n${body}\n$$\n\n`;
}

function stripExtractedListMarker(nodes, ordered) {
    if (!nodes.length) return nodes;

    const result = nodes.map(node => ({ ...node }));
    const first = result[0];
    const exactMarker = ordered ? /^\s*\d+[.)]\s*$/ : /^\s*[-+*•◦▪‣]\s*$/;
    const leadingMarker = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-+*•◦▪‣]\s+/;

    if (exactMarker.test(first.text)) {
        result.shift();
        while (result.length && /^\s*$/.test(result[0].text)) result.shift();
        if (result.length) result[0].text = result[0].text.trimStart();
    }
    else if (leadingMarker.test(first.text)) {
        first.text = first.text.replace(leadingMarker, '');
    }

    return result;
}

function wrapCode(text) {
    const fence = text.includes('`') ? '``' : '`';
    return `${fence} ${text.trim()} ${fence}`;
}

function buildOutlineLevels(outline, level = 1, result = new Map()) {
    if (!Array.isArray(outline)) return result;
    outline.forEach(item => {
        if (Array.isArray(item?.ref) && item.ref.length) {
            result.set(item.ref.join('.'), level);
        }
        buildOutlineLevels(item?.children, level + 1, result);
    });
    return result;
}

function buildPageMarkers(pages) {
    const result = new Map();
    if (!Array.isArray(pages)) return result;
    pages.forEach((page, index) => {
        const boundary = page?.contentRange?.[0];
        if (Array.isArray(boundary) && Number.isInteger(boundary[0]) && !result.has(boundary[0])) {
            result.set(boundary[0], page.label ?? index + 1);
        }
    });
    return result;
}

function escapeMarkdownText(text) {
    return text
        .replace(/\\/g, '\\\\')
        .replace(/([#`*_[\]<>])/g, '\\$1')
        .replace(/\n{3,}/g, '\n\n');
}

function escapeComment(value) {
    return String(value).replace(/--/g, '—');
}

function normalizeMarkdown(markdown) {
    return markdown
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
