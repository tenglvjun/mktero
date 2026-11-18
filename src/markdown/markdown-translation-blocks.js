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
import { REFERENCE_HEADING_LABEL_PATTERN } from './reference-heading.js';
import {
    projectMarkdownRanges,
    PROTECTED_PLACEHOLDER_PATTERN,
    protectedContentChangedError,
    TRANSLATION_MARKDOWN_PARSER as MARKDOWN_PARSER,
    trimmedRange,
    validateTranslatedBlock,
    verifyAlignedBlock,
} from './translation-alignment.js';

export {
    TRANSLATION_PROTECTED_CONTENT_CHANGED,
    validateTranslatedBlock,
} from './translation-alignment.js';
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
const DOCUMENT_MARKER_PATTERN = /MKTEROBLOCK\d+(?:START|END)MARKER/g;
const NUMERIC_CITATION_PATTERN = /\[(?:\d{1,4}[a-z]?(?:[ \t]*[-–—,，;；][ \t]*\d{1,4}[a-z]?)*)(?:[ \t]*,[ \t]*)?\]/giu;
export const BILINGUAL_LIST_BOUNDARY =
    '<!-- mktero-bilingual-list-boundary -->';
export const MAX_TRANSLATION_BATCH_BLOCKS = 8;
export const MAX_TRANSLATION_BATCH_SOURCE_TOKENS = 2_000;
// A sentence continued across display math ("…is given by" $$…$$ "where …")
// stays in one batch even past the soft limits, up to this much more.
const CONTINUATION_BATCH_SLACK = 1.5;
const OPEN_SENTENCE_END = /(?:[\p{L}\p{N},;:：)\]$]|\\\))$/u;
const CLOSED_SENTENCE_END = /[.!?。！？]["'”’)\]]*$/u;
const TRAILING_IMAGE = /!\[[^\]]*\]\([^)]*\)$/u;

