import { GFM, parser as markdownParser } from '@lezer/markdown';
import { analyzeDocumentFigures } from '../figures/figure-analysis.js';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
} from './markdown-html.js';
import { analyzeMarkdownCitations } from './markdown-citations.js';
import {
    analyzeMarkdownFigureReferences,
} from './markdown-figure-references.js';
import {
    analyzeMarkdownTableReferences,
} from './markdown-table-references.js';
import { normalizeChromeRanges } from './chrome-ranges.js';

const MARKDOWN_PARSER = markdownParser.configure(GFM);
const HEADING_PATTERN = /^(?:ATXHeading[1-6]|SetextHeading[12])$/;
const TRANSLATABLE_NODE_TYPES = new Map([
    ['Paragraph', 'paragraph'],
    ['BulletList', 'list'],
    ['OrderedList', 'list'],
    ['Blockquote', 'blockquote'],
    ['Table', 'table'],
]);
const PROTECTED_NODE_TYPES = new Set([
    'Image',
    'InlineCode',
    'HTMLBlock',
    'HTMLTag',
    'URL',
    'FencedCode',
    'CodeBlock',
]);
const PROTECTED_PLACEHOLDER_PATTERN = /MKTEROPROTECTED\d+PLACEHOLDER/g;
const DOCUMENT_MARKER_PATTERN = /MKTEROBLOCK\d+(?:START|END)MARKER/g;
const REFERENCE_HEADING_PATTERN = /^(?:references?|bibliography|works cited|literature cited|参考文献|参考资料|参考书目|引用文献)$/iu;
const NUMERIC_CITATION_PATTERN = /\[(?:\d{1,4}[a-z]?(?:[ \t]*[-–—,，;；][ \t]*\d{1,4}[a-z]?)*)(?:[ \t]*,[ \t]*)?\]/giu;
export const BILINGUAL_LIST_BOUNDARY =
    '<!-- mktero-bilingual-list-boundary -->';
export const TRANSLATION_PROTECTED_CONTENT_CHANGED =
    'TRANSLATION_PROTECTED_CONTENT_CHANGED';
export const MAX_TRANSLATION_BATCH_BLOCKS = 8;
export const MAX_TRANSLATION_BATCH_SOURCE_TOKENS = 2_000;

export function collectMarkdownTranslationBlocks(markdown, { chromeRanges } = {}) {
    const source = String(markdown || '');
    const hidden = normalizeChromeRanges(chromeRanges, source.length);
    const blocks = [];
    const interactiveRanges = collectInteractiveRanges(source);
    let interactiveRangeIndex = 0;
    const createPlaceholder = createProtectedPlaceholderFactory(source);
    const createDocumentMarkers = createDocumentMarkerFactory(source);
    let ordinal = 0;
    let referenceSection = false;
    for (let node = MARKDOWN_PARSER.parse(source).topNode.firstChild;
        node;
        node = node.nextSibling) {
        const blockMarkdown = source.slice(node.from, node.to);
        const referenceHeading = isReferenceHeading(node.name, blockMarkdown);
        if (isTopLevelH1Node(node.name) && !referenceHeading) {
            referenceSection = false;
        }
        if (referenceHeading) {
            referenceSection = true;
        }
        const type = translationBlockType(node.name);
        const protectedRanges = collectProtectedRanges(
            node,
            blockMarkdown,
            interactiveRangesForNode(
                interactiveRanges,
                interactiveRangeIndex,
                node
            )
        );
        while (interactiveRangeIndex < interactiveRanges.length
            && interactiveRanges[interactiveRangeIndex].from < node.to) {
            interactiveRangeIndex++;
        }
        const protectedBlock = protectMarkdown(
            blockMarkdown,
            protectedRanges,
            createPlaceholder
        );
        const translatable = !referenceSection
            && isTranslatableBlock(
                node,
                blockMarkdown,
                protectedBlock.markdown,
                protectedBlock.fragments
            )
            && !hidden.some(range => (
                range.from <= node.from && node.to <= range.to
            ));
        const requestBlock = translatable
            ? protectedBlock
            : protectMarkdown(blockMarkdown, [{
                from: 0,
                to: blockMarkdown.length,
            }], createPlaceholder);
        const documentMarkers = createDocumentMarkers();
        blocks.push({
            id: `translation-${ordinal}-${node.from}-${node.to}-${type}`,
            type,
            nodeType: node.name,
            from: node.from,
            to: node.to,
            markdown: blockMarkdown,
            requestMarkdown: requestBlock.markdown,
            protectedFragments: requestBlock.fragments,
            ...documentMarkers,
            translatable,
        });
        ordinal++;
    }
    return blocks;
}

