import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import '../src/pdf/pdfjs-text-engine.js';
import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { createProgressiveFigureRunner } from '../src/figures/figure-progressive-runner.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { sha256Hex } from '../src/core/sha256.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });
const TITLE = 'Effects of an intervention on two participant groups';
const ENDPOINT = 'Primary end point: the change in the measured response during the intervention';
const CONCLUSION = 'The measured response increased in the intervention group, but this could not be explained by baseline differences.';
const DEFINITION = 'MR, measured response.';
const BODY = 'This is the article body below the graphical abstract.';
const BBOX = [130, 275, 860, 655];

function text(bbox, content, type = 'text') {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function panel(bbox, name, footnotes = []) {
    return { type: 'image', bbox, blocks: [
        { type: 'image_body', bbox, lines: [{ bbox, spans: [{ type: 'image', bbox, image_path: name }] }] },
        ...footnotes,
    ] };
}

function fixture() {
    const blocks = [
        { ...text([80, 140, 900, 185], TITLE, 'title'), level: 1 },
        text([180, 280, 800, 310], TITLE),
        panel([135, 315, 560, 510], 'a.png'),
        panel([565, 315, 850, 470], 'b.png', [
            text([140, 515, 500, 580], ENDPOINT, 'image_footnote'),
        ]),
        text([140, 595, 500, 630], CONCLUSION),
        text([135, 635, 300, 650], DEFINITION),
        panel([565, 475, 850, 630], 'c.png'),
        text([80, 750, 900, 800], BODY),
    ];
    return createMinerUFigureInput({
        markdown: 'unused', assetBasePath: '',
        assets: ['a.png', 'b.png', 'c.png'].map(name => ({
            path: `images/${name}`, mimeType: 'image/png', data: createTestPNG(),
        })),
        layout: projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.4', pdf_info: [
            { page_idx: 0, page_size: [1000, 1000], discarded_blocks: [], para_blocks: blocks },
        ] }),
    });
}

function harness(recover, limits) {
    const calls = { recover: 0, render: 0, closed: 0 };
    const service = new FigureRestorationService({
        hash, limits,
        openPDF: async () => ({
            getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
                rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
                viewBox: [0, 0, 1000, 1000], mediaBox: null,
                viewportTransform: [1, 0, 0, -1, 0, 1000] }),
            recoverImageGroup: async request => { calls.recover++; return recover(request); },
            renderRegion: async () => { calls.render++; throw new Error('Reuse the verified crop'); },
            close: async () => { calls.closed++; },
        }),
    });
    return { service, calls };
}

function recovered(request) {
    assert.equal(request.mode, 'embedded-text');
    assert.equal(request.panels.length, 3);
    return {
        bbox: BBOX, captionBBox: null, rotation: 0,
        ownedTextBlockIds: request.textBlocks.filter(block => block.bbox[1] >= 275 && block.bbox[3] <= 655)
            .map(block => block.id),
        crop: { data: createTestPNG(730, 380), mimeType: 'image/png', width: 730, height: 380 },
    };
}

test('restores an unnumbered graphical abstract and consumes only its embedded text', async () => {
    const input = fixture();
    const before = structuredClone(input);
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].reason, 'foreign-content-overlap');
    const { service, calls } = harness(recovered);
    const events = [];
    const draft = await service.restore(input, { fileData: Uint8Array.of(1), onFigure: event => events.push(event) });
    assert.equal(draft.blueprints.length, 1);
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    const figure = document.figureMap.figures[0];
    assert.equal(figure.panels.length, 3);
    assert.equal(figure.caption, undefined);
    assert.equal(figure.captionBBox, null);
    assert.ok(figure.provenance.evidence.includes('pdf-image-container'));
    assert.ok(figure.provenance.evidence.includes('verified-panel-pixels'));
    assert.equal(document.markdown.split(TITLE).length - 1, 1, 'Keep the article title, consume only the duplicate inside the image');
    assert.ok(document.markdown.includes(BODY));
    for (const value of [ENDPOINT, CONCLUSION, DEFINITION, '<!-- mktero-note: figure -->']) {
        assert.ok(!document.markdown.includes(value), value);
    }
    assert.match(document.markdown, /!\[\]\(generated\/figures\//u);
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    assert.deepEqual(input, before);
    assert.deepEqual(calls, { recover: 1, render: 0, closed: 1 });
    assert.equal(events[0].status, 'composed');
});

for (const kind of ['missing', 'failure', 'unknown-text-id', 'missing-owned-text', 'wrong-rotation', 'invalid-crop', 'foreign-crop']) {
    test(`keeps the original panels and text when embedded-image evidence is ${kind}`, async () => {
        const input = fixture();
        const { service, calls } = harness(request => {
            if (kind === 'missing') return null;
            if (kind === 'failure') throw new Error('No image evidence');
            const result = recovered(request);
            if (kind === 'unknown-text-id') result.ownedTextBlockIds.push('unrelated');
            if (kind === 'missing-owned-text') result.ownedTextBlockIds.pop();
            if (kind === 'wrong-rotation') result.rotation = 90;
            if (kind === 'invalid-crop') result.crop.data = new Uint8Array();
            if (kind === 'foreign-crop') result.bbox = [0, 0, 1000, 1000];
            return result;
        });
        const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.blueprints.length, 0);
        assert.equal(draft.input.markdown, input.markdown);
        assert.deepEqual(draft.input.assets, input.assets);
        assert.equal(calls.closed, 1);
    });
}

