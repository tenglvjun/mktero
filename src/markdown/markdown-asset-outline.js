import { normalizeChromeRanges } from './chrome-ranges.js';
import {
    findAcademicFigures,
    findAcademicTableGroups,
} from './markdown-figures.js';

export function extractMarkdownAssetOutline(markdown, chromeRanges = []) {
    const source = String(markdown || '');
    const hidden = normalizeChromeRanges(chromeRanges, source.length);
    const items = [];
    for (const group of findAcademicFigures(source)) {
        const text = assetCaptionText(group.caption);
        if (!text || isHiddenOffset(hidden, group.from)) continue;
        const imageSource = firstLocalImageSource(group);
        items.push({
            type: 'figure',
            text,
            offset: group.from,
            ...(imageSource ? { imageSource } : {}),
        });
    }
    for (const group of findAcademicTableGroups(source)) {
        const text = assetCaptionText(group.caption);
        if (!text || isHiddenOffset(hidden, group.from)) continue;
        const tablePreviewSource = outlineTablePreviewSource(group.table);
        items.push({
            type: 'table',
            text,
            offset: group.from,
            ...(tablePreviewSource ? { tablePreviewSource } : {}),
        });
    }
    items.sort((left, right) => left.offset - right.offset);
    return items;
}

function assetCaptionText(caption) {
    const text = typeof caption === 'string' ? caption : caption?.text;
    return String(text || '').trim();
}

function isHiddenOffset(hidden, offset) {
    return hidden.some(range => range.from <= offset && offset < range.to);
}

function firstLocalImageSource(group) {
    const images = Array.isArray(group?.images) ? group.images : [];
    for (const image of images) {
        const destination = markdownImageDestination(image?.source);
        if (!destination || isRemoteOrAbsolutePath(destination)) continue;
        return destination;
    }
    return '';
}

function markdownImageDestination(source) {
    const match = /^ {0,3}!\[(?:\\.|[^\]\\])*\]\(\s*<?([^)\s>]+)/.exec(
        String(source || '')
    );
    return match?.[1] || '';
}

function isRemoteOrAbsolutePath(destination) {
    return /^[a-z][a-z0-9+.-]*:/i.test(destination)
        || destination.startsWith('/');
}

const MAX_OUTLINE_TABLE_PREVIEW_CHARS = 8_000;
const MAX_OUTLINE_TABLE_PREVIEW_ROWS = 6;

function outlineTablePreviewSource(table) {
    const source = String(table?.source || '').trim();
    if (!source) return '';
    if (table.kind === 'gfm') {
        const clipped = clipGFMTablePreview(source);
        return clipped.length <= MAX_OUTLINE_TABLE_PREVIEW_CHARS ? clipped : '';
    }
    return source.length <= MAX_OUTLINE_TABLE_PREVIEW_CHARS ? source : '';
}

function clipGFMTablePreview(source) {
    const lines = String(source).split(/\n/);
    return lines.slice(0, 2 + MAX_OUTLINE_TABLE_PREVIEW_ROWS).join('\n');
}
