import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import {
    buildMinerUDocumentIR,
    createMinerUFigureInput,
    prepareMinerUDocument,
    prepareMinerUResult,
} from '../src/mineru/document/prepare.js';
import { validateFigureInput } from '../src/figures/figure-model.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { buildProgressiveFigureDocument } from '../src/figures/figure-progressive.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { sha256Hex } from '../src/core/sha256.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });
const PAGE = [1000, 1000];
const BODY = 'The proposed method learns a representation of the signal that';
const REST = 'generalizes across tasks without retraining the whole model.';
const CAPTION = 'Fig. 1. Results [1] with a backslash \\ and math';

function line(bbox, ...spans) {
    return { bbox, spans: spans.map(span => typeof span === 'string' ? { bbox, type: 'text', content: span } : { bbox, ...span }) };
}

function text(bbox, content, type = 'text') {
    return { type, bbox, lines: [line(bbox, content)] };
}

function bundle() {
    const pages = [
        { page_idx: 0, page_size: PAGE, discarded_blocks: [], para_blocks: [
            { ...text([100, 40, 900, 70], 'A Study of Things', 'title'), level: 1 },
            text([100, 80, 900, 200], 'An opening paragraph before the figure ends here.'),
            { type: 'image', bbox: [100, 220, 900, 600], blocks: [
                { type: 'image_body', bbox: [100, 220, 900, 560], lines: [line([100, 220, 900, 560], { type: 'image', image_path: 'a.jpg' })] },
                { type: 'image_caption', bbox: [100, 565, 900, 590], lines: [line([100, 565, 900, 590], CAPTION, { type: 'inline_equation', content: 'x^2' })] },
            ] },
            text([100, 620, 900, 680], 'A paragraph after the figure, well below its caption.'),
            text([100, 700, 900, 960], BODY),
        ] },
        { page_idx: 1, page_size: PAGE, discarded_blocks: [], para_blocks: [
            text([100, 40, 900, 200], REST),
            { type: 'table', bbox: [100, 300, 900, 500], blocks: [
                { type: 'table_caption', bbox: [100, 300, 900, 320], lines: [line([100, 300, 900, 320], 'Table 1 Results')] },
                { type: 'table_body', bbox: [100, 320, 900, 480], lines: [line([100, 320, 900, 480], { type: 'table', html: '<table><tr><td>1</td></tr></table>' })] },
            ] },
        ] },
    ];
    return {
        markdown: 'full.md',
        assets: [{ path: 'images/a.jpg', mimeType: 'image/jpeg', data: new Uint8Array([1]) }],
        assetBasePath: '',
        layout: projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.4', pdf_info: pages }),
        contentList: [],
        extractedPages: 2,
        totalPages: 2,
    };
}

function service() {
    return new FigureRestorationService({
        hash,
        openPDF: async () => ({
            getPageGeometry: async pageIndex => ({ pageIndex, width: 1000, height: 1000, rotation: 0, userUnit: 1,
                coordinateFrame: 'display-cropbox', viewBox: [0, 0, 1000, 1000], mediaBox: null,
                viewportTransform: [1, 0, 0, -1, 0, 1000] }),
            renderRegion: async () => ({ data: createTestPNG(80, 60), mimeType: 'image/png', width: 80, height: 60 }),
            close: async () => {},
        }),
    });
}

test('names figure blocks by serialized pieces with exact Markdown ranges', () => {
    const input = createMinerUFigureInput(bundle());
    validateFigureInput(input);
    assert.equal(input.rangesExplicit, true);
    assert.equal(input.markdown, prepareMinerUDocument(bundle()).markdown);
    const byID = new Map(input.blocks.map(block => [block.id, block]));
    const group = input.blocks.find(block => block.bboxKind === 'group');
    assert.deepEqual(group.bbox, [100, 220, 900, 600]);
    const panel = input.blocks.find(block => block.role === 'panel');
    assert.equal(panel.parentId, group.id);
    const image = input.markdown.slice(panel.sourceRanges[0].from, panel.sourceRanges[0].to);
    assert.match(image, /^!\[Fig\. 1\. .*\]\(images\/a\.jpg\)$/u);
    const caption = byID.get(`${group.id}:caption0`);
    assert.equal(caption.text, `${CAPTION} $x^2$`);
    assert.equal(caption.embeddedCaption, true);
    assert.equal(input.markdown.slice(caption.sourceRanges[0].from, caption.sourceRanges[0].to),
        'Fig. 1. Results \\[1\\] with a backslash \\\\ and math $x^2$');
    // The paragraph stitched across the page break is located but never consumed.
    const stitched = input.blocks.filter(block => block.text.startsWith(BODY) || block.text.startsWith(REST));
    assert.equal(stitched.length, 2);
    assert.ok(stitched.every(block => block.rangeEvidence === 'unresolved' && !block.sourceRanges.length && block.bbox));
    // A table caption does not block a figure; the table body is located.
    const tableCaption = input.blocks.find(block => block.type === 'table' && block.id.endsWith(':caption'));
    assert.equal(tableCaption.bbox, null);
    assert.ok(input.blocks.find(block => block.type === 'table' && block.id.endsWith(':body')).bbox);
    assert.equal(input.providerState.mineruDocument.ir.schema, 'mktero-mineru-ir-v1');
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose', candidates[0].reason);
});

test('writes a composed figure in place of its members and finalizes it', async () => {
    const input = createMinerUFigureInput(bundle());
    const draft = await service().restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.blueprints.length, 1);
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.equal(document.figureMap.figures.length, 1);
    assert.equal(document.documentStructure, 'mineru-ir-v1');
    const figure = document.figureMap.figures[0];
    const rendered = document.markdown.slice(figure.render.range.from, figure.render.range.to);
    assert.equal(rendered, `![Fig. 1. Results \\[1\\] with a backslash \\\\ and math $x^2$](${figure.render.assetPath})`);
    assert.equal(document.markdown.split('images/a.jpg').length, 1);
    assert.ok(document.markdown.includes(`${BODY} ${REST}`));
    assert.ok(document.markdown.includes('A paragraph after the figure'));
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    for (const field of ['blocks', 'pages', 'providerState', 'rangesExplicit', 'contentList', 'layout']) {
        assert.equal(field in document, false, field);
    }
});

test('an in-progress document equals the first serialization', async () => {
    const input = createMinerUFigureInput(bundle());
    const provisional = await buildProgressiveFigureDocument(input, [], { prepare: prepareMinerUResult });
    const plain = prepareMinerUDocument(bundle());
    assert.equal(provisional.markdown, plain.markdown);
    assert.deepEqual(provisional.sourceMap, plain.sourceMap);
});

test('prepares each kind of MinerU input exactly once', () => {
    const prepared = prepareMinerUResult(bundle());
    assert.equal(prepareMinerUResult(prepared), prepared);
    const edited = { markdown: 'edited', userEdited: true, sourceMap: [] };
    assert.equal(prepareMinerUResult(edited), edited);
    const earlier = { markdown: 'earlier pipeline', sourceMap: [], chromeRanges: [] };
    assert.equal(prepareMinerUResult(earlier), earlier);
    assert.equal(prepareMinerUResult({ markdown: '# Raw', assets: [] }).markdown, '# Raw');
});

test('falls back to the Markdown alone when a bundle has no structure', () => {
    const input = createMinerUFigureInput({ markdown: 'Plain\r\ntext', assets: [] });
    validateFigureInput(input);
    assert.equal(input.markdown, 'Plain\ntext');
    assert.deepEqual(input.blocks, []);
    assert.equal(buildMinerUDocumentIR({ markdown: 'x' }), null);
});