test('does not recover embedded images during planning or after the asset budget is exhausted', async () => {
    for (const mode of ['plan', 'render']) {
        const input = fixture();
        const { service, calls } = harness(recovered, mode === 'render' ? { maxAssets: input.assets.length } : {});
        await service.restore(input, { fileData: Uint8Array.of(1), mode });
        assert.equal(calls.recover, 0);
        assert.equal(calls.closed, 1);
    }
});

function pdfFixture(input) {
    const picture = createCanvas(730, 380);
    const context = picture.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 730, 380);
    context.strokeStyle = '#17223b';
    context.fillStyle = '#17223b';
    context.font = '13px sans-serif';
    context.fillText(TITLE, 55, 25);
    const panels = input.blocks.filter(block => block.role === 'panel');
    for (const [index, panel] of panels.entries()) {
        const [left, top, right, bottom] = panel.bbox;
        const x = left - 130;
        const y = top - 275;
        const width = right - left;
        const height = bottom - top;
        context.strokeRect(x + 8, y + 8, width - 16, height - 16);
        for (let bar = 0; bar < 5; bar++) {
            context.fillRect(x + 20 + bar * (width - 40) / 5, y + 30 + index * 6 + bar * 9,
                18, height - 45 - index * 6 - bar * 9);
        }
        const crop = createCanvas(width, height);
        crop.getContext('2d').drawImage(picture, x, y, width, height, 0, 0, width, height);
        input.assets[index].data = new Uint8Array(crop.toBuffer('image/png'));
        crop.width = crop.height = 0;
    }
    context.fillText('Primary end point: measured response', 10, 260);
    context.fillText('during the intervention', 10, 285);
    context.fillText('The response increased in one group.', 10, 335);
    context.fillText(DEFINITION, 10, 370);
    const jpeg = picture.toBuffer('image/jpeg');
    picture.width = picture.height = 0;
    const content = 'q 730 0 0 380 130 345 cm /Im Do Q\n'
        + `BT /F 14 Tf 80 850 Td (${TITLE}) Tj ET\n`
        + `BT /F 14 Tf 80 220 Td (${BODY}) Tj ET\n`;
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
        Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Resources << /XObject << /Im 4 0 R >> /Font << /F 6 0 R >> >> /Contents 5 0 R >>'),
        Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 730 /Height 380 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
        Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
        Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ];
    const chunks = [Buffer.from('%PDF-1.4\n')];
    const offsets = [0];
    let size = chunks[0].length;
    for (const [index, object] of objects.entries()) {
        offsets.push(size);
        const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
        chunks.push(chunk);
        size += chunk.length;
    }
    chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`
        + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
    return new Uint8Array(Buffer.concat(chunks));
}

test('restores a real single-image PDF through MinerU IR, pixel verification and final serialization', async () => {
    const input = fixture();
    const fileData = pdfFixture(input);
    const renderer = createPDFFigureRegionRenderer({
        createCanvas,
        encodePNG: async canvas => new Uint8Array(await canvas.encode('png')),
        decodeImage: async asset => {
            const image = await loadImage(asset.data);
            return { image, width: image.width, height: image.height, close() {} };
        },
    });
    try {
        const restoration = new FigureRestorationService({ hash, openPDF: (...args) => renderer.open(...args) });
        const run = createProgressiveFigureRunner({ restoration, prepare: prepareMinerUResult, hash });
        const events = [];
        const document = await run(input, { fileData, onEvent: event => events.push(event) });
        assert.deepEqual(events.map(event => event.type), ['document', 'figure', 'complete']);
        assert.equal(events[0].pendingFigureAssets.size, 0, 'Layout alone cannot yet confirm this image');
        assert.ok(events[0].document.markdown.includes(ENDPOINT), 'Keep OCR text until verification succeeds');
        assert.equal(events[1].figure.status, 'composed');
        assert.equal(events[1].figure.panelAssetPaths.length, 3);
        assert.equal(events[2].document, document);
        assert.equal(events[2].pendingFigureAssets.size, 0);
        assert.equal(document.figureMap.figures[0].panels.length, 3);
        assert.equal(document.markdown.split(TITLE).length - 1, 1);
        assert.ok(document.markdown.includes(BODY));
        assert.ok(!document.markdown.includes(ENDPOINT));
        assert.ok(!document.markdown.includes(CONCLUSION));
        assert.ok(!document.markdown.includes(DEFINITION));
        assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    }
    finally { await renderer.disposeAll(); }
});

test('cancels embedded-image verification without deleting OCR text', async () => {
    const controller = new AbortController();
    const { service, calls } = harness(() => { controller.abort(); return new Promise(() => {}); });
    await assert.rejects(service.restore(fixture(), { fileData: Uint8Array.of(1), signal: controller.signal }), {
        name: 'AbortError',
    });
    assert.equal(calls.closed, 1);
});
