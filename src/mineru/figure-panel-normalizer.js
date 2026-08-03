import {
    describesSharedABFigurePanels,
    findAcademicFigures,
} from '../markdown/markdown-figures.js';
import { isValidSourceMapEntry } from '../core/markdown-source-map.js';

const MIN_VERTICAL_OVERLAP = 0.8;
const MIN_HEIGHT_SIMILARITY = 0.75;
const MAX_HORIZONTAL_OVERLAP = 20;
const MAX_HORIZONTAL_GAP = 60;
const MIN_HORIZONTAL_OVERLAP = 0.8;
const MIN_WIDTH_SIMILARITY = 0.75;
const MAX_VERTICAL_OVERLAP = 20;
const MAX_VERTICAL_GAP = 60;
const MAX_CHARTS_PER_PAGE = 64;
const VERTICAL_AB_PANEL_BLOCK_PATTERN = /^( {0,3}\(\s*a\s*\))[ \t]*(\r?\n)( {0,3}!\[[ \t]*\]\([^\r\n]+\))[ \t]*(\r?\n)( {0,3}\(\s*b\s*\))[ \t]*$/iu;

export function reassembleMinerUFigurePanels(markdown, sourceMap) {
    const source = String(markdown || '');
    if (!source || !Array.isArray(sourceMap)) return source;

    const validEntries = sourceMap
        .filter(entry => isValidSourceMapEntry(entry, source.length))
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
    const charts = validEntries.filter(isSingleLocationChart);
    const chartByRange = new Map(charts.map(chart => [rangeKey(chart), chart]));
    const chartsByPage = groupChartsByPage(charts);
    const standaloneFigures = findAcademicFigures(source).filter(figure => (
        figure.images.length === 1
    ));
    const figures = standaloneFigures.filter(figure => (
        describesSharedABFigurePanels(figure.caption)
    ));
    const captionedCharts = new Set();
    const chartForFigure = new Map();

    for (const figure of standaloneFigures) {
        const chart = chartByRange.get(rangeKey({
            markdownFrom: figure.from,
            markdownTo: figure.to,
        }));
        if (!chart) continue;
        captionedCharts.add(chart);
        if (describesSharedABFigurePanels(figure.caption)) {
            chartForFigure.set(figure, chart);
        }
    }

    const usedCharts = new Set();
    const edits = [];
    for (const figure of figures) {
        const captioned = chartForFigure.get(figure);
        if (!captioned || usedCharts.has(captioned)) continue;
        const pageCharts = chartsByPage.get(captioned.locations[0].pageIndex) || [];
        if (pageCharts.length > MAX_CHARTS_PER_PAGE) continue;
        const candidates = pageCharts
            .filter(candidate => (
                candidate !== captioned
                && !usedCharts.has(candidate)
                && !captionedCharts.has(candidate)
            ))
            .map(candidate => ({
                chart: candidate,
                layout: panelPairLayout(source, captioned, candidate),
            }))
            .filter(candidate => candidate.layout);
        if (candidates.length !== 1) continue;

        const { chart: partner, layout } = candidates[0];
        const placement = interveningContentPlacement(
            source,
            validEntries,
            captioned,
            partner
        );
        if (!placement) continue;

        if (layout === 'vertical') {
            if (placement !== 'none') continue;
            const panelSource = source.slice(
                partner.markdownFrom,
                partner.markdownTo
            );
            const replacement = markVerticalABPanelBlock(panelSource);
            if (!replacement) continue;
            edits.push({
                from: partner.markdownFrom,
                to: partner.markdownTo,
                replacement,
            });
            usedCharts.add(captioned);
            usedCharts.add(partner);
            continue;
        }

        const panels = [captioned, partner].sort(compareHorizontalPosition);
        const anchor = placement === 'below'
            ? earlierMarkdownEntry(captioned, partner)
            : placement === 'above'
                ? laterMarkdownEntry(captioned, partner)
                : captioned;
        const removed = anchor === captioned ? partner : captioned;
        const separator = source.includes('\r\n') ? '\r\n\r\n' : '\n\n';
        const replacement = panels
            .map((panel, index) => {
                const panelSource = source.slice(
                    panel.markdownFrom,
                    panel.markdownTo
                );
                // Preserve separate Markdown blocks while marking bbox-confirmed layout.
                return index < panels.length - 1
                    ? `${panelSource.trimEnd()}  `
                    : panelSource;
            })
            .join(separator);
        const removal = expandedRemovalRange(source, removed);

        edits.push({
            from: anchor.markdownFrom,
            to: anchor.markdownTo,
            replacement,
        }, {
            from: removal.from,
            to: removal.to,
            replacement: '',
        });
        usedCharts.add(captioned);
        usedCharts.add(partner);
    }

    return applyNonOverlappingEdits(source, edits);
}

