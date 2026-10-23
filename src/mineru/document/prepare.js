import { validateMinerULayout } from './result-bundle.js';
import { ingestMinerULayout } from './ingest-layout.js';
import { ingestMinerUContentList } from './ingest-content-list.js';
import { classifyBlocks } from './classify.js';
import {
    attachFloatNotes,
    groupAdjacentTables,
    mergeContinuedTables,
    reassignFloatCaptions,
} from './floats.js';
import { orderReadingFlow } from './reading-order.js';
import { attachEquationNumbers } from './equations.js';
import { placePageNotes, restoreDiscardedReferences } from './notes.js';
import { assignHeadingLevels, levelHeadingsByStyle } from './headings.js';
import { groupSections } from './sections.js';
import { stitchParagraphs } from './stitch.js';
import { validateDocumentIR } from './ir.js';
import { attachPDFGeometry } from './pdf-geometry.js';
import { createHyphenationVocabulary } from './text.js';
import { DOCUMENT_STRUCTURE, serializeDocumentIR } from './serialize.js';
import { createFigureInputFromIR } from './figure-input.js';

// Bundle and figure-input fields that only feed the IR. The prepared document
// keeps the Markdown, its exact source map, the assets, and the page counts.
const INPUT_ONLY_FIELDS = [
    'contentList', 'layout', 'detailedLayout', 'figureTables',
    'blocks', 'pages', 'providerState', 'rangesExplicit',
];
const COMPOSITE_SUFFIX = ':composite';

// Builds the reading-order document IR from a MinerU result bundle:
// layout.json first, content_list.json when no layout is available.
// Returns null when neither is usable. `pdfText` is the PDF's own text
// index (see pdf-geometry.js); it gives the text real lines and fonts, and
// without it every page keeps block geometry.
export function buildMinerUDocumentIR(bundle, { pdfText = null } = {}) {
    const options = { assets: bundle?.assets || [], assetBasePath: bundle?.assetBasePath || '' };
    let ir = null;
    if (validateMinerULayout(bundle?.layout)) ir = ingestMinerULayout(bundle.layout, options);
    else if (Array.isArray(bundle?.contentList) && bundle.contentList.length) {
        ir = ingestMinerUContentList(bundle.contentList, options);
    }
    if (!ir) return null;
    attachPDFGeometry(ir, pdfText);
    classifyBlocks(ir);
    attachFloatNotes(ir);
    reassignFloatCaptions(ir);
    orderReadingFlow(ir);
    restoreDiscardedReferences(ir);
    groupAdjacentTables(ir);
    mergeContinuedTables(ir);
    attachEquationNumbers(ir);
    assignHeadingLevels(ir);
    stitchParagraphs(ir);
    placePageNotes(ir);
    groupSections(ir);
    levelHeadingsByStyle(ir);
    return validateDocumentIR(ir);
}

export function isPreparedMinerUDocument(document) {
    return document?.documentStructure === DOCUMENT_STRUCTURE
        && typeof document.markdown === 'string'
        && Array.isArray(document.sourceMap);
}

// The prepared reading document of a MinerU result. Markdown comes only from
// the IR; MinerU's own full.md is kept as-is only when the bundle carries no
// structure at all.
export function prepareMinerUDocument(bundle, {
    pdfText = null,
    ir = buildMinerUDocumentIR(bundle, { pdfText }),
    composites = [],
} = {}) {
    if (isPreparedMinerUDocument(bundle)) return bundle;
    const prepared = { ...(bundle || {}) };
    for (const field of INPUT_ONLY_FIELDS) delete prepared[field];
    if (!ir) {
        return {
            ...prepared,
            markdown: typeof bundle?.markdown === 'string' ? bundle.markdown : '',
            chromeRanges: [],
        };
    }
    const serialized = serializeDocumentIR(ir, {
        vocabulary: createHyphenationVocabulary(ir),
        composites,
    });
    return {
        ...prepared,
        markdown: serialized.markdown,
        sourceMap: serialized.sourceMap,
        chromeRanges: [],
        documentStructure: DOCUMENT_STRUCTURE,
    };
}

// The figure pipeline's input for a MinerU result bundle. Without a layout
// or content list it carries only the Markdown, so nothing is composed.
export function createMinerUFigureInput(bundle, { pdfText = null } = {}) {
    const ir = buildMinerUDocumentIR(bundle, { pdfText });
    if (!ir) {
        return {
            provider: 'mineru',
            rangesExplicit: true,
            markdown: String(bundle?.markdown || '').replace(/\r\n?/gu, '\n'),
            assets: bundle?.assets || [],
            assetBasePath: bundle?.assetBasePath || '',
            pages: [],
            blocks: [],
            contentList: [],
            providerState: {},
            extractedPages: bundle?.extractedPages,
            totalPages: bundle?.totalPages,
            warnings: Array.isArray(bundle?.warnings) ? [...bundle.warnings] : [],
        };
    }
    const serialized = serializeDocumentIR(ir, { vocabulary: createHyphenationVocabulary(ir) });
    return createFigureInputFromIR(ir, serialized, bundle);
}

// Prepares any MinerU document the pipeline hands over:
// - a prepared document (from the cache or a revision) is returned as is;
// - a figure input is written again from its IR, with each composed figure
//   in place of the pieces it consumed;
// - a result bundle is prepared from its layout or content list.
export function prepareMinerUResult(input) {
    if (isPreparedMinerUDocument(input) || input?.userEdited) return input;
    const ir = input?.providerState?.mineruDocument?.ir;
    if (ir) {
        const composites = (input.blocks || []).filter(block => (
            typeof block?.figureId === 'string' && block.id === `${block.figureId}${COMPOSITE_SUFFIX}`
            && typeof block.assetPath === 'string' && Array.isArray(block.memberBlockIds)
        )).map(block => ({
            id: block.id,
            figureId: block.figureId,
            assetPath: block.assetPath,
            captionText: typeof block.captionText === 'string' ? block.captionText : '',
            memberBlockIds: block.memberBlockIds,
            pageIndex: block.pageIndex,
            bbox: block.bbox,
        }));
        return prepareMinerUDocument(input, { ir, composites });
    }
    if (validateMinerULayout(input?.layout) || Array.isArray(input?.contentList) && input.contentList.length) {
        return prepareMinerUDocument(input);
    }
    // A document prepared by an earlier pipeline has no structure left to
    // rebuild; its Markdown and source map stay as they were.
    if (typeof input?.markdown === 'string' && Array.isArray(input.sourceMap)) return input;
    return prepareMinerUDocument(input);
}

export { serializeDocumentIR };