export function collectMarkdownTranslationSections(markdown, blocks) {
    const source = String(markdown || '');
    if (!Array.isArray(blocks)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    const sections = [];
    let sectionBlocks = [];
    const appendSection = () => {
        if (!sectionBlocks.length) return;
        sections.push(sectionBlocks);
        sectionBlocks = [];
    };
    for (const block of blocks) {
        if (isTopLevelH1(block) && sectionBlocks.length) appendSection();
        sectionBlocks.push(block);
    }
    appendSection();
    return sections.map((sectionBlocks, index) => ({
        index,
        blocks: sectionBlocks,
        translatableBlocks: sectionBlocks.filter(block => block.translatable),
        requestMarkdown: createMarkdownTranslationRequest('', sectionBlocks),
        source: source.slice(
            sectionBlocks[0].from,
            sectionBlocks.at(-1).to
        ),
    }));
}

export function createMarkdownTranslationBatches(section, {
    maxBlocks = MAX_TRANSLATION_BATCH_BLOCKS,
    maxSourceTokens = MAX_TRANSLATION_BATCH_SOURCE_TOKENS,
} = {}) {
    if (!Array.isArray(section?.blocks)) {
        throw new TypeError('A Markdown translation section is required');
    }
    if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) {
        throw new RangeError('The Markdown translation batch block limit is invalid');
    }
    if (!Number.isSafeInteger(maxSourceTokens) || maxSourceTokens < 1) {
        throw new RangeError('The Markdown translation batch token limit is invalid');
    }
    const batches = [];
    let batchBlocks = [];
    let translatableCount = 0;
    let sourceTokens = 0;
    const appendBatch = () => {
        if (!batchBlocks.length || !translatableCount) {
            batchBlocks = [];
            translatableCount = 0;
            sourceTokens = 0;
            return;
        }
        batches.push({
            blocks: batchBlocks,
            translatableBlocks: batchBlocks.filter(block => block.translatable),
            requestPayload: createMarkdownTranslationBatchPayload(batchBlocks),
        });
        batchBlocks = [];
        translatableCount = 0;
        sourceTokens = 0;
    };
    for (const block of section.blocks) {
        const blockTokens = estimateMarkdownTokens(block.requestMarkdown);
        const exceedsBlockLimit = block.translatable
            && translatableCount >= maxBlocks;
        const exceedsTokenLimit = batchBlocks.length
            && sourceTokens + blockTokens > maxSourceTokens;
        if (batchBlocks.length && (exceedsBlockLimit || exceedsTokenLimit)) {
            appendBatch();
        }
        batchBlocks.push(block);
        sourceTokens += blockTokens;
        if (block.translatable) translatableCount++;
    }
    appendBatch();
    return batches;
}