function panelPairLayout(source, captioned, candidate) {
    if (isHorizontalPanelPair(captioned, candidate)) return 'horizontal';
    if (!isVerticalPanelPair(captioned, candidate)) return null;

    const panels = [captioned, candidate].sort(compareVerticalPosition);
    if (panels[0] !== candidate || panels[1] !== captioned) return null;
    return VERTICAL_AB_PANEL_BLOCK_PATTERN.test(source.slice(
        candidate.markdownFrom,
        candidate.markdownTo
    )) ? 'vertical' : null;
}

function isSingleLocationChart(entry) {
    return entry.type === 'chart' && entry.locations.length === 1;
}

function rangeKey(entry) {
    return `${entry.markdownFrom}:${entry.markdownTo}`;
}

function groupChartsByPage(charts) {
    const grouped = new Map();
    for (const chart of charts) {
        const pageIndex = chart.locations[0].pageIndex;
        const pageCharts = grouped.get(pageIndex) || [];
        pageCharts.push(chart);
        grouped.set(pageIndex, pageCharts);
    }
    return grouped;
}

function isHorizontalPanelPair(left, right) {
    const leftLocation = left.locations[0];
    const rightLocation = right.locations[0];
    if (leftLocation.pageIndex !== rightLocation.pageIndex) return false;

    const leftBox = leftLocation.bbox;
    const rightBox = rightLocation.bbox;
    const leftHeight = leftBox[3] - leftBox[1];
    const rightHeight = rightBox[3] - rightBox[1];
    const overlap = Math.min(leftBox[3], rightBox[3])
        - Math.max(leftBox[1], rightBox[1]);
    if (overlap / Math.min(leftHeight, rightHeight) < MIN_VERTICAL_OVERLAP
        || Math.min(leftHeight, rightHeight) / Math.max(leftHeight, rightHeight)
            < MIN_HEIGHT_SIMILARITY) {
        return false;
    }

    const [firstBox, secondBox] = leftBox[0] <= rightBox[0]
        ? [leftBox, rightBox]
        : [rightBox, leftBox];
    const gap = secondBox[0] - firstBox[2];
    return gap >= -MAX_HORIZONTAL_OVERLAP && gap <= MAX_HORIZONTAL_GAP;
}

function isVerticalPanelPair(top, bottom) {
    const topLocation = top.locations[0];
    const bottomLocation = bottom.locations[0];
    if (topLocation.pageIndex !== bottomLocation.pageIndex) return false;

    const topBox = topLocation.bbox;
    const bottomBox = bottomLocation.bbox;
    const topWidth = topBox[2] - topBox[0];
    const bottomWidth = bottomBox[2] - bottomBox[0];
    const overlap = Math.min(topBox[2], bottomBox[2])
        - Math.max(topBox[0], bottomBox[0]);
    if (overlap / Math.min(topWidth, bottomWidth) < MIN_HORIZONTAL_OVERLAP
        || Math.min(topWidth, bottomWidth) / Math.max(topWidth, bottomWidth)
            < MIN_WIDTH_SIMILARITY) {
        return false;
    }

    const [firstBox, secondBox] = topBox[1] <= bottomBox[1]
        ? [topBox, bottomBox]
        : [bottomBox, topBox];
    const gap = secondBox[1] - firstBox[3];
    return gap >= -MAX_VERTICAL_OVERLAP && gap <= MAX_VERTICAL_GAP;
}

