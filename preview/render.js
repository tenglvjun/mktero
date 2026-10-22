// Canvas drawing for the browser preview: the figure asset, the simulated PDF
// pages that stand in for Zotero's PDF reader, and the page thumbnail the
// reader's source peek shows.
import {
    codeLines,
    FIGURE_DATA,
    MONO,
    PAGE_HEIGHT,
    PAGE_MARGIN_BOTTOM,
    PAGE_MARGIN_TOP,
    PAGE_MARGIN_X,
    PAGE_STYLES,
    PAGE_WIDTH,
    SERIF,
    tableRows,
} from './document.js';

const INK = '#1d1f22';
const MUTED = '#5d636b';

export function fontFor(style, scale = 1) {
    const italic = style.style === 'italic' ? 'italic ' : '';
    return `${italic}${style.weight || 400} ${style.size * scale}px ${style.font}`;
}

export function createTextMeasure(document) {
    const context = document.createElement('canvas').getContext('2d');
    return (text, style) => {
        context.font = fontFor(style);
        return context.measureText(text).width;
    };
}

// The figure is drawn at runtime instead of shipping a binary fixture.
export async function createFigureAsset(document, { width = 1200 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.round(width * PAGE_STYLES.figure.aspect);
    drawFigure(canvas.getContext('2d'), 0, 0, canvas.width, canvas.height, canvas.width / 300);
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(value => (value ? resolve(value) : reject(new Error('Figure encoding failed'))), 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
}

export function drawFigure(context, x, y, width, height, unit) {
    const { categories, series, maxValue } = FIGURE_DATA;
    context.save();
    context.translate(x, y);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    const left = 26 * unit;
    const right = width - 8 * unit;
    const top = 22 * unit;
    const bottom = height - 30 * unit;
    context.font = `${7 * unit}px ${SERIF}`;
    context.textBaseline = 'middle';
    for (let value = 0; value <= maxValue; value += 10) {
        const lineY = bottom - (bottom - top) * value / maxValue;
        context.strokeStyle = value ? '#e3e6ea' : '#9aa1a9';
        context.lineWidth = Math.max(1, unit * 0.5);
        context.beginPath();
        context.moveTo(left, lineY);
        context.lineTo(right, lineY);
        context.stroke();
        context.fillStyle = MUTED;
        context.textAlign = 'right';
        context.fillText(`${value}%`, left - 4 * unit, lineY);
    }
    const group = (right - left) / categories.length;
    const bar = group * 0.22;
    categories.forEach((category, index) => {
        const start = left + group * index + (group - bar * series.length) / 2;
        series.forEach((entry, seriesIndex) => {
            const value = entry.values[index];
            const barHeight = (bottom - top) * value / maxValue;
            context.fillStyle = entry.color;
            context.fillRect(start + seriesIndex * bar, bottom - barHeight, bar * 0.9, barHeight);
        });
        context.fillStyle = INK;
        context.textAlign = 'center';
        context.textBaseline = 'top';
        const words = category.split(' ');
        const center = left + group * index + group / 2;
        context.fillText(words[0], center, bottom + 4 * unit);
        if (words[1]) context.fillText(words.slice(1).join(' '), center, bottom + 12 * unit);
        context.textBaseline = 'middle';
    });
    let legendX = left;
    context.textAlign = 'left';
    for (const entry of series) {
        context.fillStyle = entry.color;
        context.fillRect(legendX, 8 * unit, 7 * unit, 7 * unit);
        context.fillStyle = INK;
        context.fillText(entry.label, legendX + 10 * unit, 11.5 * unit);
        legendX += context.measureText(entry.label).width + 22 * unit;
    }
    context.restore();
}

// Draw one simulated PDF page. `scale` maps PDF points to canvas pixels.
// `annotations` are { ranges, color, type } in Markdown offsets; they are drawn
// over the words they cover, the way Zotero paints PDF annotations.
export function drawPage(canvas, page, { segments, scale, runningTitle, annotations = [], figureImage = null }) {
    const context = canvas.getContext('2d');
    canvas.width = Math.round(PAGE_WIDTH * scale);
    canvas.height = Math.round(PAGE_HEIGHT * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    context.textBaseline = 'alphabetic';

    context.fillStyle = MUTED;
    context.font = `italic 7.5px ${SERIF}`;
    context.textAlign = 'left';
    if (page.index > 0) context.fillText(runningTitle, PAGE_MARGIN_X, PAGE_MARGIN_TOP - 26);
    context.textAlign = 'center';
    context.font = `8px ${SERIF}`;
    context.fillText(String(page.index + 1), PAGE_WIDTH / 2, PAGE_HEIGHT - PAGE_MARGIN_BOTTOM + 34);
    if (page.index === 0) {
        context.textAlign = 'left';
        context.font = `italic 7px ${SERIF}`;
        context.fillText('Preprint sample · illustrative data', PAGE_MARGIN_X, PAGE_HEIGHT - PAGE_MARGIN_BOTTOM + 34);
    }
    if (Number.isFinite(page.rule)) {
        context.strokeStyle = '#b9bec5';
        context.lineWidth = 0.6;
        context.beginPath();
        context.moveTo(PAGE_MARGIN_X, page.rule);
        context.lineTo(PAGE_WIDTH - PAGE_MARGIN_X, page.rule);
        context.stroke();
    }

    for (const item of page.items) {
        const segment = segments[item.segment];
        const style = PAGE_STYLES[item.kind] || PAGE_STYLES.paragraph;
        if (item.kind === 'figure') {
            if (figureImage) context.drawImage(figureImage, item.x, item.y, item.width, item.height);
            else drawFigure(context, item.x, item.y, item.width, item.height, item.width / 300);
            continue;
        }
        if (item.kind === 'table') {
            drawTable(context, item, segment, style);
            continue;
        }
        if (item.kind === 'code') {
            drawCode(context, item, segment, style);
            continue;
        }
        drawTextItem(context, item, segment, style, annotations);
    }
}

function drawTextItem(context, item, segment, style, annotations) {
    context.font = fontFor(style);
    context.fillStyle = INK;
    const baseline = style.line * 0.78;
    const hanging = style.hanging || 0;
    const lineMarks = annotationLineMarks(item, segment, annotations, context);
    item.lines.forEach((line, index) => {
        const y = item.y + index * style.line;
        const indent = index > 0 ? hanging : 0;
        const available = item.width - indent;
        const last = index === item.lines.length - 1 && !item.continued;
        for (const mark of lineMarks.filter(value => value.line === index)) {
            context.fillStyle = mark.color;
            if (mark.type === 'underline') {
                context.fillRect(item.x + indent + mark.from, y + style.line * 0.92, mark.to - mark.from, 0.9);
            }
            else {
                context.globalAlpha = 0.42;
                context.fillRect(item.x + indent + mark.from, y + 0.6, mark.to - mark.from, style.line - 0.6);
                context.globalAlpha = 1;
            }
        }
        context.fillStyle = INK;
        if (item.kind === 'caption' && index === 0) {
            const label = line.match(/^(?:Table|Figure) \d+\./)?.[0];
            if (label) {
                const bold = { ...style, weight: 700 };
                context.font = fontFor(bold);
                context.textAlign = 'left';
                context.fillText(label, item.x, y + baseline);
                const offset = context.measureText(`${label} `).width;
                context.font = fontFor(style);
                context.fillText(line.slice(label.length + 1), item.x + offset, y + baseline);
                return;
            }
        }
        if (style.align === 'center') {
            context.textAlign = 'center';
            context.fillText(line, item.x + item.width / 2, y + baseline);
            return;
        }
        context.textAlign = 'left';
        if (style.align === 'justify' && !last) {
            fillJustified(context, line, item.x + indent, y + baseline, available);
        }
        else {
            context.fillText(line, item.x + indent, y + baseline);
        }
    });
    if (item.kind === 'math') {
        context.font = fontFor({ ...style, style: 'normal' });
        context.textAlign = 'right';
        context.fillText('(1)', item.x + item.width, item.y + baseline);
    }
}

function fillJustified(context, line, x, y, width) {
    const words = line.split(' ');
    const natural = context.measureText(line).width;
    const gaps = words.length - 1;
    const extra = gaps > 0 ? (width - natural) / gaps : 0;
    if (gaps <= 0 || extra > 6) {
        context.fillText(line, x, y);
        return;
    }
    const space = context.measureText(' ').width + extra;
    let cursor = x;
    for (const word of words) {
        context.fillText(word, cursor, y);
        cursor += context.measureText(word).width + space;
    }
}

// Horizontal extents, per wrapped line, of the words an annotation covers.
// Line text is plain text, so Markdown offsets are mapped by matching the
// annotation text inside the joined line text.
function annotationLineMarks(item, segment, annotations, context) {
    if (!annotations.length) return [];
    const marks = [];
    const joined = item.lines.join(' ');
    for (const annotation of annotations) {
        const start = joined.indexOf(annotation.text);
        if (start < 0) continue;
        const end = start + annotation.text.length;
        let lineStart = 0;
        item.lines.forEach((line, index) => {
            const lineEnd = lineStart + line.length;
            const from = Math.max(start, lineStart);
            const to = Math.min(end, lineEnd);
            if (from < to) {
                marks.push({
                    line: index,
                    from: context.measureText(line.slice(0, from - lineStart)).width,
                    to: context.measureText(line.slice(0, to - lineStart)).width,
                    color: annotation.color,
                    type: annotation.type,
                });
            }
            lineStart = lineEnd + 1;
        });
    }
    return marks;
}

function drawTable(context, item, segment, style) {
    const rows = tableRows(segment);
    const widths = [0.32, 0.2, 0.25, 0.23].map(value => value * item.width);
    const top = item.y + 2;
    context.strokeStyle = INK;
    context.lineWidth = 0.9;
    const rule = (y, lineWidth) => {
        context.lineWidth = lineWidth;
        context.beginPath();
        context.moveTo(item.x, y);
        context.lineTo(item.x + item.width, y);
        context.stroke();
    };
    rule(top, 0.9);
    rows.forEach((row, rowIndex) => {
        const y = top + rowIndex * style.line;
        let x = item.x;
        const header = rowIndex === 0;
        context.font = fontFor({
            ...style,
            size: header ? style.size * 0.86 : style.size,
            weight: header || rowIndex === rows.length - 1 ? 700 : 400,
        });
        context.fillStyle = INK;
        row.forEach((cell, cellIndex) => {
            context.textAlign = cellIndex === 0 ? 'left' : 'right';
            const textX = cellIndex === 0 ? x + 2 : x + widths[cellIndex] - 2;
            context.fillText(cell, textX, y + style.line * 0.72);
            x += widths[cellIndex];
        });
        if (rowIndex === 0) rule(y + style.line, 0.5);
    });
    rule(top + rows.length * style.line, 0.9);
}

function drawCode(context, item, segment, style) {
    context.fillStyle = '#f3f4f6';
    context.fillRect(item.x, item.y, item.width, item.height);
    context.save();
    context.beginPath();
    context.rect(item.x, item.y, item.width, item.height);
    context.clip();
    context.font = `${style.size}px ${MONO}`;
    context.fillStyle = '#2a2f36';
    context.textAlign = 'left';
    codeLines(segment).forEach((line, index) => {
        context.fillText(line, item.x + style.padding, item.y + style.padding + (index + 0.8) * style.line);
    });
    context.restore();
}

// The reader's source peek shows a small page thumbnail; production encodes a
// downscaled copy of the PDF reader's page canvas the same way.
export function renderPageThumbnail(page, options, { createCanvas, maxWidth = 160, maxHeight = 220 }) {
    const scale = Math.min(maxWidth / PAGE_WIDTH, maxHeight / PAGE_HEIGHT) * 2;
    const canvas = createCanvas(1, 1);
    drawPage(canvas, page, { ...options, scale });
    return canvas.toDataURL('image/jpeg', 0.86);
}