export function collectMarkdownTranslationBlocks(markdown, { chromeRanges } = {}) {
    const source = String(markdown || '');
    const hidden = normalizeChromeRanges(chromeRanges, source.length);
    const blocks = [];
    const interactiveRanges = collectInteractiveRanges(source);
    let interactiveRangeIndex = 0;
    const createPlaceholder = createProtectedPlaceholderFactory(source);
    const createDocumentMarkers = createDocumentMarkerFactory(source);
    let ordinal = 0;
    // A reference list runs from its heading until a heading of the same or a
    // higher level. Ending it on an H1 alone skipped everything after the
    // references in a paper whose sections are all H2 (Nature and Science set
    // Acknowledgements, Author contributions, and Data availability after the
    // reference list).
    let referenceSection = false;
    let referenceLevel = 0;
    for (let node = MARKDOWN_PARSER.parse(source).topNode.firstChild;
        node;
        node = node.nextSibling) {
        const blockMarkdown = source.slice(node.from, node.to);
        const headingLevel = headingNodeLevel(node.name);
        if (isReferenceHeading(node.name, blockMarkdown)) {
            referenceSection = true;
            referenceLevel = headingLevel || 6;
        }
        else if (referenceSection && headingLevel && headingLevel <= referenceLevel) {
            referenceSection = false;
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
    linkEquationContinuations(blocks);
    return blocks;
}

// A paragraph that continues the sentence of the paragraph before a display
// equation names it in `continuesFrom`; the equation between them names it
// in `continuationOf`. The blocks stay separate, so the document structure
// and the comparison view are unchanged; the batcher keeps the group in one
// request and the request tells the model the two parts are one sentence.
function linkEquationContinuations(blocks) {
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (!block.translatable || block.type !== 'paragraph') continue;
        let next = index + 1;
        while (next < blocks.length && isDisplayMathBlock(blocks[next])) next++;
        if (next === index + 1 || next >= blocks.length) continue;
        const following = blocks[next];
        if (!following.translatable || following.type !== 'paragraph') continue;
        const head = block.markdown.trimEnd();
        if (CLOSED_SENTENCE_END.test(head) || !OPEN_SENTENCE_END.test(head) || TRAILING_IMAGE.test(head)) continue;
        if (!/^\p{Ll}/u.test(following.markdown.trimStart())) continue;
        block.continuesAcrossEquation = true;
        following.continuesFrom = block.id;
        for (let between = index + 1; between < next; between++) blocks[between].continuationOf = block.id;
        index = next - 1;
    }
}

function isDisplayMathBlock(block) {
    return block?.type === 'paragraph' && !block.translatable && isStandaloneDisplayMath(block.markdown);
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
        // The rest of a continued sentence joins its start while the batch
        // stays within the slack.
        const anchor = block.continuesFrom || block.continuationOf;
        const keepsSentence = anchor && batchBlocks.some(item => item.id === anchor)
            && translatableCount < maxBlocks * CONTINUATION_BATCH_SLACK
            && sourceTokens + blockTokens <= maxSourceTokens * CONTINUATION_BATCH_SLACK;
        if (batchBlocks.length && (exceedsBlockLimit || exceedsTokenLimit) && !keepsSentence) {
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
    const sent = new Set(blocks.filter(block => block.translatable).map(block => block.id));
    return JSON.stringify(blocks.flatMap(block => block.translatable ? [{
        id: block.id,
        sourceMarkdown: block.requestMarkdown,
        ...(block.continuesFrom && sent.has(block.continuesFrom) ? { continuesFrom: block.continuesFrom } : {}),
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
    return createComparisonView(markdown, blocks, translations);
}

function createComparisonView(markdown, blocks, translations, alignedByID) {
    const source = String(markdown || '');
    const translatedByID = validateTranslationSet(blocks, translations);
    const chunks = [];
    const sourceRanges = [];
    const translationRanges = [];
    const blockRanges = [];
    const alignmentRanges = new Map();
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
            const { markdown: translated, ranges } = removeRepeatedComparisonImages(
                restored,
                block,
                alignedByID?.get(block.id)?.restoredRanges
            );
            if (ranges) alignmentRanges.set(block.id, ranges);
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
        ...(alignedByID ? { alignmentRanges } : {}),
    };
}

export function createDocumentTranslationViews(markdown, blocks, translations, { figureMap = null, targetLanguage } = {}) {
    const translated = createTranslatedMarkdownView(markdown, blocks, translations);
    const source = String(markdown || '');
    const blocksByID = new Map(blocks.map(block => [block.id, block]));
    const alignedByID = new Map();
    for (const translation of translations) {
        if (!translation?.alignment) continue;
        const block = blocksByID.get(translation.id);
        if (!block?.translatable || source.slice(block.from, block.to) !== block.markdown) continue;
        const verified = verifyAlignedBlock(block, translation, targetLanguage);
        if (verified) alignedByID.set(block.id, verified);
    }
    const comparison = createComparisonView(markdown, blocks, translations, alignedByID);
    const comparisonByID = new Map(comparison.blockRanges.map(range => [range.id, range]));
    const blockRanges = translated.blockRanges.map(range => {
        const combined = { ...range, ...comparisonByID.get(range.id) };
        const aligned = alignedByID.get(range.id);
        if (aligned) combined.alignmentUnits = projectAlignmentUnits(
            combined, aligned, comparison.alignmentRanges.get(range.id)
        );
        return combined;
    });
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

function projectAlignmentUnits(block, aligned, comparisonRanges) {
    return aligned.units.map(({ id }, index) => {
        const translated = aligned.restoredRanges[index];
        const comparison = Number.isSafeInteger(block.comparisonTranslationFrom) ? comparisonRanges?.[index] : null;
        return {
            id,
            sourceRanges: aligned.sourceRanges[index].map(range => offsetRange(range, block.sourceFrom)),
            comparisonSourceRanges: aligned.sourceRanges[index].map(range => offsetRange(range, block.comparisonSourceFrom)),
            translatedFrom: translated.from + block.translatedFrom,
            translatedTo: translated.to + block.translatedFrom,
            comparisonTranslationFrom: comparison ? comparison.from + block.comparisonTranslationFrom : null,
            comparisonTranslationTo: comparison ? comparison.to + block.comparisonTranslationFrom : null,
        };
    });
}

function offsetRange({ from, to }, offset) {
    return { from: from + offset, to: to + offset };
}

export function mapAlignedTranslationSelection(range, blockRanges, view) {
    const selection = normalizeDocumentRange(range);
    if (!selection || !Array.isArray(blockRanges) || (view !== 'translated' && view !== 'compare')) return [];
    const translated = view === 'translated';
    return blockRanges.flatMap(block => (block.alignmentUnits || []).filter(unit => {
        const from = translated ? unit.translatedFrom : unit.comparisonTranslationFrom;
        const to = translated ? unit.translatedTo : unit.comparisonTranslationTo;
        return Number.isSafeInteger(from) && Number.isSafeInteger(to)
            && from < selection.to && to > selection.from;
    }));
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

// Translation rewrites the text inside a block, so character offsets do not
// survive the way they do on the verbatim comparison source side. Source
// ranges therefore map at block granularity: the whole translated block.
// That is exactly the source peek's granularity, whose entries are top-level
// blocks.
export function mapSourceRangeToTranslation(range, blockRanges) {
    const sourceRange = normalizeDocumentRange(range);
    if (!sourceRange || !Array.isArray(blockRanges)) return null;
    const block = blockRanges.find(candidate => (
        sourceRange.from >= candidate.sourceFrom
        && sourceRange.to <= candidate.sourceTo
    ));
    if (!block
        || !Number.isSafeInteger(block.translatedFrom)
        || !Number.isSafeInteger(block.translatedTo)
        || block.translatedTo <= block.translatedFrom) {
        return null;
    }
    return { from: block.translatedFrom, to: block.translatedTo };
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

// Chinese need not put whitespace between a full stop and the next sentence.
const SENTENCE_END = /[.!?\u3002\uff01\uff1f]+["'\u201d\u2019)\]]*/gu;
const ABBREVIATION_BEFORE = /\b(?:et\s+al|e\.g|i\.e|fig|figs|eq|eqs|ref|refs|sec|secs|no|nos|vs|cf|approx|ca|resp|dr|prof|st|vol|vols|pp|ch|tab)$/iu;
const NEXT_WORD = /^\s*\p{Ll}/u;

export function splitTranslatedBlockSentences(text, { listItems = false } = {}) {
    const source = String(text || '');
    if (!source.trim()) return [];
    if (listItems) {
        return translationSelectionStructure(source, 'list')?.ranges || [];
    }
    const sentences = [];
    SENTENCE_END.lastIndex = 0;
    let cursor = 0;
    let match;
    while ((match = SENTENCE_END.exec(source)) !== null) {
        const end = match.index + match[0].length;
        if (match[0] === '.') {
            if (/\d/u.test(source.charAt(match.index - 1))) {
                if (/\d/u.test(source.charAt(end))) continue;
            }
            else if (ABBREVIATION_BEFORE.test(source.slice(cursor, match.index))
                || NEXT_WORD.test(source.slice(end))) {
                continue;
            }
        }
        pushSentenceSpan(sentences, source, cursor, end);
        cursor = end;
    }
    pushSentenceSpan(sentences, source, cursor, source.length);
    return sentences;
}

function pushSentenceSpan(spans, source, from, to) {
    const slice = source.slice(from, to);
    const leading = slice.length - slice.trimStart().length;
    const trimmedEnd = slice.trimEnd().length;
    if (!slice.trim()) return;
    spans.push({
        from: from + leading,
        to: from + trimmedEnd,
    });
}

function translationSelectionStructure(text, type) {
    if (type && type !== 'list' && type !== 'table') return null;
    const node = MARKDOWN_PARSER.parse(text).topNode.firstChild;
    if (!node || node.nextSibling) return null;
    const parsedType = translationBlockType(node.name);
    if (type && type !== parsedType) return null;
    if (parsedType === 'list') return listSelectionStructure(node);
    if (parsedType === 'table') return tableSelectionStructure(node);
    return null;
}

function listSelectionStructure(list) {
    const shape = [];
    const ranges = [];
    list.cursor().iterate(node => {
        if (node.name === 'ListItem') ranges.push({ from: node.from, to: node.to });
        else if (node.name !== 'BulletList' && node.name !== 'OrderedList'
            && node.name !== 'Blockquote') return false;
        // Keep both ends of each container: moving a sublist to another item
        // must not match, even when the total number of items stays the same.
        shape.push(node.name);
    }, () => shape.push('/'));
    return { type: 'list', shape: shape.join(' '), ranges };
}

function tableSelectionStructure(table) {
    const widths = [];
    const ranges = [];
    for (let row = table.firstChild; row; row = row.nextSibling) {
        if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
        const cells = [];
        let cell = null;
        for (let child = row.firstChild; child; child = child.nextSibling) {
            if (child.name === 'TableCell') cell = { from: child.from, to: child.to };
            // Lezer omits empty TableCell nodes but keeps their delimiters.
            else if (child.name === 'TableDelimiter' && child.prevSibling) {
                cells.push(cell);
                cell = null;
            }
        }
        if (cell) cells.push(cell);
        widths.push(cells.length);
        // GFM does not render columns beyond the header. They count towards
        // the structure check but cannot be selected as a source cell.
        for (let i = 0; i < Math.min(widths[0], cells.length); i++) ranges.push(cells[i]);
    }
    return { type: 'table', shape: widths.join(','), ranges };
}

// A stored translation identifies a block, not the order of sentences in it.
// Only a matching Markdown structure supplies finer original coordinates.
export function mapTranslatedSentenceToSource(range, blockRanges, view, {
    markdown = '',
    comparisonMarkdown = '',
    translatedMarkdown = '',
} = {}) {
    const translatedRange = normalizeDocumentRange(range);
    if (!translatedRange || !Array.isArray(blockRanges)) return null;
    const side = view === 'translated' ? 'translated' : 'comparison';
    const viewMarkdown = side === 'translated'
        ? String(translatedMarkdown || '')
        : String(comparisonMarkdown || '');
    const bounds = block => (
        side === 'translated'
            ? { from: block.translatedFrom, to: block.translatedTo }
            : {
                from: block.comparisonTranslationFrom,
                to: block.comparisonTranslationTo,
            }
    );
    const block = blockRanges.find(candidate => {
        const candidateRange = bounds(candidate);
        return Number.isSafeInteger(candidateRange.from)
            && Number.isSafeInteger(candidateRange.to)
            && candidateRange.to > candidateRange.from
            && translatedRange.from >= candidateRange.from
            && translatedRange.to <= candidateRange.to;
    });
    if (!block
        || !Number.isSafeInteger(block.sourceFrom)
        || !Number.isSafeInteger(block.sourceTo)
        || block.sourceTo <= block.sourceFrom
        || !viewMarkdown) {
        return null;
    }
    const translatedBounds = bounds(block);
    const source = String(markdown || '').slice(block.sourceFrom, block.sourceTo);
    const original = translationSelectionStructure(source, block.type);
    const wholeBlock = {
        id: block.id,
        from: block.sourceFrom,
        to: block.sourceTo,
        sourceBlockFrom: block.sourceFrom,
        sourceBlockTo: block.sourceTo,
        viewFrom: side === 'comparison'
            && Number.isSafeInteger(block.comparisonSourceFrom)
            ? block.comparisonSourceFrom
            : null,
        viewTo: side === 'comparison'
            && Number.isSafeInteger(block.comparisonSourceTo)
            ? block.comparisonSourceTo
            : null,
        granularity: 'block',
        sentenceCount: original?.type === 'list' ? original.ranges.length
            : original ? 0 : splitTranslatedBlockSentences(source).length,
    };
    if (!original) return wholeBlock;
    const translated = translationSelectionStructure(
        viewMarkdown.slice(translatedBounds.from, translatedBounds.to), original.type
    );
    if (translated?.shape !== original.shape) return wholeBlock;
    // In a nested list, prefer the innermost item containing the selection.
    const index = translated.ranges.findLastIndex(unit => unit && (
        translatedRange.from >= unit.from + translatedBounds.from
        && translatedRange.to <= unit.to + translatedBounds.from
    ));
    const unit = original.ranges[index];
    if (!unit) return wholeBlock;
    return {
        ...wholeBlock,
        from: block.sourceFrom + unit.from,
        to: block.sourceFrom + unit.to,
        viewFrom: wholeBlock.viewFrom === null ? null : wholeBlock.viewFrom + unit.from,
        viewTo: wholeBlock.viewFrom === null ? null : wholeBlock.viewFrom + unit.to,
        granularity: original.type === 'table' ? 'cell' : 'sentence',
    };
}

export function mapTranslatedRangeToSourceBlock(range, blockRanges, view) {
    const translatedRange = normalizeDocumentRange(range);
    if (!translatedRange || !Array.isArray(blockRanges)) return null;
    const side = view === 'translated' ? 'translated' : 'comparison';
    const bounds = block => (
        side === 'translated'
            ? { from: block.translatedFrom, to: block.translatedTo }
            : {
                from: block.comparisonTranslationFrom,
                to: block.comparisonTranslationTo,
            }
    );
    const block = blockRanges.find(candidate => {
        const candidateRange = bounds(candidate);
        return Number.isSafeInteger(candidateRange.from)
            && Number.isSafeInteger(candidateRange.to)
            && candidateRange.to > candidateRange.from
            && translatedRange.from >= candidateRange.from
            && translatedRange.to <= candidateRange.to;
    });
    if (!block
        || !Number.isSafeInteger(block.sourceFrom)
        || !Number.isSafeInteger(block.sourceTo)
        || block.sourceTo <= block.sourceFrom) {
        return null;
    }
    return {
        id: block.id,
        from: block.sourceFrom,
        to: block.sourceTo,
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

function headingNodeLevel(nodeName) {
    const match = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(
        String(nodeName || '')
    );
    return match ? Number(match[1]) : 0;
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
    return REFERENCE_HEADING_LABEL_PATTERN.test(label);
}

function removeRepeatedComparisonImages(markdown, block, ranges) {
    let value = String(markdown || '');
    for (const fragment of block.protectedFragments || []) {
        if (!/^\s*(?:!\[[^\]]*\]\(|<img\b)/iu.test(fragment.markdown)) {
            continue;
        }
        const from = value.indexOf(fragment.markdown);
        if (from >= 0) {
            const to = from + fragment.markdown.length;
            if (ranges) ranges = projectMarkdownRanges(ranges, [{ from, to, text: '' }]);
            value = value.slice(0, from) + value.slice(to);
        }
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
    if (ranges) ranges = projectMarkdownRanges(ranges, imageEdits);
    for (const edit of imageEdits.reverse()) {
        value = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
    }
    const contentStart = value.length - value.trimStart().length;
    const trimmed = value.trim();
    return {
        markdown: trimmed,
        ranges: ranges?.map(range => {
            const inner = trimmedRange(value, range);
            return inner ? offsetRange(inner, -contentStart) : null;
        }),
    };
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
