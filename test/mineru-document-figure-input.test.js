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

function layoutBundle(pages, names, identity = {}) {
    return {
        markdown: 'full.md',
        assets: names.map(name => ({ path: `images/${name}`, mimeType: 'image/jpeg', data: new Uint8Array([1]) })),
        assetBasePath: '',
        layout: projectMinerULayout({
            _backend: 'hybrid',
            _version_name: '3.4.4',
            ...identity,
            pdf_info: pages,
        }),
        contentList: [],
    };
}

function layoutPage(pageIndex, blocks, pageSize = PAGE) {
    return { page_idx: pageIndex, page_size: pageSize, discarded_blocks: [], para_blocks: blocks };
}

function captionedFigure(name, caption) {
    return [
        text([60, 160, 540, 190], caption),
        imageBlock([60, 220, 540, 700], name),
    ];
}

function pdfGeometry(pageIndex, width, height, rotation = 0) {
    const swapped = rotation === 90 || rotation === 270;
    return {
        pageIndex, width, height, rotation, userUnit: 1,
        coordinateFrame: 'display-cropbox',
        viewBox: [0, 0, swapped ? height : width, swapped ? width : height],
        mediaBox: null,
        viewportTransform: swapped ? [0, 1, 1, 0, 0, 0] : [1, 0, 0, -1, 0, height],
    };
}

function restoreWith(input, geometries) {
    const byIndex = new Map(geometries.map(geometry => [geometry.pageIndex, geometry]));
    return new FigureRestorationService({
        hash,
        openPDF: async () => ({
            getPageGeometry: async pageIndex => byIndex.get(pageIndex),
            renderRegion: async () => ({ data: createTestPNG(80, 60), mimeType: 'image/png', width: 80, height: 60 }),
            close: async () => {},
        }),
    }).restore(input, { fileData: Uint8Array.of(1) });
}

function imageBlock(bbox, name, children = []) {
    return {
        type: 'image', bbox, blocks: [
            { type: 'image_body', bbox, lines: [line(bbox, { type: 'image', image_path: name })] },
            ...children,
        ],
    };
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
    const edited = { markdown: 'edited', userEdited: true, sourceMap: [], chromeRanges: [{ from: 0, to: 6 }] };
    assert.equal(prepareMinerUResult(edited), edited);
    assert.deepEqual(edited.chromeRanges, [{ from: 0, to: 6 }]);
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

test('splits one image block into span panels and composes them', () => {
    const input = createMinerUFigureInput(layoutBundle([layoutPage(0, [{
        type: 'image', bbox: [100, 80, 900, 760], blocks: [
            { type: 'image_body', bbox: [100, 100, 450, 700], lines: [line([100, 100, 450, 700], { type: 'image', image_path: 'a.jpg' })] },
            { type: 'image_body', bbox: [500, 100, 900, 700], lines: [line([500, 100, 900, 700], { type: 'image', image_path: 'b.jpg' })] },
            { type: 'image_caption', bbox: [100, 710, 900, 750], lines: [line([100, 710, 900, 750], 'Figure 1. Two panels.')] },
        ],
    }])], ['a.jpg', 'b.jpg']));
    const panels = input.blocks.filter(block => block.role === 'panel');
    assert.deepEqual(panels.map(block => block.bbox), [[100, 100, 450, 700], [500, 100, 900, 700]]);
    const caption = input.blocks.find(block => block.role === 'caption');
    assert.equal(caption.parentId, panels[0].parentId);
    assert.equal(caption.text, 'Figure 1. Two panels.');
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose', candidates[0].reason);
    assert.equal(candidates[0].panelBlockIds.length, 2);
    assert.equal(candidates[0].captionBlockIds.length, 1);
});

test('keeps blocks and defers geometry verification for every layout page size', () => {
    for (const identity of [
        { _backend: 'pipeline', _version_name: '3.4.5' },
        { _backend: 'vlm', _version_name: '999.0.0' },
        { _backend: 'vlm', _version_name: '3.4.5' },
        { _backend: 'hybrid', _version_name: '3.4.4' },
    ]) {
        const input = createMinerUFigureInput(layoutBundle(
            [layoutPage(0, [imageBlock([100, 100, 400, 400], 'a.jpg')])],
            ['a.jpg'],
            identity,
        ));
        assert.equal(input.pages[0].coordinateFrame, 'display-cropbox', JSON.stringify(identity));
        assert.equal(input.pages[0].geometryVerification, 'pending', JSON.stringify(identity));
        assert.equal(input.pages[0].geometryReason, undefined, JSON.stringify(identity));
        assert.equal(input.pages[0].width, 1000, JSON.stringify(identity));
        assert.ok(input.blocks.some(block => block.role === 'panel'), JSON.stringify(identity));
    }
});

test('composes a layout outside the old whitelist when the page size matches the PDF', async () => {
    const input = createMinerUFigureInput(layoutBundle([
        layoutPage(0, captionedFigure('a.jpg', 'Figure 1. Study flowchart.')),
    ], ['a.jpg'], { _backend: 'pipeline', _version_name: '1.0.0' }));
    const offline = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(offline[0].decision, 'compose', offline[0].reason);
    const draft = await restoreWith(input, [pdfGeometry(0, 1000, 1000)]);
    assert.equal(draft.blueprints.length, 1);
    assert.equal(draft.preserved.length, 0);
    assert.equal(draft.input.pages[0].coordinateFrame, 'display-cropbox');
    assert.equal(draft.input.pages[0].geometryVerification, 'verified');
});

test('preserves a mismatched page and still restores the others', async () => {
    const input = createMinerUFigureInput(layoutBundle([
        layoutPage(0, captionedFigure('a.jpg', 'Figure 1. Study flowchart.')),
        layoutPage(1, captionedFigure('b.jpg', 'Figure 2. Study flowchart.')),
    ], ['a.jpg', 'b.jpg'], { _backend: 'pipeline', _version_name: '1.0.0' }));
    const before = structuredClone(input.pages);
    const draft = await restoreWith(input, [
        pdfGeometry(0, 400, 500),
        pdfGeometry(1, 1000, 1000),
    ]);
    assert.deepEqual(input.pages, before);
    assert.deepEqual(draft.blueprints.map(item => item.pageIndex), [1]);
    const rejected = draft.preserved.filter(item => item.pageIndex === 0);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason, 'coordinate-mismatch');
    assert.equal(draft.preserved.some(item => item.pageIndex === 1), false);
    assert.equal(draft.input.pages[0].coordinateFrame, 'unknown');
    assert.equal(draft.input.pages[0].geometryReason, 'coordinate-mismatch');
    assert.equal(draft.input.pages[1].geometryVerification, 'verified');
});

