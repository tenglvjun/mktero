import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { ingestMinerULayout } from '../src/mineru/document/ingest-layout.js';
import { blockPlainText } from '../src/mineru/document/ir.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { validateFigureInput } from '../src/figures/figure-model.js';
import { sha256Hex } from '../src/core/sha256.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });
const UPPER = 'Fig. 14 Distribution of the estimates';
const SHARED = 'Fig. 15 Comparison of (A) the first outcome and (B) the second outcome';
const PRINTED = SHARED.replace('(A)', '( A )').replace('(B)', '( B )');

function text(type, bbox, content) {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function picture(bbox, name, caption, captionBBox) {
    return { type: 'chart', bbox, blocks: [
        { type: 'chart_body', bbox, lines: [{ bbox, spans: [{ type: 'image', bbox, image_path: name }] }] },
        ...(caption ? [text('chart_caption', captionBBox, caption)] : []),
    ] };
}

function line(value, x, bottom, width) {
    return { text: value, width, height: 10, transform: [10, 0, 0, 10, x, 1000 - bottom] };
}

function fixture(change = () => {}) {
    const blocks = [
        picture([100, 100, 900, 400], 'upper.png', 'B', [505, 455, 515, 470]),
        picture([150, 450, 470, 650], 'left.png', UPPER, [90, 410, 390, 425]),
        picture([500, 450, 850, 650], 'right.png', SHARED, [90, 670, 790, 685]),
        text('text', [100, 800, 900, 830], 'The following paragraph remains after both figures.'),
    ];
    const items = [line(UPPER, 90, 425, 300), line(PRINTED, 90, 685, 700)];
    change({ blocks, items });
    const result = {
        markdown: '', assetBasePath: '',
        assets: ['upper.png', 'left.png', 'right.png'].map(name => ({
            path: `images/${name}`, mimeType: 'image/png', data: createTestPNG(),
        })),
        layout: projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.4', pdf_info: [{
            page_idx: 0, page_size: [1000, 1000], para_blocks: blocks, discarded_blocks: [],
        }] }),
    };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: 1000, height: 1000, transform: [1, 0, 0, -1, 0, 1000] }, items,
    }] };
    return { result, pdfText };
}

function restore(change) {
    const { result, pdfText } = fixture(change);
    const ir = ingestMinerULayout(result.layout);
    restorePDFFigureCaptions(ir, pdfText);
    return { ir, pdfText };
}

const captions = block => block.children.filter(child => child.kind === 'caption');
const strings = block => captions(block).map(blockPlainText);

// Generated geometry and invented legends exercise the failure without a
// dependency on one paper's images, wording, page dimensions or identifiers.
test('plans a displaced legend and an out-of-parent panel letter together', () => {
    const { ir, pdfText } = restore();
    const [upper, left, right] = ir.blocks;
    assert.deepEqual(strings(upper), [UPPER]);
    assert.deepEqual(strings(left), []);
    assert.deepEqual(strings(right), [SHARED, 'B']);
    assert.equal(upper.pdfFigure.label, 'Fig. 14');
    assert.equal(left.pdfFigure.label, 'Fig. 15');
    assert.equal(right.pdfFigure.label, 'Fig. 15');
    assert.equal(left.pdfFigure.group, true);
    assert.equal(captions(right).find(child => blockPlainText(child) === 'B').pdfPanelLabel, true);
    assert.deepEqual(ir.captionMoves.filter(move => move.reason === 'panel-label')
        .map(move => [move.from, move.to]), [['p0-0', 'p0-2']]);
    const before = structuredClone(ir.blocks);
    const moves = structuredClone(ir.captionMoves);
    restorePDFFigureCaptions(ir, pdfText);
    assert.deepEqual(ir.blocks, before);
    assert.deepEqual(ir.captionMoves, moves);
});

