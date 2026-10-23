import { validateMinerULayout } from './result-bundle.js';
import { ingestMinerULayout } from './ingest-layout.js';
import { ingestMinerUContentList } from './ingest-content-list.js';
import { classifyBlocks } from './classify.js';
import { attachFloatNotes } from './floats.js';
import { orderReadingFlow } from './reading-order.js';
import { assignHeadingLevels } from './headings.js';
import { stitchParagraphs } from './stitch.js';
import { validateDocumentIR } from './ir.js';
import { createHyphenationVocabulary } from './text.js';
import { DOCUMENT_STRUCTURE, serializeDocumentIR } from './serialize.js';

// Bundle fields that only feed the IR. The prepared document keeps the
// Markdown, its exact source map, the assets, and the page counts.
const INPUT_ONLY_FIELDS = ['contentList', 'layout', 'detailedLayout', 'figureTables'];

// Builds the reading-order document IR from a MinerU result bundle:
// layout.json first, content_list.json when no layout is available.
// Returns null when neither is usable.
export function buildMinerUDocumentIR(bundle) {
    const options = { assets: bundle?.assets || [], assetBasePath: bundle?.assetBasePath || '' };
    let ir = null;
    if (validateMinerULayout(bundle?.layout)) ir = ingestMinerULayout(bundle.layout, options);
    else if (Array.isArray(bundle?.contentList) && bundle.contentList.length) {
        ir = ingestMinerUContentList(bundle.contentList, options);
    }
    if (!ir) return null;
    classifyBlocks(ir);
    attachFloatNotes(ir);
    orderReadingFlow(ir);
    assignHeadingLevels(ir);
    stitchParagraphs(ir);
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
export function prepareMinerUDocument(bundle, { ir = buildMinerUDocumentIR(bundle), composites = null } = {}) {
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

export { serializeDocumentIR };