function markVerticalABPanelBlock(source) {
    const match = VERTICAL_AB_PANEL_BLOCK_PATTERN.exec(source);
    if (!match) return null;
    return `${match[1]}   ${match[2]}${match[3]}   ${match[4]}${match[5]}`;
}

function interveningContentPlacement(source, sourceMap, left, right) {
    const first = earlierMarkdownEntry(left, right);
    const second = laterMarkdownEntry(left, right);
    let cursor = first.markdownTo;
    let placement = 'none';
    const panelTop = Math.min(left.locations[0].bbox[1], right.locations[0].bbox[1]);
    const panelBottom = Math.max(left.locations[0].bbox[3], right.locations[0].bbox[3]);
    const pageIndex = left.locations[0].pageIndex;

    for (let index = firstEntryEndingAfter(sourceMap, first.markdownTo);
        index < sourceMap.length;
        index++) {
        const entry = sourceMap[index];
        if (entry.markdownFrom >= second.markdownFrom) break;
        if (entry.markdownFrom < first.markdownTo
            || entry.markdownTo > second.markdownFrom) {
            return null;
        }
        if (source.slice(cursor, entry.markdownFrom).trim()) return null;
        if (entry.type !== 'text' || !entry.locations?.length) return null;
        for (const location of entry.locations) {
            if (location.pageIndex !== pageIndex) return null;
            const locationPlacement = location.bbox[3] <= panelTop
                ? 'above'
                : location.bbox[1] >= panelBottom
                    ? 'below'
                    : null;
            if (!locationPlacement
                || (placement !== 'none' && placement !== locationPlacement)) {
                return null;
            }
            placement = locationPlacement;
        }
        cursor = entry.markdownTo;
    }
    if (source.slice(cursor, second.markdownFrom).trim()) return null;
    return placement;
}

function firstEntryEndingAfter(entries, offset) {
    let low = 0;
    let high = entries.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (entries[middle].markdownTo <= offset) low = middle + 1;
        else high = middle;
    }
    return low;
}

function compareHorizontalPosition(left, right) {
    return left.locations[0].bbox[0] - right.locations[0].bbox[0];
}

function compareVerticalPosition(left, right) {
    return left.locations[0].bbox[1] - right.locations[0].bbox[1];
}

function earlierMarkdownEntry(left, right) {
    return left.markdownFrom <= right.markdownFrom ? left : right;
}

function laterMarkdownEntry(left, right) {
    return left.markdownFrom > right.markdownFrom ? left : right;
}

function expandedRemovalRange(source, entry) {
    const followingSeparator = /^\r?\n[ \t]*\r?\n/.exec(
        source.slice(entry.markdownTo)
    );
    if (followingSeparator) {
        return {
            from: entry.markdownFrom,
            to: entry.markdownTo + followingSeparator[0].length,
        };
    }
    const precedingSeparator = /(?:\r?\n[ \t]*){2}$/.exec(
        source.slice(0, entry.markdownFrom)
    );
    return {
        from: entry.markdownFrom - (precedingSeparator?.[0].length || 0),
        to: entry.markdownTo,
    };
}

function applyNonOverlappingEdits(source, edits) {
    const sorted = [...edits].sort((left, right) => right.from - left.from);
    let result = source;
    let lastFrom = source.length + 1;
    for (const edit of sorted) {
        if (edit.to > lastFrom) continue;
        result = result.slice(0, edit.from)
            + edit.replacement
            + result.slice(edit.to);
        lastFrom = edit.from;
    }
    return result;
}