for (const marker of ['b', '(b)', '( B )', 'B.', '（ B ）']) {
    test(`recognizes ${marker} as an interior panel label without rewriting it`, () => {
        const { ir } = restore(({ blocks }) => {
            blocks[0].blocks[1].lines[0].spans[0].content = marker;
        });
        assert.deepEqual(strings(ir.blocks[0]), [UPPER]);
        assert.ok(strings(ir.blocks[2]).includes(marker));
        assert.equal(ir.blocks[1].pdfFigure.group, true);
    });
}

test('matches full-width panel references in a native legend', () => {
    const { ir } = restore(({ items }) => {
        items[1].text = PRINTED.replaceAll('(', '（').replaceAll(')', '）');
    });
    assert.deepEqual(strings(ir.blocks[0]), [UPPER]);
    assert.equal(ir.blocks[1].pdfFigure.group, true);
    assert.equal(ir.captionMoves.filter(move => move.reason === 'panel-label').length, 1);
});

test('repairs captions above a panel row as well as captions below it', () => {
    const { ir } = restore(({ blocks, items }) => {
        const reflect = value => {
            if (!value || typeof value !== 'object') return;
            if (value.bbox) {
                const [left, top, right, bottom] = value.bbox;
                value.bbox = [left, 1000 - bottom, right, 1000 - top];
            }
            for (const key of ['blocks', 'lines', 'spans']) for (const child of value[key] || []) reflect(child);
        };
        blocks.forEach(reflect);
        for (const item of items) item.transform[5] = 1000 - item.transform[5] - item.height;
    });
    assert.deepEqual(strings(ir.blocks[0]), [UPPER]);
    assert.deepEqual(strings(ir.blocks[1]), []);
    assert.equal(ir.blocks[2].pdfFigure.label, 'Fig. 15');
    assert.equal(ir.blocks[1].pdfFigure.group, true);
});

for (const [reason, change] of [
    ['a missing destination for the displaced legend', ({ blocks }) => {
        blocks[0].bbox = blocks[0].blocks[0].bbox = [100, 0, 900, 100];
    }],
    ['a panel letter outside every panel', ({ blocks }) => {
        blocks[0].blocks[1].bbox = [950, 455, 960, 470];
    }],
    ['a panel letter shared by two possible panels', ({ blocks }) => {
        blocks[1].bbox = blocks[1].blocks[0].bbox = [150, 450, 490, 650];
        blocks[0].blocks[1].bbox = [490, 455, 500, 470];
    }],
    ['duplicate copies of the same panel letter', ({ blocks }) => {
        blocks[0].blocks.push(structuredClone(blocks[0].blocks[1]));
    }],
    ['overlapping source and panel bands', ({ blocks }) => {
        blocks[0].bbox = blocks[0].blocks[0].bbox = [100, 100, 600, 600];
        blocks[0].blocks[1].bbox = [770, 455, 780, 470];
    }],
    ['a mismatched figure number', ({ items }) => {
        items[0].text = UPPER.replace('14', '24');
    }],
    ['no explicit panel descriptions', ({ items, blocks }) => {
        const value = SHARED.replace('(A)', '(P)').replace('(B)', '(Q)');
        items[1].text = value;
        blocks[2].blocks[1].lines[0].spans[0].content = value;
    }],
    ['intervening body prose', ({ blocks }) => {
        blocks.push(text('text', [100, 402, 900, 409],
            'An independent paragraph separates the upper image from the alleged caption below it.'));
    }],
]) {
    test(`does not commit the joint repair with ${reason}`, () => {
        const { ir } = restore(change);
        assert.ok(strings(ir.blocks[0]).includes('B'));
        assert.ok(strings(ir.blocks[1]).includes(UPPER));
        assert.equal((ir.captionMoves || []).some(move => move.reason === 'panel-label'), false);
        assert.equal(ir.blocks[1].pdfFigure?.group, undefined);
    });
}