export function createMarkdownTranslationBatchPayload(blocks) {
    if (!Array.isArray(blocks)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    return JSON.stringify(blocks.flatMap(block => block.translatable ? [{
        id: block.id,
        sourceMarkdown: block.requestMarkdown,
    }] : []));
}

export function createProtectedTextTranslationPayload(block) {
    return JSON.stringify(protectedTextTranslationParts(block).flatMap(part => (
        part.type === 'text' ? [{
            id: part.id,
            sourceText: part.sourceText,
        }] : []
    )));
}

export function collectProtectedTextTranslationResponse(block, response) {
    const parts = protectedTextTranslationParts(block);
    const expectedSegments = parts.filter(part => part.type === 'text');
    const expectedIDs = new Set(expectedSegments.map(segment => segment.id));
    const parsed = parseTranslationResponse(response);
    if (!Array.isArray(parsed)) {
        throw new Error('The translated text segments must be a JSON array');
    }
    const responsesByID = new Map();
    for (const entry of parsed) {
        const id = String(entry?.id || '');
        if (!id) {
            throw new Error('The AI returned a text segment without an ID');
        }
        if (!expectedIDs.has(id)) {
            throw new Error('The AI returned an unknown text segment ID');
        }
        const entries = responsesByID.get(id) || [];
        entries.push(entry);
        responsesByID.set(id, entries);
    }
    const translationsByID = new Map();
    for (const segment of expectedSegments) {
        const entries = responsesByID.get(segment.id) || [];
        if (entries.length !== 1
            || typeof entries[0].translatedText !== 'string') {
            throw new Error(entries.length > 1
                ? 'The AI returned a duplicate text segment translation'
                : 'The AI omitted a text segment translation');
        }
        translationsByID.set(
            segment.id,
            entries[0].translatedText.trim()
        );
    }
    const markdown = parts.map(part => part.type === 'text'
        ? part.leadingWhitespace
            + translationsByID.get(part.id)
            + part.trailingWhitespace
        : part.value).join('');
    validateTranslatedBlock(block, markdown);
    return {
        id: block.id,
        markdown,
    };
}

export function collectMarkdownTranslationBatchResponse(blocks, response) {
    if (!Array.isArray(blocks)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    const expectedBlocks = blocks.filter(block => block.translatable);
    const expectedIDs = new Set(expectedBlocks.map(block => block.id));
    const parsed = parseTranslationResponse(response);
    if (!Array.isArray(parsed)) {
        throw new Error('The translated Markdown batch must be a JSON array');
    }
    const responsesByID = new Map();
    for (const entry of parsed) {
        const id = String(entry?.id || '');
        if (!id) continue;
        if (!expectedIDs.has(id)) {
            throw new Error('The AI returned an unknown Markdown block ID');
        }
        const entries = responsesByID.get(id) || [];
        entries.push(entry);
        responsesByID.set(id, entries);
    }
    const translations = [];
    const failures = [];
    for (const block of expectedBlocks) {
        const entries = responsesByID.get(block.id) || [];
        if (entries.length !== 1
            || typeof entries[0].translatedMarkdown !== 'string') {
            failures.push({
                id: block.id,
                message: entries.length > 1
                    ? 'The AI returned a duplicate Markdown block translation'
                    : 'The AI omitted a Markdown block translation',
            });
            continue;
        }
        try {
            validateTranslatedBlock(block, entries[0].translatedMarkdown);
            translations.push({
                id: block.id,
                markdown: entries[0].translatedMarkdown,
            });
        }
        catch (error) {
            failures.push({
                id: block.id,
                message: error?.message || 'The translated Markdown block is invalid',
                ...(error?.code ? { code: error.code } : {}),
            });
        }
    }
    return { translations, failures };
}

export function createMarkdownTranslationRequest(markdown, blocks) {
    if (!blocks.length) return String(markdown || '');
    return blocks.map(block => [
        block.documentStartMarker,
        block.requestMarkdown,
        block.documentEndMarker,
    ].join('\n\n')).join('\n\n');
}

export function collectDocumentTranslations(
    requestMarkdown,
    blocks,
    translatedMarkdown
) {
    if (!Array.isArray(blocks)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    const request = String(requestMarkdown || '');
    if (request !== createMarkdownTranslationRequest('', blocks)) {
        throw new Error('The Markdown translation request is invalid');
    }
    const translated = String(translatedMarkdown || '').trim();
    if (!translated) throw new Error('The translated Markdown document is empty');
    const translatedBlocks = extractMarkedDocumentBlocks(blocks, translated);
    const translations = [];
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const translatedBlock = translatedBlocks[index];
        if (!block.translatable) {
            if (translatedBlock !== block.requestMarkdown) {
                throw new Error(
                    'The translated Markdown document changed protected content'
                );
            }
            continue;
        }
        validateTranslatedBlock(block, translatedBlock);
        translations.push({
            id: block.id,
            markdown: translatedBlock,
        });
    }
    return translations;
}

function extractMarkedDocumentBlocks(blocks, translated) {
    const expectedMarkers = blocks.flatMap(block => [
        block.documentStartMarker,
        block.documentEndMarker,
    ]);
    const actualMarkers = translated.match(DOCUMENT_MARKER_PATTERN) || [];
    if (actualMarkers.length !== expectedMarkers.length
        || actualMarkers.some((marker, index) => marker !== expectedMarkers[index])) {
        throw new Error(
            'The translated Markdown document changed its block order or structure'
        );
    }
    const translatedBlocks = [];
    let cursor = 0;
    for (const block of blocks) {
        const start = translated.indexOf(block.documentStartMarker, cursor);
        if (start < 0 || translated.slice(cursor, start).trim()) {
            throw new Error('The translated Markdown document changed its structure');
        }
        const contentFrom = start + block.documentStartMarker.length;
        const end = translated.indexOf(block.documentEndMarker, contentFrom);
        if (end < 0) {
            throw new Error('The translated Markdown document changed its structure');
        }
        translatedBlocks.push(translated.slice(contentFrom, end).trim());
        cursor = end + block.documentEndMarker.length;
    }
    if (translated.slice(cursor).trim()) {
        throw new Error('The translated Markdown document changed its structure');
    }
    return translatedBlocks;
}

export function assembleTranslatedMarkdown(markdown, blocks, translations) {
    return createTranslatedMarkdownView(markdown, blocks, translations).markdown;
}

export function createComparisonMarkdown(markdown, blocks, translations) {
    return createComparisonMarkdownView(markdown, blocks, translations).markdown;
}

export function createComparisonMarkdownView(markdown, blocks, translations) {
    const source = String(markdown || '');
    const translatedByID = validateTranslationSet(blocks, translations);
    const chunks = [];
    const sourceRanges = [];
    const translationRanges = [];
    const blockRanges = [];
    let comparisonOffset = 0;
    let cursor = 0;
    for (const block of blocks) {
        const gap = source.slice(cursor, block.from);
        chunks.push(gap, block.markdown);
        comparisonOffset += gap.length;
        sourceRanges.push({
            sourceFrom: block.from,
            sourceTo: block.to,
            comparisonFrom: comparisonOffset,
        });
        const blockRange = {
            id: block.id,
            comparisonSourceFrom: comparisonOffset,
            comparisonSourceTo: comparisonOffset + block.markdown.length,
            comparisonTranslationFrom: null,
            comparisonTranslationTo: null,
        };
        comparisonOffset += block.markdown.length;
        if (block.translatable) {
            const restored = validateTranslatedBlock(
                block,
                translatedByID.get(block.id)
            );
            if (restored.trim() === block.markdown.trim()) {
                blockRanges.push(blockRange);
                cursor = block.to;
                continue;
            }
            const translated = removeRepeatedComparisonImages(
                restored,
                block
            );
            if (translated.trim()) {
                const boundary = block.type === 'list'
                    ? `\n${BILINGUAL_LIST_BOUNDARY}\n\n`
                    : '\n\n';
                chunks.push(boundary, translated);
                comparisonOffset += boundary.length;
                translationRanges.push({
                    from: comparisonOffset,
                    to: comparisonOffset + translated.length,
                });
                blockRange.comparisonTranslationFrom = comparisonOffset;
                blockRange.comparisonTranslationTo = comparisonOffset
                    + translated.length;
                comparisonOffset += translated.length;
            }
        }
        blockRanges.push(blockRange);
        cursor = block.to;
    }
    chunks.push(source.slice(cursor));
    return {
        markdown: chunks.join(''),
        sourceRanges,
        translationRanges,
        blockRanges,
    };
}

export function createDocumentTranslationViews(markdown, blocks, translations, { figureMap = null } = {}) {
    const translated = createTranslatedMarkdownView(
        markdown,
        blocks,
        translations
    );
    const comparison = createComparisonMarkdownView(
        markdown,
        blocks,
        translations
    );
    const comparisonByID = new Map(
        comparison.blockRanges.map(range => [range.id, range])
    );
    const blockRanges = translated.blockRanges.map(range => ({
        ...range,
        ...comparisonByID.get(range.id),
    }));
    return {
        translatedMarkdown: translated.markdown,
        comparisonMarkdown: comparison.markdown,
        comparisonSourceRanges: comparison.sourceRanges,
        comparisonTranslationRanges: comparison.translationRanges,
        blockRanges,
        translatedFigureViews: analyzeDocumentFigures(translated.markdown, {
            figureMap, viewRanges: blockRanges, viewKind: 'translation',
        }),
        comparisonFigureViews: analyzeDocumentFigures(comparison.markdown, {
            figureMap, viewRanges: blockRanges, viewKind: 'comparison',
        }),
    };
}

export function mapSourceRangeToComparison(range, blockRanges) {
    const sourceRange = normalizeDocumentRange(range);
    if (!sourceRange || !Array.isArray(blockRanges)) return null;
    const block = blockRanges.find(candidate => (
        sourceRange.from >= candidate.sourceFrom
        && sourceRange.to <= candidate.sourceTo
    ));
    if (!block) return null;
    return {
        from: block.comparisonSourceFrom
            + sourceRange.from - block.sourceFrom,
        to: block.comparisonSourceFrom
            + sourceRange.to - block.sourceFrom,
    };
}

export function mapComparisonRangeToSource(range, blockRanges) {
    const comparisonRange = normalizeDocumentRange(range);
    if (!comparisonRange || !Array.isArray(blockRanges)) return null;
    const block = blockRanges.find(candidate => (
        comparisonRange.from >= candidate.comparisonSourceFrom
        && comparisonRange.to <= candidate.comparisonSourceTo
    ));
    if (!block) return null;
    return {
        from: block.sourceFrom
            + comparisonRange.from - block.comparisonSourceFrom,
        to: block.sourceFrom
            + comparisonRange.to - block.comparisonSourceFrom,
    };
}

export function createTranslationReadingPositionAnchor(
    offset,
    view,
    blockRanges
) {
    const position = Number(offset);
    if (!Number.isFinite(position) || !Array.isArray(blockRanges)) return null;
    const normalized = Math.max(0, Math.trunc(position));
    for (const block of blockRanges) {
        const candidates = readingRangesForView(block, view);
        for (const candidate of candidates) {
            if (normalized < candidate.from || normalized > candidate.to) continue;
            const length = Math.max(1, candidate.to - candidate.from);
            return {
                blockID: block.id,
                side: candidate.side,
                progress: Math.max(0, Math.min(
                    1,
                    (normalized - candidate.from) / length
                )),
            };
        }
    }
    return null;
}

export function resolveTranslationReadingPosition(anchor, view, blockRanges) {
    if (!anchor?.blockID || !Array.isArray(blockRanges)) return null;
    const block = blockRanges.find(candidate => candidate.id === anchor.blockID);
    if (!block) return null;
    const candidates = readingRangesForView(block, view);
    if (!candidates.length) return null;
    const candidate = view === 'compare'
        ? candidates.find(range => range.side === anchor.side) || candidates[0]
        : candidates[0];
    const length = Math.max(0, candidate.to - candidate.from);
    const progress = Math.max(0, Math.min(1, Number(anchor.progress) || 0));
    return candidate.from + Math.round(length * progress);
}

export function validateTranslatedBlock(block, translatedMarkdown) {
    if (!block?.translatable) {
        throw new TypeError('Only translatable Markdown blocks can be validated');
    }
    const translated = String(translatedMarkdown || '').trim();
    if (!translated) throw new Error('The translated Markdown block is empty');
    validateProtectedPlaceholders(block, translated);
    const nodes = topLevelNodes(translated);
    if (nodes.length !== 1 || nodes[0].name !== block.nodeType) {
        throw new Error('The translated Markdown block changed its structure');
    }
    let unsafe = false;
    MARKDOWN_PARSER.parse(translated).iterate({
        enter(node) {
            if (node.name === 'HTMLBlock'
                || node.name === 'HTMLTag'
                || node.name === 'Image') {
                unsafe = true;
            }
        },
    });
    if (unsafe) {
        throw new Error('The translated Markdown block contains unsafe structure');
    }
    return restoreProtectedFragments(block, translated);
}

export function reconcileTranslatedBlockProtectedFragments({
    previousBlock,
    currentBlock,
    translatedMarkdown,
}) {
    if (!previousBlock?.translatable || !currentBlock?.translatable) {
        throw new TypeError('Translatable Markdown blocks are required');
    }
    const cachedMarkdown = normalizeCachedProtectedPlaceholders(
        previousBlock,
        translatedMarkdown
    );
    const remapping = protectedPlaceholderRemapping(
        previousBlock.protectedFragments,
        currentBlock.protectedFragments || []
    );
    if (!remapping) throw protectedContentChangedError();
    return remapProtectedPlaceholders(
        cachedMarkdown,
        previousBlock.protectedFragments.map(fragment => fragment.placeholder),
        remapping
    );
}

function createTranslatedMarkdownView(markdown, blocks, translations) {
    const source = String(markdown || '');
    const translatedByID = validateTranslationSet(blocks, translations);
    const chunks = [];
    const blockRanges = [];
    let translatedOffset = 0;
    let cursor = 0;
    for (const block of blocks) {
        const gap = source.slice(cursor, block.from);
        const translated = block.translatable
            ? validateTranslatedBlock(block, translatedByID.get(block.id))
            : block.markdown;
        chunks.push(gap, translated);
        translatedOffset += gap.length;
        blockRanges.push({
            id: block.id,
            type: block.type,
            sourceFrom: block.from,
            sourceTo: block.to,
            translatedFrom: translatedOffset,
            translatedTo: translatedOffset + translated.length,
        });
        translatedOffset += translated.length;
        cursor = block.to;
    }
    chunks.push(source.slice(cursor));
    return {
        markdown: chunks.join(''),
        blockRanges,
    };
}

function validateTranslationSet(blocks, translations) {
    if (!Array.isArray(blocks) || !Array.isArray(translations)) {
        throw new TypeError('Markdown translation blocks are required');
    }
    const translatedByID = new Map();
    for (const translation of translations) {
        const id = String(translation?.id || '');
        if (!id || translatedByID.has(id)) {
            throw new Error('The Markdown translation set is invalid');
        }
        translatedByID.set(id, String(translation.markdown || ''));
    }
    for (const block of blocks) {
        if (block.translatable && !translatedByID.has(block.id)) {
            throw new Error('A Markdown block translation is missing');
        }
    }
    return translatedByID;
}

function normalizeDocumentRange(range) {
    if (!Number.isSafeInteger(range?.from)
        || !Number.isSafeInteger(range?.to)
        || range.from < 0
        || range.to <= range.from) {
        return null;
    }
    return { from: range.from, to: range.to };
}

function readingRangesForView(block, view) {
    if (view === 'translated') {
        return validReadingRange(
            block.translatedFrom,
            block.translatedTo,
            'translation'
        );
    }
    if (view === 'compare') {
        return [
            ...validReadingRange(
                block.comparisonSourceFrom,
                block.comparisonSourceTo,
                'source'
            ),
            ...validReadingRange(
                block.comparisonTranslationFrom,
                block.comparisonTranslationTo,
                'translation'
            ),
        ];
    }
    return validReadingRange(block.sourceFrom, block.sourceTo, 'source');
}

function validReadingRange(from, to, side) {
    return Number.isSafeInteger(from)
        && Number.isSafeInteger(to)
        && from >= 0
        && to >= from
        ? [{ from, to, side }]
        : [];
}

function isTranslatableBlock(
    node,
    markdown,
    requestMarkdown,
    protectedFragments
) {
    if (!translationBlockType(node.name)
        || !TRANSLATABLE_NODE_TYPES.has(node.name)
        && !HEADING_PATTERN.test(node.name)) {
        return false;
    }
    if (isStandaloneDisplayMath(markdown)) return false;
    const withoutProtected = protectedFragments.reduce(
        (value, fragment) => value.replace(fragment.placeholder, ''),
        requestMarkdown
    );
    return hasTranslatableContent(withoutProtected);
}

function collectProtectedRanges(node, markdown, interactiveRanges) {
    const ranges = interactiveRanges.map(range => ({
        from: range.from - node.from,
        to: range.to - node.from,
    }));
    node.cursor().iterate(current => {
        if (current.name === 'Image') {
            const wrapperRanges = translatableImageWrapperRanges(
                current.node,
                node.from,
                interactiveRanges
            );
            if (wrapperRanges) {
                ranges.push(...wrapperRanges);
                return undefined;
            }
        }
        if (!PROTECTED_NODE_TYPES.has(current.name)) return;
        ranges.push({
            from: current.from - node.from,
            to: current.to - node.from,
        });
        return false;
    });
    for (const match of findInlineMathMatches(markdown)) {
        ranges.push({ from: match.start, to: match.end });
    }
    for (const match of findContainerDisplayMathMatches(markdown)) {
        ranges.push({ from: match.start, to: match.end });
    }
    for (const match of markdown.matchAll(
        new RegExp(PROTECTED_PLACEHOLDER_PATTERN.source, 'g')
    )) {
        ranges.push({
            from: match.index,
            to: match.index + match[0].length,
        });
    }
    for (const match of markdown.matchAll(
        new RegExp(DOCUMENT_MARKER_PATTERN.source, 'g')
    )) {
        ranges.push({
            from: match.index,
            to: match.index + match[0].length,
        });
    }
    for (const match of markdown.matchAll(
        new RegExp(NUMERIC_CITATION_PATTERN.source, 'giu')
    )) {
        ranges.push({
            from: match.index,
            to: match.index + match[0].length,
        });
    }
    return selectOuterRanges(ranges, markdown.length);
}

function collectInteractiveRanges(markdown) {
    const citations = analyzeMarkdownCitations(markdown);
    const figures = analyzeMarkdownFigureReferences(markdown);
    const tables = analyzeMarkdownTableReferences(markdown);
    return [
        ...citations.citations,
        ...figures.references,
        ...figures.targets.flatMap(target => targetLabelRange(target)),
        ...tables.references,
        ...tables.targets.flatMap(target => targetLabelRange(target)),
    ].sort((left, right) => left.from - right.from || left.to - right.to);
}

function targetLabelRange(target) {
    if (!Number.isSafeInteger(target?.labelFrom)
        || !Number.isSafeInteger(target?.labelTo)
        || target.labelFrom < 0
        || target.labelTo <= target.labelFrom) {
        return [];
    }
    return [{
        from: target.labelFrom,
        to: target.labelTo,
        translatableImageDescription: true,
    }];
}

function interactiveRangesForNode(ranges, fromIndex, node) {
    const selected = [];
    for (let index = fromIndex; index < ranges.length; index++) {
        const range = ranges[index];
        if (range.from >= node.to) break;
        if (range.from >= node.from && range.to <= node.to) {
            selected.push(range);
        }
    }
    return selected;
}

function translatableImageWrapperRanges(image, blockFrom, interactiveRanges) {
    let rangeIndex = firstRangeAtOrAfter(interactiveRanges, image.from);
    let translatesDescription = false;
    while (rangeIndex < interactiveRanges.length
        && interactiveRanges[rangeIndex].from < image.to) {
        const range = interactiveRanges[rangeIndex];
        if (range.translatableImageDescription && range.to <= image.to) {
            translatesDescription = true;
            break;
        }
        rangeIndex++;
    }
    if (!translatesDescription) return null;
    const marks = [];
    for (let child = image.firstChild; child; child = child.nextSibling) {
        if (child.name === 'LinkMark') marks.push(child);
    }
    if (marks.length < 2 || marks[0].to > marks[1].from) return null;
    return [{
        from: image.from - blockFrom,
        to: marks[0].to - blockFrom,
    }, {
        from: marks[1].from - blockFrom,
        to: image.to - blockFrom,
    }];
}

function firstRangeAtOrAfter(ranges, position) {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (ranges[middle].from < position) low = middle + 1;
        else high = middle;
    }
    return low;
}

function findContainerDisplayMathMatches(markdown) {
    const lines = sourceLines(markdown);
    const matches = [];
    let dollarOpener = null;
    let bracketOpener = null;
    for (const line of lines) {
        const contentStart = markdownContainerContentStart(line.text);
        const content = line.text.slice(contentStart);
        const inlineDollar = /^\$\$[ \t]*(.*?)[ \t]*\$\$[ \t]*$/.exec(content);
        if (inlineDollar?.[1].trim()) {
            matches.push({
                start: line.start + contentStart,
                end: line.end,
            });
        }
        else if (/^\$\$[ \t]*$/.test(content)) {
            if (dollarOpener) {
                matches.push({
                    start: dollarOpener.start,
                    end: line.end,
                });
                dollarOpener = null;
            }
            else {
                dollarOpener = { start: line.start + contentStart };
            }
        }

        const inlineBracket = /^\\\[[ \t]*(.*?)[ \t]*\\\][ \t]*$/.exec(
            content
        );
        if (inlineBracket?.[1].trim()) {
            matches.push({
                start: line.start + contentStart,
                end: line.end,
            });
        }
        else if (/^\\\[[ \t]*$/.test(content)) {
            bracketOpener = { start: line.start + contentStart };
        }
        else if (bracketOpener && /^\\\][ \t]*$/.test(content)) {
            matches.push({
                start: bracketOpener.start,
                end: line.end,
            });
            bracketOpener = null;
        }
    }
    return matches;
}

function sourceLines(source) {
    const lines = [];
    let start = 0;
    while (start < source.length) {
        const newline = source.indexOf('\n', start);
        const end = newline < 0 ? source.length : newline;
        lines.push({ start, end, text: source.slice(start, end) });
        start = newline < 0 ? source.length : newline + 1;
    }
    return lines;
}

function markdownContainerContentStart(line) {
    let offset = 0;
    while (offset < line.length) {
        while (offset < line.length && /[ \t]/.test(line[offset])) offset++;
        if (line[offset] !== '>') break;
        offset++;
        if (line[offset] === ' ' || line[offset] === '\t') offset++;
    }
    return offset;
}

function selectOuterRanges(ranges, sourceLength) {
    const selected = [];
    const sorted = ranges
        .filter(range => Number.isSafeInteger(range.from)
            && Number.isSafeInteger(range.to)
            && range.from >= 0
            && range.to > range.from
            && range.to <= sourceLength)
        .sort((left, right) => left.from - right.from || right.to - left.to);
    for (const range of sorted) {
        const previous = selected.at(-1);
        if (previous && range.from <= previous.to) {
            previous.to = Math.max(previous.to, range.to);
        }
        else {
            selected.push({ ...range });
        }
    }
    return selected;
}

function protectMarkdown(markdown, ranges, createPlaceholder) {
    const fragments = [];
    const chunks = [];
    let cursor = 0;
    for (const range of ranges) {
        const placeholder = createPlaceholder();
        chunks.push(markdown.slice(cursor, range.from), placeholder);
        fragments.push({
            placeholder,
            markdown: markdown.slice(range.from, range.to),
        });
        cursor = range.to;
    }
    chunks.push(markdown.slice(cursor));
    return { markdown: chunks.join(''), fragments };
}

function createProtectedPlaceholderFactory(source) {
    const reserved = new Set(
        String(source || '').match(PROTECTED_PLACEHOLDER_PATTERN) || []
    );
    let placeholderIndex = 0;
    return () => {
        let placeholder;
        do {
            placeholder = `MKTEROPROTECTED${placeholderIndex}PLACEHOLDER`;
            placeholderIndex++;
        } while (reserved.has(placeholder));
        reserved.add(placeholder);
        return placeholder;
    };
}

function createDocumentMarkerFactory(source) {
    const reserved = new Set(
        String(source || '').match(DOCUMENT_MARKER_PATTERN) || []
    );
    let markerIndex = 0;
    return () => {
        let start;
        let end;
        do {
            start = `MKTEROBLOCK${markerIndex}STARTMARKER`;
            end = `MKTEROBLOCK${markerIndex}ENDMARKER`;
            markerIndex++;
        } while (reserved.has(start) || reserved.has(end));
        reserved.add(start);
        reserved.add(end);
        return {
            documentStartMarker: start,
            documentEndMarker: end,
        };
    };
}

function validateProtectedPlaceholders(block, translated) {
    const expected = (block.protectedFragments || [])
        .map(fragment => fragment.placeholder);
    const actual = translated.match(PROTECTED_PLACEHOLDER_PATTERN) || [];
    if (actual.length !== expected.length
        || actual.some((placeholder, index) => placeholder !== expected[index])) {
        throw protectedContentChangedError();
    }
    const originalTree = MARKDOWN_PARSER.parse(block.requestMarkdown);
    const translatedTree = MARKDOWN_PARSER.parse(translated);
    for (const placeholder of expected) {
        if (placeholderNodePath(originalTree, block.requestMarkdown, placeholder)
            !== placeholderNodePath(translatedTree, translated, placeholder)) {
            throw new Error(
                'The translated Markdown block changed protected structure'
            );
        }
    }
}

function normalizeCachedProtectedPlaceholders(block, markdown) {
    const value = String(markdown || '');
    const cachedPlaceholders = value.match(PROTECTED_PLACEHOLDER_PATTERN) || [];
    const expectedPlaceholders = block.protectedFragments.map(
        fragment => fragment.placeholder
    );
    if (cachedPlaceholders.length !== expectedPlaceholders.length
        || new Set(cachedPlaceholders).size !== cachedPlaceholders.length) {
        throw protectedContentChangedError();
    }
    const normalized = remapProtectedPlaceholders(
        value,
        cachedPlaceholders,
        expectedPlaceholders
    );
    validateTranslatedBlock(block, normalized);
    return normalized;
}

function remapProtectedPlaceholders(markdown, placeholders, remapping) {
    let value = String(markdown || '');
    const temporary = placeholders.map((placeholder, index) => {
        let marker = `MKTEROCACHED${index}PLACEHOLDER`;
        while (value.includes(marker)) marker += 'X';
        value = value.replace(placeholder, marker);
        return marker;
    });
    for (let index = 0; index < temporary.length; index++) {
        value = remapping[index]
            ? value.replace(temporary[index], remapping[index])
            : removeProtectedPlaceholder(value, temporary[index]);
    }
    return value;
}

function protectedPlaceholderRemapping(previousFragments, currentFragments) {
    const previousCounts = protectedFragmentCounts(previousFragments);
    const currentCounts = protectedFragmentCounts(currentFragments);
    for (const [fragment, count] of currentCounts) {
        if (previousCounts.get(fragment) !== count) return null;
    }
    const currentByFragment = new Map();
    for (const fragment of currentFragments) {
        const placeholders = currentByFragment.get(fragment.markdown) || [];
        placeholders.push(fragment.placeholder);
        currentByFragment.set(fragment.markdown, placeholders);
    }
    return previousFragments.map(fragment => (
        currentByFragment.get(fragment.markdown)?.shift() || null
    ));
}

function protectedFragmentCounts(fragments) {
    const counts = new Map();
    for (const fragment of fragments) {
        counts.set(fragment.markdown, (counts.get(fragment.markdown) || 0) + 1);
    }
    return counts;
}

function removeProtectedPlaceholder(markdown, placeholder) {
    const value = String(markdown || '');
    const index = value.indexOf(placeholder);
    if (index < 0 || index !== value.lastIndexOf(placeholder)) return value;
    const before = value.slice(0, index);
    const after = value.slice(index + placeholder.length);
    const leading = before.match(/[\t ]+$/u)?.[0] || '';
    const trailing = after.match(/^[\t ]+/u)?.[0] || '';
    const previous = before.slice(0, before.length - leading.length).at(-1) || '';
    const next = after.slice(trailing.length)[0] || '';
    if (leading && trailing) {
        return `${before.slice(0, -leading.length)} ${after.slice(trailing.length)}`;
    }
    if (leading && (!next || /[\p{P}\p{S}]/u.test(next))) {
        return before.slice(0, -leading.length) + after;
    }
    if (trailing && (!previous || /[\p{P}\p{S}]/u.test(previous))) {
        return before + after.slice(trailing.length);
    }
    return before + after;
}

function protectedContentChangedError() {
    const error = new Error(
        'The translated Markdown block changed protected content'
    );
    error.code = TRANSLATION_PROTECTED_CONTENT_CHANGED;
    return error;
}

function protectedTextTranslationParts(block) {
    if (!block?.translatable) {
        throw new TypeError(
            'Only translatable Markdown blocks can use protected text translation'
        );
    }
    const source = String(block.requestMarkdown || '');
    const parts = [];
    let cursor = 0;
    let segmentIndex = 0;
    const appendText = value => {
        if (!value) return;
        const leadingWhitespace = value.match(/^\s*/u)?.[0] || '';
        const withoutLeading = value.slice(leadingWhitespace.length);
        const trailingWhitespace = withoutLeading.match(/\s*$/u)?.[0] || '';
        const sourceText = withoutLeading.slice(
            0,
            withoutLeading.length - trailingWhitespace.length
        );
        if (!hasTranslatableContent(sourceText)) {
            parts.push({ type: 'literal', value });
            return;
        }
        parts.push({
            type: 'text',
            id: `segment-${segmentIndex}`,
            sourceText,
            leadingWhitespace,
            trailingWhitespace,
        });
        segmentIndex++;
    };
    for (const match of source.matchAll(PROTECTED_PLACEHOLDER_PATTERN)) {
        appendText(source.slice(cursor, match.index));
        parts.push({ type: 'protected', value: match[0] });
        cursor = match.index + match[0].length;
    }
    appendText(source.slice(cursor));
    return parts;
}

function placeholderNodePath(tree, source, placeholder) {
    const from = source.indexOf(placeholder);
    if (from < 0) return '';
    const to = from + placeholder.length;
    const path = [];
    for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
        if (node.from <= from && node.to >= to) path.push(node.name);
    }
    return path.reverse().join('/');
}