test('composes a 90 degree page whose displayed PDF size is swapped', async () => {
    const input = createMinerUFigureInput(layoutBundle([
        layoutPage(0, captionedFigure('a.jpg', 'Figure 1. Study flowchart.'), [800, 600]),
    ], ['a.jpg'], { _backend: 'vlm', _version_name: '9.9.9' }));
    const geometry = pdfGeometry(0, 800, 600, 90);
    assert.deepEqual(geometry.viewBox, [0, 0, 600, 800]);
    const draft = await restoreWith(input, [geometry]);
    assert.equal(draft.blueprints.length, 1);
    assert.equal(draft.preserved.length, 0);
    assert.equal(draft.input.pages[0].rotation, 90);
    assert.equal(draft.input.pages[0].geometryVerification, 'verified');
});

test('keeps a content-list page unverified', () => {
    const input = createMinerUFigureInput({
        markdown: 'ignored',
        assets: [{ path: 'images/a.jpg', mimeType: 'image/jpeg', data: new Uint8Array([1]) }],
        contentList: [{
            type: 'image', assetPath: 'images/a.jpg', pageIndex: 0, bbox: [100, 100, 400, 400],
            captions: ['Figure 1. A result.'],
        }],
    });
    assert.equal(input.pages[0].coordinateFrame, 'unknown');
    assert.equal(input.pages[0].geometryEvidence, 'content-list-only');
    assert.equal(input.pages[0].geometryVerification, undefined);
});

test('composes a sibling caption and keeps short interior text with the figure', () => {
    const input = createMinerUFigureInput(layoutBundle([layoutPage(0, [
        text([60, 160, 540, 190], 'Figure 1. Study flowchart.'),
        imageBlock([60, 220, 540, 700], 'a.jpg'),
        text([200, 300, 400, 330], 'Group A results'),
    ])], ['a.jpg']));
    const caption = input.blocks.find(block => block.role === 'caption');
    assert.equal(caption.text, 'Figure 1. Study flowchart.');
    assert.equal(input.markdown.includes('Group A results'), false);
    const interior = input.blocks.find(block => block.id.endsWith('#interior'));
    assert.equal(interior.text, 'Group A results');
    const panel = input.blocks.find(block => block.role === 'panel');
    assert.ok(interior.bbox[0] >= panel.bbox[0] && interior.bbox[1] >= panel.bbox[1]
        && interior.bbox[2] <= panel.bbox[2] && interior.bbox[3] <= panel.bbox[3]);
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose', candidates[0].reason);
    assert.deepEqual(candidates[0].captionBlockIds, [caption.id]);
});

test('composes three adjacent charts without taking the following paragraph as a caption', () => {
    const chart = (bbox, name) => ({
        type: 'chart', bbox, blocks: [
            { type: 'chart_body', bbox, lines: [line(bbox, { type: 'chart', image_path: name })] },
        ],
    });
    const input = createMinerUFigureInput(layoutBundle([layoutPage(0, [
        chart([60, 100, 220, 280], 'a.jpg'),
        chart([250, 100, 420, 280], 'b.jpg'),
        chart([450, 100, 620, 280], 'c.jpg'),
        text([60, 300, 620, 340], 'Figure 1. Three panels of the result.'),
        text([60, 360, 620, 420], 'The following sentence explains the result in ordinary prose.'),
    ])], ['a.jpg', 'b.jpg', 'c.jpg']));
    const paragraph = input.blocks.find(block => block.text.startsWith('The following sentence'));
    assert.notEqual(paragraph.role, 'caption');
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose', candidates[0].reason);
    assert.equal(candidates[0].panelBlockIds.length, 3);
    assert.equal(candidates[0].captionBlockIds.length, 1);
    assert.equal(candidates[0].captionBlockIds.includes(paragraph.id), false);
});