test('keeps independent legends on the same side of adjacent figures', () => {
    const { ir } = restore(({ blocks, items }) => {
        blocks[1].blocks[1].bbox = [100, 670, 450, 685];
        items[0] = line(UPPER, 100, 685, 350);
        items[1] = line(PRINTED, 500, 685, 400);
        blocks[2].blocks[1].bbox = [500, 670, 900, 685];
    });
    assert.ok(strings(ir.blocks[1]).includes(UPPER));
    assert.ok(strings(ir.blocks[2]).includes(SHARED));
    assert.equal(ir.blocks[1].pdfFigure?.group, undefined);
    assert.equal((ir.captionMoves || []).some(move => move.reason === 'panel-label'), false);
});

function harness(recover) {
    const requests = [];
    const service = new FigureRestorationService({ hash, openPDF: async () => ({
        getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
            rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
            viewBox: [0, 0, 1000, 1000], viewportTransform: [1, 0, 0, -1, 0, 1000] }),
        recoverImageGroup: async request => { requests.push(request); return recover(request); },
        renderRegion: async () => { throw new Error('Use the verified native crop'); },
        close: async () => {},
    }) });
    return { service, requests };
}

function verified(request) {
    const upper = request.caption.label === 'Fig. 14';
    return { bbox: upper ? [100, 100, 900, 400] : [150, 450, 850, 650],
        captionBBox: request.caption.bbox, rotation: 0,
        crop: { data: createTestPNG(700, 200), mimeType: 'image/png', width: 700, height: 200 } };
}

for (const transferred of [false, true]) {
    test(`serializes ${transferred ? 'transferred' : 'direct'} figures in order with exact panel-label provenance`, async () => {
        const { result, pdfText } = fixture();
        const original = structuredClone(result);
        const fresh = createMinerUFigureInput(result, { pdfText });
        const input = transferred ? structuredClone(fresh) : fresh;
        assert.ok(input);
        validateFigureInput(input);
        const { service, requests } = harness(verified);
        const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.blueprints.length, 2, JSON.stringify(draft.preserved));
        assert.deepEqual(requests.map(request => request.panels.length), [1, 2]);
        const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
        assert.deepEqual(document.figureMap.figures.map(figure => figure.label), ['Fig. 14', 'Fig. 15']);
        const [upper, shared] = document.figureMap.figures;
        assert.deepEqual(upper.memberBlockIds, ['p0-0:body0', 'p0-0:pdf-caption']);
        assert.ok(shared.memberBlockIds.includes('p0-0:caption0'));
        assert.ok(shared.provenance.fragments.some(fragment => fragment.markdown === 'B'));
        assert.ok(document.markdown.includes(`![${PRINTED}]`));
        assert.ok(document.markdown.indexOf(UPPER) < document.markdown.indexOf(PRINTED));
        assert.equal(document.markdown.split(UPPER).length - 1, 1);
        assert.equal(document.markdown.split(PRINTED).length - 1, 1);
        assert.equal(document.markdown.includes('![B '), false);
        assert.equal(document.markdown.includes('images/'), false);
        assert.ok(document.markdown.includes('The following paragraph remains after both figures.'));
        assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
        assert.deepEqual(result, original);
    });
}

for (const reason of ['missing native image', 'pixel mismatch']) {
    test(`preserves original fragments when the shared group has ${reason}`, async () => {
        const { result, pdfText } = fixture();
        const input = createMinerUFigureInput(result, { pdfText });
        const { service } = harness(request => {
            if (request.caption.label === 'Fig. 14') return verified(request);
            if (reason === 'pixel mismatch') throw new Error('Panel pixels do not match');
            return null;
        });
        const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
        const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
        assert.deepEqual(document.figureMap.figures.map(figure => figure.label), ['Fig. 14']);
        assert.ok(document.markdown.includes('images/left.png'));
        assert.ok(document.markdown.includes('images/right.png'));
        assert.ok(document.markdown.includes(SHARED));
        assert.ok(document.markdown.includes('![B '));
    });
}