function restoreProtectedFragments(block, translated) {
    return (block.protectedFragments || []).reduce(
        (value, fragment) => value.replace(
            fragment.placeholder,
            () => fragment.markdown
        ),
        translated
    );
}

function hasTranslatableContent(markdown) {
    const content = String(markdown || '')
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, '')
        .replace(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/gm, '')
        .replace(/[\s|*_~`#>()[\]{}.!,:;\\/+-]/g, '');
    return /[\p{L}\p{N}]/u.test(content);
}

function isStandaloneDisplayMath(markdown) {
    const source = markdown.trim();
    return findDisplayMathMatches(source).some(match => (
        match.start === 0 && match.end === source.length
    ));
}

function translationBlockType(nodeName) {
    if (HEADING_PATTERN.test(nodeName)) return 'heading';
    return TRANSLATABLE_NODE_TYPES.get(nodeName) || 'structural';
}

function isTopLevelH1(block) {
    return isTopLevelH1Node(block?.nodeType);
}

function isTopLevelH1Node(nodeName) {
    return nodeName === 'ATXHeading1' || nodeName === 'SetextHeading1';
}

function isReferenceHeading(nodeName, markdown) {
    if (!HEADING_PATTERN.test(nodeName)) return false;
    const label = String(markdown || '')
        .replace(/^#{1,6}[ \t]+/, '')
        .replace(/[ \t]+#*[ \t]*$/, '')
        .replace(/\r?\n[=-]+[ \t]*$/, '')
        .replace(/[*_`]/g, '')
        .replace(/[：:][ \t]*$/, '')
        .trim();
    return REFERENCE_HEADING_PATTERN.test(label);
}

