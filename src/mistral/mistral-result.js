import { createMarkdownSourceMap } from '../core/markdown-source-map.js';
import {
    normalizeMistralFigureLayouts,
    normalizeMistralMarkdown,
} from './markdown-normalizer.js';

export const DEFAULT_MAX_MISTRAL_PAGES = 1_000;
export const DEFAULT_MAX_MISTRAL_MARKDOWN_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_MISTRAL_BLOCKS = 100_000;
export const DEFAULT_MAX_MISTRAL_ASSETS = 2_000;
export const DEFAULT_MAX_MISTRAL_ASSET_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_MISTRAL_TOTAL_ASSET_BYTES = 150 * 1024 * 1024;
export const DEFAULT_MAX_MISTRAL_SOURCE_LOCATIONS = 100_000;

const IMAGE_MIME_TYPES = new Map([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
]);

const BLOCK_TYPES = new Map([
    ['text', 'text'],
    ['paragraph', 'text'],
    ['heading', 'heading'],
    ['title', 'heading'],
    ['list', 'list'],
    ['table', 'table'],
    ['image', 'image'],
    ['picture', 'image'],
    ['figure', 'image'],
    ['chart', 'chart'],
    ['equation', 'equation'],
    ['formula', 'equation'],
    ['caption', 'caption'],
    ['code', 'code'],
    ['reference', 'reference'],
    ['bibliography', 'reference'],
    ['references', 'reference'],
    ['aside_text', 'text'],
    ['signature', 'text'],
    ['header', 'header'],
    ['footer', 'footer'],
]);