test('composes a 2x2 chart grid and owns its panel labels', () => {
    const chart = (bbox, name, labelBox, label) => ({
        type: 'chart', bbox, blocks: [
            { type: 'chart_caption', bbox: labelBox, lines: [line(labelBox, label)] },
            { type: 'chart_body', bbox, lines: [line(bbox, { type: 'chart', image_path: name })] },
        ],
    });
    const input = createMinerUFigureInput(layoutBundle([layoutPage(0, [
        chart([60, 80, 280, 240], 'a.jpg', [70, 50, 100, 70], 'A'),
        chart([320, 80, 540, 240], 'b.jpg', [330, 50, 360, 70], 'B'),
        chart([60, 300, 280, 460], 'c.jpg', [70, 270, 100, 290], 'C'),
        chart([320, 300, 540, 460], 'd.jpg', [330, 270, 360, 290], 'D'),
        text([60, 480, 540, 530], 'Fig. 1. Four panels of one result.'),
    ])], ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']));
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose', candidates[0].reason);
    assert.equal(candidates[0].panelBlockIds.length, 4);
    assert.equal(candidates[0].captionBlockIds.length, 1);
    const owned = candidates[0].ownedTextBlockIds.map(id => input.blocks.find(block => block.id === id).text);
    assert.deepEqual(owned, ['A', 'B', 'C', 'D']);
});

test('composes side-by-side panels and owns their footnotes under an unpunctuated caption', () => {
    const input = createMinerUFigureInput(layoutBundle([layoutPage(0, [
        { type: 'image', bbox: [60, 200, 290, 480], blocks: [
            { type: 'image_body', bbox: [60, 200, 290, 460], lines: [line([60, 200, 290, 460], { type: 'image', image_path: 'a.jpg' })] },
            { type: 'image_footnote', bbox: [65, 462, 285, 478], lines: [line([65, 462, 285, 478], '(a) Left panel.')] },
        ] },
        { type: 'chart', bbox: [310, 200, 540, 480], blocks: [
            { type: 'chart_body', bbox: [310, 200, 540, 460], lines: [line([310, 200, 540, 460], { type: 'chart', image_path: 'b.jpg' })] },
            { type: 'chart_footnote', bbox: [315, 462, 535, 478], lines: [line([315, 462, 535, 478], '(b) Right panel.')] },
        ] },
        text([50, 500, 550, 560], 'Figure 1 The impact of reusable skills on sleep.'),
    ])], ['a.jpg', 'b.jpg']));
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose', candidates[0].reason);
    assert.equal(candidates[0].panelBlockIds.length, 2);
    const owned = candidates[0].ownedTextBlockIds.map(id => input.blocks.find(block => block.id === id).text);
    assert.deepEqual(owned, ['(a) Left panel.', '(b) Right panel.']);
    const caption = input.blocks.find(block => block.id === candidates[0].captionBlockIds[0]);
    assert.equal(caption.text, 'Figure 1 The impact of reusable skills on sleep.');
});

test('keeps a valid page frame when a later image block is empty', () => {
    const input = createMinerUFigureInput(layoutBundle([
        layoutPage(0, [imageBlock([100, 100, 800, 700], 'a.jpg')]),
        layoutPage(1, [{ type: 'image', bbox: [100, 100, 800, 700], blocks: [] }]),
    ], ['a.jpg']));
    assert.equal(input.pages[0].coordinateFrame, 'display-cropbox');
    assert.ok(input.blocks.some(block => block.pageIndex === 0 && block.bboxKind === 'visual-body'));
    assert.equal(input.blocks.some(block => block.pageIndex === 1 && block.role === 'panel'), false);
});

test('turns only a figure-captioned content-list table into an image', () => {
    const prepared = prepareMinerUDocument({
        markdown: 'ignored',
        assets: [
            { path: 'images/fig4.png', mimeType: 'image/png', data: new Uint8Array([1]) },
            { path: 'images/table2.png', mimeType: 'image/png', data: new Uint8Array([1]) },
        ],
        contentList: [
            {
                type: 'table', text: '<table><tr><td>Study</td></tr></table>',
                captions: ['Fig. 4. Forest plot.'], assetPath: 'images/fig4.png',
                pageIndex: 0, bbox: [100, 100, 900, 400],
            },
            {
                type: 'table', text: '<table><tr><td>A</td></tr></table>',
                captions: ['Table 2. Values.'], assetPath: 'images/table2.png',
                pageIndex: 0, bbox: [100, 420, 900, 700],
            },
        ],
    });
    assert.equal(prepared.markdown, [
        '![Fig. 4. Forest plot.](images/fig4.png)',
        'Table 2. Values.',
        '<table><tr><td>A</td></tr></table>',
    ].join('\n\n'));
    assert.equal(prepared.markdown.includes('table2.png'), false);
});