function topLevelNodes(markdown) {
    const nodes = [];
    for (let node = MARKDOWN_PARSER.parse(markdown).topNode.firstChild;
        node;
        node = node.nextSibling) {
        nodes.push(node);
    }
    return nodes;
}

function removeRepeatedComparisonImages(markdown, block) {
    let value = String(markdown || '');
    for (const fragment of block.protectedFragments || []) {
        if (!/^\s*(?:!\[[^\]]*\]\(|<img\b)/iu.test(fragment.markdown)) {
            continue;
        }
        value = value.replace(fragment.markdown, '');
    }
    const imageEdits = [];
    MARKDOWN_PARSER.parse(value).iterate({
        enter(node) {
            if (node.name !== 'Image') return undefined;
            const altRange = markdownImageAltRange(node.node);
            if (altRange) {
                imageEdits.push({
                    from: node.from,
                    to: node.to,
                    text: value.slice(altRange.from, altRange.to),
                });
            }
            return false;
        },
    });
    for (const edit of imageEdits.reverse()) {
        value = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
    }
    return value.trim();
}

function markdownImageAltRange(image) {
    const marks = [];
    for (let child = image.firstChild; child; child = child.nextSibling) {
        if (child.name === 'LinkMark') marks.push(child);
    }
    return marks.length >= 2 && marks[0].to <= marks[1].from
        ? { from: marks[0].to, to: marks[1].from }
        : null;
}

function parseTranslationResponse(response) {
    const value = String(response || '').trim();
    if (!value) throw new Error('The translated Markdown batch is empty');
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(value);
    try {
        return JSON.parse(fenced ? fenced[1] : value);
    }
    catch {
        throw new Error('The translated Markdown batch is not valid JSON');
    }
}

function estimateMarkdownTokens(markdown) {
    let ascii = 0;
    let nonAscii = 0;
    for (const character of String(markdown || '')) {
        if (character.codePointAt(0) <= 0x7f) ascii++;
        else nonAscii++;
    }
    return Math.ceil(ascii / 4) + nonAscii;
}