const MISTRAL_COLUMN_TOP_THRESHOLD = 240;
const MISTRAL_COLUMN_BOTTOM_THRESHOLD = 760;
const MISTRAL_MIN_COLUMN_GAP = 20;
const MISTRAL_SENTENCE_END_PATTERN = /[.!?。！？]["'”’»)]*$/u;
const MISTRAL_NON_PROSE_START_PATTERN = /^(?:#{1,6}(?:\s|$)|(?:[-+*]|\d+[.)])\s+|>\s|```|~~~|<|\|)/u;

/**
 * Convert a Mistral OCR response into the document shape consumed by Mktero.
 * Mistral pages are deliberately kept in API reading order; MinerU's layout
 * reassembly must never be applied to this result.
 */
export function normalizeMistralResult(response, options = {}) {
    const limits = normalizeLimits(options);
    const pages = validatePages(response, limits.maxPages);
    const pageRecords = pages
        .slice()
        .sort((left, right) => left.index - right.index);

    const warnings = [];
    const usedPaths = new Set();
    const pageAssets = new Map();
    const pageTables = new Map();
    const pageBlockRecords = new Map();
    const tableBudget = { count: 0, bytes: 0 };
    const assets = [];
    let totalAssetBytes = 0;

    for (const page of pageRecords) {
        const pageMap = new Map();
        pageAssets.set(page.index, pageMap);
        const imageList = page.images;
        if (imageList !== undefined && !Array.isArray(imageList)) {
            throw invalidResult('Mistral page images must be an array');
        }
        for (const image of imageList || []) {
            if (!image || typeof image !== 'object' || Array.isArray(image)) {
                throw invalidResult('Mistral image metadata is invalid');
            }
            const id = normalizeAssetPath(image.id);
            if (pageMap.has(id)) {
                throw invalidResult('Mistral page contains duplicate image IDs');
            }
            let path = id;
            if (usedPaths.has(path)) {
                path = `pages/${page.index}/${id}`;
                if (usedPaths.has(path)) {
                    throw invalidResult('Mistral image paths are ambiguous');
                }
            }
            if (assets.length >= limits.maxAssets
                || totalAssetBytes >= limits.maxTotalAssetBytes) {
                throw invalidResult('Mistral images exceed the configured resource limit');
            }
            const decoded = decodeImage(
                image.image_base64 ?? image.imageBase64 ?? image.data,
                image.mime_type ?? image.mimeType ?? image.content_type,
                path,
                Math.min(
                    limits.maxAssetBytes,
                    limits.maxTotalAssetBytes - totalAssetBytes
                )
            );
            totalAssetBytes += decoded.data.length;
            if (totalAssetBytes > limits.maxTotalAssetBytes) {
                throw invalidResult('Mistral images exceed the configured resource limit');
            }
            usedPaths.add(path);
            pageMap.set(id, path);
            pageMap.set(decoded.source, path);
            assets.push({
                path,
                mimeType: decoded.mimeType,
                data: decoded.data,
            });
        }
    }

    const pageSources = pageRecords.map(page => {
        if (typeof page.markdown !== 'string') {
            throw invalidResult('Mistral page Markdown is invalid');
        }
        const tables = normalizePageTables(page, warnings, limits, tableBudget);
        pageTables.set(page.index, tables);
        const dimensions = normalizeDimensions(page.dimensions);
        const records = normalizePageBlockRecords(
            page,
            dimensions,
            pageAssets.get(page.index),
            tables,
            warnings
        );
        appendImageMetadataRecords(
            records,
            page,
            dimensions,
            pageAssets.get(page.index)
        );
        const interiorTextRecords = findImageInteriorTextRecords(records);
        const blockRecord = {
            records,
            interiorTextRecords,
            chromeRecords: new Set(),
        };
        pageBlockRecords.set(page.index, blockRecord);
        let source = removeImageInteriorText(
            page.markdown.replace(/\r\n?/g, '\n').trim(),
            interiorTextRecords
        );
        source = normalizeMistralMarkdown(
            source,
            {
                tables,
                onMissingTable: reference => warnings.push(
                    `Mistral table reference "${reference}" on page ${page.index} has no table content.`
                ),
            }
        );
        source = rewriteMarkdownImages(source, pageAssets.get(page.index));
        return { page, source, records };
    });
    const repeatedChromeLines = findRepeatedPageChromeLines(pageSources);
    const markdownPages = pageSources.map(({ page, source, records }) => {
        const cleaned = removeMistralPageChrome(
            source,
            page.index,
            records,
            repeatedChromeLines
        );
        pageBlockRecords.get(page.index).chromeRecords = cleaned.chromeRecords;
        return {
            markdown: normalizeMistralFigureLayouts(
                cleaned.markdown,
                records
                    .map(record => record.normalized)
                    .filter(block => block?.type === 'image' || block?.type === 'chart')
            ),
            records,
        };
    });
    const combinedMarkdown = markdownPages
        .map(page => page.markdown)
        .filter(page => page.length > 0)
        .join('\n\n');
    const markdown = normalizeMistralTextFlow(
        combinedMarkdown,
        markdownPages.flatMap(page => page.records)
    );
    if (!markdown.trim()) throw invalidResult('Mistral result contains no Markdown');
    if (new TextEncoder().encode(markdown).length > limits.maxMarkdownBytes) {
        throw invalidResult('Mistral Markdown exceeds the configured resource limit');
    }

    const contentList = [];
    for (const page of pageRecords) {
        const blockRecords = pageBlockRecords.get(page.index);
        for (const record of blockRecords?.records || []) {
            if (contentList.length >= limits.maxBlocks) {
                throw invalidResult('Mistral blocks exceed the configured resource limit');
            }
            if (!record.normalized
                || blockRecords.interiorTextRecords.has(record)
                || blockRecords.chromeRecords?.has(record)
                || ['header', 'footer'].includes(record.normalized.type)) {
                continue;
            }
            contentList.push(record.normalized);
        }
    }

    let sourceMap = createMarkdownSourceMap(
        markdown,
        contentList,
        {
            includeMatchedTextRanges: true,
            maxContentBlocks: limits.maxBlocks,
        }
    );
    sourceMap = limitSourceMap(sourceMap, limits.maxSourceLocations);
    const totalPages = Number.isSafeInteger(response?.usage_info?.pages_processed)
        && response.usage_info.pages_processed >= 0
        ? response.usage_info.pages_processed
        : pageRecords.length;
    return {
        markdown,
        assets,
        assetBasePath: '',
        contentList,
        sourceMap,
        extractedPages: pageRecords.length,
        totalPages,
        warnings,
    };
}

function validatePages(response, maxPages) {
    if (!response || typeof response !== 'object' || Array.isArray(response)
        || !Array.isArray(response.pages)
        || !response.pages.length
        || response.pages.length > maxPages) {
        throw invalidResult('Mistral OCR pages are invalid');
    }
    const seen = new Set();
    for (const page of response.pages) {
        if (!page || typeof page !== 'object' || Array.isArray(page)
            || !Number.isSafeInteger(page.index)
            || page.index < 0
            || seen.has(page.index)) {
            throw invalidResult('Mistral page indexes are invalid');
        }
        seen.add(page.index);
    }
    return response.pages;
}

function normalizeLimits(options) {
    return {
        maxPages: boundedLimit(
            options.maxPages,
            DEFAULT_MAX_MISTRAL_PAGES
        ),
        maxMarkdownBytes: boundedLimit(
            options.maxMarkdownBytes,
            DEFAULT_MAX_MISTRAL_MARKDOWN_BYTES
        ),
        maxBlocks: boundedLimit(options.maxBlocks, DEFAULT_MAX_MISTRAL_BLOCKS),
        maxAssets: boundedLimit(options.maxAssets, DEFAULT_MAX_MISTRAL_ASSETS),
        maxAssetBytes: boundedLimit(
            options.maxAssetBytes,
            DEFAULT_MAX_MISTRAL_ASSET_BYTES
        ),
        maxTotalAssetBytes: boundedLimit(
            options.maxTotalAssetBytes,
            DEFAULT_MAX_MISTRAL_TOTAL_ASSET_BYTES
        ),
        maxSourceLocations: boundedLimit(
            options.maxSourceLocations,
            DEFAULT_MAX_MISTRAL_SOURCE_LOCATIONS
        ),
    };
}

function boundedLimit(value, fallback) {
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeDimensions(dimensions) {
    if (!dimensions || typeof dimensions !== 'object') return null;
    const width = dimensions.width;
    const height = dimensions.height;
    return Number.isFinite(width) && width > 0
        && Number.isFinite(height) && height > 0
        ? { width, height }
        : null;
}

function normalizePageTables(page, warnings, limits, budget) {
    const tables = new Map();
    const rawTables = page.tables;
    if (rawTables === undefined) return tables;
    if (!Array.isArray(rawTables)) {
        warnings.push(`Mistral tables on page ${page.index} were skipped.`);
        return tables;
    }
    for (const table of rawTables) {
        budget.count++;
        if (budget.count > limits.maxBlocks) {
            throw invalidResult('Mistral tables exceed the configured resource limit');
        }
        if (!table || typeof table !== 'object' || Array.isArray(table)) {
            warnings.push(`Mistral table on page ${page.index} was skipped.`);
            continue;
        }
        const id = normalizeTableID(table.id);
        if (!id) {
            warnings.push(`Mistral table on page ${page.index} has an invalid ID.`);
            continue;
        }
        const format = table.format ?? table.format_;
        if (format !== undefined
            && (typeof format !== 'string'
                || format.trim().toLowerCase() !== 'markdown')) {
            warnings.push(
                `Mistral table "${table.id}" on page ${page.index}`
                + ' has an unsupported format.'
            );
            continue;
        }
        if (typeof table.content !== 'string' || !table.content.trim()) {
            warnings.push(`Mistral table "${table.id}" on page ${page.index} has no content.`);
            continue;
        }
        if (tables.has(id)) {
            warnings.push(
                `Mistral page ${page.index} contains duplicate table ID`
                + ` "${table.id}".`
            );
            continue;
        }
        const content = table.content.replace(/\r\n?/g, '\n').trim();
        budget.bytes += new TextEncoder().encode(content).length;
        if (budget.bytes > limits.maxMarkdownBytes) {
            throw invalidResult(
                'Mistral table content exceeds the configured resource limit'
            );
        }
        tables.set(id, content);
    }
    return tables;
}

function normalizeTableID(value) {
    if (typeof value !== 'string') return null;
    const source = value.trim();
    if (!source || !/^tbl-[^/\\?#]+(?:\.md)?$/iu.test(source)) return null;
    const id = source.replace(/\.md$/iu, '');
    if (!/^tbl-[^/\\?#]+$/iu.test(id) || /\.md$/iu.test(id)) return null;
    return id.toLowerCase();
}

function normalizePageBlockRecords(
    page,
    dimensions,
    pageMap,
    tables,
    warnings
) {
    const blocks = page.blocks;
    if (blocks !== undefined && !Array.isArray(blocks)) {
        warnings.push(`Mistral blocks on page ${page.index} were skipped.`);
        return [];
    }
    const rawBlocks = [...(blocks || [])];
    // Some API responses expose tables separately from blocks. Include them
    // only as a fallback so that a table can still be source-mapped.
    if (!rawBlocks.length && Array.isArray(page.tables)) {
        rawBlocks.push(...page.tables.map(table => ({
            ...table,
            type: table?.type || 'table',
        })));
    }
    return rawBlocks.map(block => ({
        normalized: normalizeBlock(
            block,
            page,
            dimensions,
            pageMap,
            tables,
            warnings
        ),
    }));
}

function appendImageMetadataRecords(records, page, dimensions, pageMap) {
    if (!dimensions || !Array.isArray(page.images)) return;
    const mappedAssets = new Set(records
        .map(record => record.normalized)
        .filter(block => block?.type === 'image' || block?.type === 'chart')
        .map(block => block.assetPath));
    for (const image of page.images) {
        const assetPath = resolveAssetPath(image?.id, pageMap);
        const bbox = normalizeBBox(
            image?.bbox
                ?? image?.bounding_box
                ?? image?.boundingBox
                ?? image,
            dimensions
        );
        if (!assetPath || !bbox || mappedAssets.has(assetPath)) continue;
        records.push({
            normalized: {
                type: 'image',
                pageIndex: page.index,
                bbox,
                assetPath,
            },
        });
        mappedAssets.add(assetPath);
    }
}

function findImageInteriorTextRecords(records) {
    const imageBlocks = records
        .map(record => record.normalized)
        .filter(block => block?.type === 'image' || block?.type === 'chart');
    if (!imageBlocks.length) return new Set();

    return new Set(records.filter(record => {
        const block = record.normalized;
        if (!block || !block.text || block.type === 'image' || block.type === 'chart') {
            return false;
        }
        return imageBlocks.some(image => (
            image.pageIndex === block.pageIndex
            && isMostlyContainedBBox(block.bbox, image.bbox)
        ));
    }));
}

function isMostlyContainedBBox(inner, outer) {
    const innerArea = bboxArea(inner);
    if (!innerArea) return false;
    const intersection = bboxIntersection(inner, outer);
    if (!intersection) return false;
    return bboxArea(intersection) / innerArea >= 0.8;
}

function bboxArea(bbox) {
    return (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
}

function bboxIntersection(left, right) {
    const intersection = [
        Math.max(left[0], right[0]),
        Math.max(left[1], right[1]),
        Math.min(left[2], right[2]),
        Math.min(left[3], right[3]),
    ];
    return intersection[2] > intersection[0]
        && intersection[3] > intersection[1]
        ? intersection
        : null;
}

function removeImageInteriorText(markdown, records) {
    if (!markdown || !records?.size) return markdown;
    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const candidates = [...records]
        .flatMap(record => splitBlockTextLines(record.normalized?.text));
    if (!candidates.length) return markdown;

    const matches = new Map();
    for (const candidate of candidates) {
        const normalizedCandidate = comparableMarkdownText(candidate);
        if (!normalizedCandidate) continue;
        const matchingIndexes = [];
        for (const [index, line] of lines.entries()) {
            if (comparableMarkdownText(line) === normalizedCandidate) {
                matchingIndexes.push(index);
            }
        }
        // A duplicated label is ambiguous without a text block range. Keep it
        // visible rather than risk removing ordinary prose elsewhere.
        if (matchingIndexes.length === 1) {
            matches.set(matchingIndexes[0], true);
        }
    }
    if (!matches.size) return markdown;
    return lines.filter((line, index) => !matches.has(index)).join('').trim();
}

function findRepeatedPageChromeLines(pageSources) {
    const pagesByText = new Map();
    for (const { page, source } of pageSources) {
        const lines = source.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
        const edgeIndexes = edgeLineIndexes(lines);
        const seenOnPage = new Set();
        for (const index of edgeIndexes) {
            const text = comparableMarkdownText(lines[index]);
            if (!text || !isLikelyPageChromeText(text)) continue;
            seenOnPage.add(text);
        }
        for (const text of seenOnPage) {
            const pages = pagesByText.get(text) || new Set();
            pages.add(page.index);
            pagesByText.set(text, pages);
        }
    }
    return new Set([...pagesByText]
        .filter(([, pages]) => pages.size >= 2)
        .map(([text]) => text));
}

function removeMistralPageChrome(markdown, pageIndex, records, repeatedLines) {
    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const edgeIndexes = edgeLineIndexes(lines);
    const removableIndexes = new Set();
    const lineIndexesByText = new Map();

    for (const [index, line] of lines.entries()) {
        const text = comparableMarkdownText(line);
        if (!text) continue;
        const indexes = lineIndexesByText.get(text) || [];
        indexes.push(index);
        lineIndexesByText.set(text, indexes);
    }

    for (const index of edgeIndexes) {
        const text = comparableMarkdownText(lines[index]);
        if (!text) continue;
        if (isPageNumberText(text)
            || repeatedLines.has(text)
            || isPublicationHeaderText(text)
            || isPublisherFooterText(text)) {
            removableIndexes.add(index);
        }
    }

    if (pageIndex === 0) {
        for (const index of findPublisherMastheadIndexes(lines)) {
            removableIndexes.add(index);
        }
    }

    const chromeRecords = new Set();
    for (const record of records) {
        const block = record.normalized;
        if (!block || !block.text) continue;
        const blockLines = splitBlockTextLines(block.text);
        const matchingIndexes = new Set(blockLines.flatMap(blockLine => (
            lineIndexesByText.get(comparableMarkdownText(blockLine)) || []
        )));
        if (!matchingIndexes.size) continue;
        const explicitChrome = ['header', 'footer'].includes(block.type)
            && isPageEdgeBBox(block.bbox);
        const chromeMatches = [...matchingIndexes].filter(index => (
            edgeIndexes.has(index)
            && (explicitChrome || removableIndexes.has(index))
        ));
        const implicitChrome = isPageEdgeBBox(block.bbox)
            && chromeMatches.length > 0;
        if (!explicitChrome && !implicitChrome) continue;
        for (const index of chromeMatches) removableIndexes.add(index);
        chromeRecords.add(record);
    }

    if (!removableIndexes.size) {
        return { markdown, chromeRecords };
    }
    return {
        markdown: lines
            .filter((line, index) => !removableIndexes.has(index))
            .join('')
            .trim(),
        chromeRecords,
    };
}

function normalizeMistralTextFlow(markdown, records) {
    const textBlocks = records
        .map(record => record.normalized)
        .filter(block => block?.type === 'text');
    if (!markdown || textBlocks.length < 2) return markdown;

    const sourceMap = createMarkdownSourceMap(markdown, textBlocks, {
        includeMatchedTextRanges: true,
    });
    const entries = sourceMap
        .filter(entry => entry.type === 'text' && entry.locations.length === 1)
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
    const edits = [];

    for (let index = 1; index < entries.length; index++) {
        const previous = entries[index - 1];
        const current = entries[index];
        if (!isMistralColumnContinuation(markdown, previous, current)) continue;
        edits.push({
            from: previous.markdownTo,
            to: current.markdownFrom,
            replacement: ' ',
        });
    }
    return applyMistralTextFlowEdits(markdown, edits);
}

function isMistralColumnContinuation(markdown, previous, current) {
    const previousLocation = previous.locations[0];
    const currentLocation = current.locations[0];
    const samePage = previousLocation.pageIndex === currentLocation.pageIndex;
    const nextPage = currentLocation.pageIndex === previousLocation.pageIndex + 1;
    if (!samePage && !nextPage) return false;

    const previousBox = previousLocation.bbox;
    const currentBox = currentLocation.bbox;
    if (!Array.isArray(previousBox) || previousBox.length !== 4
        || !Array.isArray(currentBox) || currentBox.length !== 4) {
        return false;
    }
    if (previousBox[3] < MISTRAL_COLUMN_BOTTOM_THRESHOLD
        || currentBox[1] > MISTRAL_COLUMN_TOP_THRESHOLD) {
        return false;
    }
    if (samePage && !areSeparateMistralColumns(previousBox, currentBox)) {
        return false;
    }

    const between = markdown.slice(previous.markdownTo, current.markdownFrom);
    if (!/^\s+$/u.test(between)) return false;

    const previousText = markdown.slice(previous.markdownFrom, previous.markdownTo)
        .trimEnd();
    const currentText = markdown.slice(current.markdownFrom, current.markdownTo)
        .trimStart();
    if (!previousText || !currentText
        || MISTRAL_NON_PROSE_START_PATTERN.test(currentText)) {
        return false;
    }
    return !MISTRAL_SENTENCE_END_PATTERN.test(previousText)
        || /^[\p{Ll}\p{Mn}\s\])},.;:]/u.test(currentText);
}

function areSeparateMistralColumns(previousBox, currentBox) {
    const horizontalGap = previousBox[2] <= currentBox[0]
        ? currentBox[0] - previousBox[2]
        : currentBox[2] <= previousBox[0]
            ? previousBox[0] - currentBox[2]
            : 0;
    return horizontalGap >= MISTRAL_MIN_COLUMN_GAP;
}

function applyMistralTextFlowEdits(markdown, edits) {
    const sorted = [...edits].sort((left, right) => right.from - left.from);
    let result = markdown;
    let lastFrom = markdown.length + 1;
    for (const edit of sorted) {
        if (edit.to > lastFrom) continue;
        result = result.slice(0, edit.from)
            + edit.replacement
            + result.slice(edit.to);
        lastFrom = edit.from;
    }
    return result;
}

function edgeLineIndexes(lines) {
    const nonEmpty = lines
        .map((line, index) => line.trim() ? index : null)
        .filter(index => index !== null);
    return new Set([
        ...nonEmpty.slice(0, 3),
        ...nonEmpty.slice(-3),
    ]);
}

function isPageEdgeBBox(bbox) {
    return Array.isArray(bbox)
        && bbox.length === 4
        && (bbox[1] <= 180 || bbox[3] >= 820);
}

function isPageNumberText(text) {
    return /^(?:page\s+)?\d+\s+of\s+\d+$/iu.test(text);
}

function isPublisherFooterText(text) {
    return /(?:doi\.org\/10\.\d+|\/journal\/)/iu.test(text)
        || /^https?:\/\/\S+\/(?:\d{4}\/\d+\/[a-z0-9-]+|journal\/\S*)$/iu.test(text)
        || /\b(?:19|20)\d{2}\s*\|\s*vol\.\s*\d+\s*\|\s*[a-z0-9-]+\s*\|\s*p\.\s*\d+$/iu.test(text)
        || /^\(page number not for citation purposes\)$/iu.test(text);
}

function isPublicationHeaderText(text) {
    return /\b(?:19|20)\d{2}\b\s*,\s*\d+\s*,\s*\d+(?:\s|$)/u.test(text);
}

function isLikelyPageChromeText(text) {
    if (isPageNumberText(text)) return true;
    if (/^!?\[|^#{1,6}(?:\s|$)|^\|/u.test(text)) return false;
    return isPublicationHeaderText(text)
        || /(?:doi\.org|\/journal\/|^https?:\/\/)/iu.test(text);
}

function findPublisherMastheadIndexes(lines) {
    const titleIndex = lines.findIndex(line => (
        /^ {0,3}#{1,6}[ \t]+\S/u.test(line)
    ));
    if (titleIndex <= 0) return [];
    const prefix = lines.slice(0, titleIndex)
        .map(line => comparableMarkdownText(line).toLowerCase())
        .filter(Boolean);
    const hasMDPI = prefix.includes('mdpi');
    const hasArticle = prefix.includes('article');
    const hasJournal = prefix.includes('sensors');
    if (!hasMDPI || (!hasArticle && !hasJournal)) return [];
    return Array.from({ length: titleIndex }, (_, index) => index);
}

function splitBlockTextLines(text) {
    return String(text || '')
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean);
}

function comparableMarkdownText(value) {
    let text = String(value || '').replace(/\r?\n$/, '').trim();
    if (!text || /^!\[/u.test(text) || /^<!--/u.test(text)) return '';
    text = text
        .replace(/^ {0,3}#{1,6}[ \t]+/u, '')
        .replace(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/u, '')
        .replace(/^ {0,3}>[ \t]?/u, '')
        .replace(/\[([^\]\r\n]+)\]\([^)]*\)/gu, '$1')
        .replace(/[*_~`]/gu, '');
    return normalizeComparableText(text);
}

function normalizeComparableText(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function normalizeBlock(block, page, dimensions, pageMap, tables, warnings) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
        warnings.push(`Mistral block on page ${page.index} was skipped.`);
        return null;
    }
    const rawType = String(block.type || '').trim().toLowerCase();
    const type = BLOCK_TYPES.get(rawType);
    if (!type) {
        warnings.push(`Mistral block on page ${page.index} was skipped.`);
        return null;
    }
    if (!dimensions) {
        warnings.push(`Mistral block on page ${page.index} has invalid dimensions.`);
        return null;
    }
    const bbox = normalizeBBox(
        block.bbox ?? block.bounding_box ?? block.boundingBox ?? block,
        dimensions
    );
    if (!bbox) {
        warnings.push(`Mistral block on page ${page.index} has an invalid bounding box.`);
        return null;
    }
    const normalized = {
        type,
        pageIndex: page.index,
        bbox,
    };
    if (type === 'image' || type === 'chart') {
        const imageReference = firstString(
            block.image_id,
            block.imageId,
            block.content,
            block.assetPath,
            block.text,
            block.id
        );
        const assetPath = resolveAssetPath(imageReference, pageMap);
        if (!assetPath) {
            warnings.push(`Mistral image block on page ${page.index} was skipped.`);
            return null;
        }
        normalized.assetPath = assetPath;
        return normalized;
    }
    const text = normalizeMistralMarkdown(
        blockText(block, type, tables),
        { tables }
    );
    if (typeof text === 'string' && text) normalized.text = text;
    const allowsEmptyText = ['header', 'footer'].includes(type)
        || rawType === 'signature';
    if (!normalized.text && !allowsEmptyText) {
        warnings.push(`Mistral block on page ${page.index} has no text.`);
        return null;
    }
    return normalized;
}

function blockText(block, type, tables) {
    const candidates = [];
    if (type === 'table') {
        const tableID = firstString(block.table_id, block.tableId);
        const tableContent = findTableContent(tables, tableID);
        if (tableContent) candidates.push(tableContent);
    }
    candidates.push(block.content, block.text, block.latex);
    if (type === 'list' && Array.isArray(block.list_items)) {
        candidates.push(block.list_items
            .filter(item => typeof item === 'string')
            .join('\n'));
    }
    if (type === 'table') {
        candidates.push(block.markdown, block.table_markdown, block.tableMarkdown);
    }
    return candidates.find(value => typeof value === 'string' && value.trim()) || null;
}

function findTableContent(tables, tableID) {
    if (!(tables instanceof Map)) return null;
    const normalizedID = normalizeTableID(tableID);
    return normalizedID ? tables.get(normalizedID) || null : null;
}

function firstString(...values) {
    return values.find(value => typeof value === 'string' && value) || null;
}

function normalizeBBox(value, dimensions) {
    let x1;
    let y1;
    let x2;
    let y2;
    if (Array.isArray(value) && value.length === 4) {
        [x1, y1, x2, y2] = value;
    }
    else if (value && typeof value === 'object') {
        x1 = value.x1
            ?? value.top_left_x
            ?? value.topLeftX
            ?? value.left
            ?? value.x;
        y1 = value.y1
            ?? value.top_left_y
            ?? value.topLeftY
            ?? value.top
            ?? value.y;
        x2 = value.x2
            ?? value.bottom_right_x
            ?? value.bottomRightX
            ?? value.right;
        y2 = value.y2
            ?? value.bottom_right_y
            ?? value.bottomRightY
            ?? value.bottom;
        if (x2 === undefined && Number.isFinite(value.width)) {
            x2 = Number(x1) + value.width;
        }
        if (y2 === undefined && Number.isFinite(value.height)) {
            y2 = Number(y1) + value.height;
        }
    }
    if (![x1, y1, x2, y2].every(Number.isFinite)
        || x1 < 0
        || y1 < 0
        || x2 > dimensions.width
        || y2 > dimensions.height
        || x2 <= x1
        || y2 <= y1) {
        return null;
    }
    const normalized = [
        x1 / dimensions.width * 1000,
        y1 / dimensions.height * 1000,
        x2 / dimensions.width * 1000,
        y2 / dimensions.height * 1000,
    ];
    return normalized.every(Number.isFinite)
        && normalized[0] < normalized[2]
        && normalized[1] < normalized[3]
        && normalized.every(value => value >= 0 && value <= 1000)
        ? normalized
        : null;
}

function resolveAssetPath(reference, pageMap) {
    if (typeof reference !== 'string' || !reference) return null;
    const source = reference.trim();
    return pageMap.get(source)
        || pageMap.get(decodeAssetReference(source));
}

function decodeAssetReference(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}

function rewriteMarkdownImages(markdown, pageMap) {
    if (!markdown) return markdown;
    return markdown.replace(
        /!\[([^\]\r\n]*)\]\(\s*(<[^>\r\n]+>|[^)\s]+)([^)]*)\)/g,
        (match, alt, rawDestination, suffix) => {
            const destination = rawDestination.startsWith('<')
                ? rawDestination.slice(1, -1)
                : rawDestination;
            const path = resolveAssetPath(destination, pageMap);
            if (!path) return `![${alt}]()`;
            const title = suffix || '';
            return `![${alt}](${path}${title})`;
        }
    );
}

function normalizeAssetPath(value) {
    if (typeof value !== 'string') throw invalidResult('Mistral image ID is invalid');
    const source = value.trim();
    if (!source
        || source.length > 1_024
        || source.startsWith('/')
        || source.includes('\\')
        || /^[a-z][a-z0-9+.-]*:/i.test(source)
        || /[\u0000-\u001f\u007f?#%]/u.test(source)) {
        throw invalidResult('Mistral image ID is invalid');
    }
    const segments = source.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw invalidResult('Mistral image ID is invalid');
    }
    return segments.join('/');
}

function decodeImage(value, mimeHint, path, maxBytes) {
    if (typeof value !== 'string' || !value) {
        throw invalidResult('Mistral image data is invalid');
    }
    let source = value;
    let mimeType = normalizeMime(mimeHint) || mimeFromPath(path);
    const dataURL = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
    if (dataURL) {
        mimeType = normalizeMime(dataURL[1]);
        source = dataURL[2];
    }
    if (!mimeType || !IMAGE_MIME_TYPES.has(mimeType.slice(6))) {
        throw invalidResult('Mistral image MIME type is invalid');
    }
    if (!isBase64(source)) throw invalidResult('Mistral image data is invalid');
    const paddedSource = source + '='.repeat((4 - source.length % 4) % 4);
    const decodedLength = paddedSource.length / 4 * 3
        - (paddedSource.endsWith('==') ? 2 : paddedSource.endsWith('=') ? 1 : 0);
    if (!decodedLength || decodedLength > maxBytes) {
        throw invalidResult('Mistral image exceeds the configured resource limit');
    }
    let binary;
    try {
        binary = (globalThis.atob || atob)(paddedSource);
    }
    catch {
        throw invalidResult('Mistral image data is invalid');
    }
    if (binary.length !== decodedLength) {
        throw invalidResult('Mistral image data is invalid');
    }
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
    return { source: value, mimeType, data };
}

function isBase64(value) {
    return value.length > 0
        && value.length % 4 !== 1
        && /^[A-Za-z0-9+/]*={0,2}$/u.test(value)
        && !/=/.test(value.slice(0, -2));
}

function normalizeMime(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'image/jpg') return 'image/jpeg';
    return /^image\/(?:png|jpeg|gif|webp)$/u.test(normalized)
        ? normalized
        : null;
}

function mimeFromPath(path) {
    const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
    return extension ? IMAGE_MIME_TYPES.get(extension) || null : null;
}

function limitSourceMap(sourceMap, maxLocations) {
    if (!Number.isSafeInteger(maxLocations) || maxLocations < 1) return [];
    const result = [];
    let remaining = maxLocations;
    for (const entry of sourceMap) {
        if (remaining <= 0) break;
        const locations = entry.locations.slice(0, remaining);
        if (!locations.length) continue;
        const locationSet = new Set(locations.map(location => (
            `${location.pageIndex}:${location.bbox.join(',')}`
        )));
        const locationRanges = (entry.locationRanges || []).filter(range => (
            locationSet.has(`${range.location.pageIndex}:${range.location.bbox.join(',')}`)
        ));
        result.push({
            ...entry,
            locations,
            ...(locationRanges.length ? { locationRanges } : {}),
        });
        remaining -= locations.length;
    }
    return result;
}

function invalidResult(message) {
    const error = new Error(message);
    error.code = 'MISTRAL_INVALID_RESULT';
    return error;
}
