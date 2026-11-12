import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import '../src/pdf/pdfjs-text-engine.js';
import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';
import { FigureLabelRecoveryService } from '../src/figures/figure-label-recovery.js';
import { sha256Hex } from '../src/core/sha256.js';
import { figureImageDimensions } from '../src/figures/figure-image-dimensions.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';

function fixture(count = 2, { irregular = false, wrongPixels = false, externalLabel = false, wrongCaption = false,
    duplicateImage = false, fullPage = false, splitCaption = false,
    edgeOvershoot = false, nativeTitle = false } = {}) {
    const picture = createCanvas(800, 600);
    const context = picture.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 800, 600);
    context.font = '20px sans-serif';
    context.fillStyle = '#000000';
    context.fillText('Shared legend: black / gray / striped', 150, 24);
    const columns = count === 2 ? 1 : count === 4 ? 2 : 4;
    const rows = Math.ceil(count / columns);
    const panels = [];
    const assets = [];
    const sourceMap = [];
    let markdown = 'See Fig. 9(A) for comparison.\n\n';
    const caption = 'Fig. 9 Comparison of panels (a) and (b) with a shared legend.';
    for (let index = 0; index < count; index++) {
        const cellWidth = 780 / columns;
        const cellHeight = 560 / rows;
        const x = 10 + index % columns * cellWidth;
        const y = 35 + Math.floor(index / columns) * cellHeight;
        const w = Math.floor(cellWidth - 25);
        const h = Math.floor(cellHeight - 35 - (irregular && index % 2 ? 30 : 0));
        context.fillStyle = '#000000';
        context.fillText(`(${String.fromCharCode(65 + index)})`, x, y + 18);
        const panelY = Math.floor(y + 25);
        const panelX = Math.floor(x);
        context.strokeStyle = '#555555';
        context.strokeRect(panelX + 2, panelY + 2, w - 4, h - 4);
        for (let bar = 0; bar < 5; bar++) {
            context.fillStyle = bar % 2 ? '#999999' : '#111111';
            const barHeight = Math.floor((h - 12) * (0.3 + ((bar + index) % 4) * 0.16));
            context.fillRect(panelX + 12 + bar * (w - 20) / 5, panelY + h - barHeight - 5,
                Math.max(3, (w - 30) / 7), barHeight);
        }
        const cropX = edgeOvershoot && index === 0 ? -6 : panelX;
        const cropWidth = panelX + w - cropX;
        const panelCanvas = createCanvas(cropWidth, h);
        panelCanvas.getContext('2d').fillStyle = '#ffffff';
        panelCanvas.getContext('2d').fillRect(0, 0, cropWidth, h);
        panelCanvas.getContext('2d').drawImage(picture, cropX, panelY, cropWidth, h, 0, 0, cropWidth, h);
        if (wrongPixels && index === 0) {
            panelCanvas.getContext('2d').fillStyle = '#ff0000';
            panelCanvas.getContext('2d').fillRect(0, 0, w, h);
        }
        const asset = { path: `images/panel-${index}.png`, mimeType: 'image/png',
            data: new Uint8Array(panelCanvas.toBuffer('image/png')) };
        assets.push(asset);
        panelCanvas.width = panelCanvas.height = 0;
        const bbox = [100 + cropX, (100 + panelY) * 1000 / 900,
            100 + panelX + w, (100 + panelY + h) * 1000 / 900];
        const from = markdown.length;
        markdown += `(${String.fromCharCode(65 + index)})   \n`
            + `![${index === count - 1 ? caption : ''}](${asset.path})\n\n`;
        sourceMap.push({ type: 'chart', markdownFrom: from, markdownTo: markdown.length - 2,
            locations: [{ pageIndex: 0, bbox }] });
        panels.push({ asset, bbox, label: String.fromCharCode(97 + index) });
    }
    markdown += 'Body text referring to (A) stays searchable.\n';
    const jpeg = picture.toBuffer('image/jpeg');
    picture.width = picture.height = 0;
    const placement = fullPage ? '1000 0 0 900 0 0' : '800 0 0 600 100 200';
    const captionContent = splitCaption
        ? '(Fig. 9 Comparison of panels ) Tj /F2 14 Tf (a) Tj /F 14 Tf ( and ) Tj /F2 14 Tf (b) Tj /F 14 Tf ( with a shared legend.) Tj'
        : `(${wrongCaption ? 'Figure 3 Different topic' : caption}) Tj`;
    const content = `q ${placement} cm /Im Do Q\n`
        + (duplicateImage ? `q ${placement} cm /Im Do Q\n` : '')
        + `BT /F 14 Tf 100 175 Td ${captionContent} ET\n`
        + (externalLabel ? 'BT /F 14 Tf 80 660 Td (\\(A\\)) Tj ET\n' : '')
        + (nativeTitle ? 'BT /F 14 Tf 200 780 Td (Unmapped article text above the panels) Tj ET\n' : '');
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
        Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 900] /Resources << /XObject << /Im 4 0 R >> /Font << /F 6 0 R /F2 7 0 R >> >> /Contents 5 0 R >>'),
        Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 800 /Height 600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
        Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
        Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
        Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'),
    ];
    const chunks = [Buffer.from('%PDF-1.4\n')];
    const offsets = [0];
    let size = chunks[0].length;
    objects.forEach((object, index) => {
        offsets.push(size);
        const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
        chunks.push(chunk);
        size += chunk.length;
    });
    chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`
        + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
    return { fileData: new Uint8Array(Buffer.concat(chunks)), request: { pageIndex: 0,
        panels, caption: { label: 'Fig. 9', text: caption }, foreignLocations: [] },
    document: { markdown, assets, sourceMap, assetBasePath: '' } };
}

function captionedRegionInput(sample) {
    const para_blocks = sample.request.panels.map((panel, index) => {
        const bbox = panel.bbox.map((value, axis) => axis % 2 ? value * 0.9 : value);
        return { type: 'image', bbox, blocks: [
            { type: 'image_body', bbox, lines: [{ bbox, spans: [{ type: 'image', bbox,
                image_path: panel.asset.path }] }] },
            ...(index === sample.request.panels.length - 1 ? [{
                type: 'image_caption', bbox: [100, 710, 900, 740],
                lines: [{ bbox: [100, 710, 900, 740], spans: [{ type: 'text',
                    content: sample.request.caption.text }] }],
            }] : []),
        ] };
    });
    para_blocks.push({ type: 'text', bbox: [100, 800, 900, 850],
        lines: [{ bbox: [100, 800, 900, 850], spans: [{ type: 'text', content: 'Body text remains outside the figure.' }] }] });
    return createMinerUFigureInput({
        markdown: '', assets: sample.document.assets, assetBasePath: '',
        layout: projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.4', pdf_info: [
            { page_idx: 0, page_size: [1000, 900], para_blocks, discarded_blocks: [] },
        ] }),
    });
}

test('expands a captioned OCR region to the verified original image and retains its full caption', async () => {
    const sample = fixture(4);
    const input = captionedRegionInput(sample);
    const h = harness();
    try {
        const restoration = new FigureRestorationService({ openPDF: (...args) => h.renderer.open(...args), hash: sha256Hex });
        const draft = await restoration.restore(input, { fileData: sample.fileData });
        assert.deepEqual(draft.preserved, []);
        const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash: sha256Hex });
        assert.equal(document.figureMap.figures.length, 1);
        const figure = document.figureMap.figures[0];
        assert.ok(figure.visualBBox[0] <= 101 && figure.visualBBox[1] <= 112,
            'The original image border and shared title must survive tight OCR boxes');
        assert.ok(figure.visualBBox[2] >= 899 && figure.visualBBox[3] >= 777);
        assert.ok(figure.provenance.evidence.includes('verified-panel-pixels'));
        assert.ok(figure.visualBBox[3] < figure.captionBBox[1]);
        const range = figure.render.captionRanges[0];
        assert.equal(document.markdown.slice(range.from, range.to), sample.request.caption.text);
        assert.ok(document.markdown.includes('Body text remains outside the figure.'));
        assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
        assert.ok(topBandInk(await loadImage(document.assets.at(-1).data)) > 24);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

function captionedRegionRequest(sample) {
    const boxes = sample.request.panels.map(panel => panel.bbox);
    return { ...sample.request, mode: 'captioned-region', visualBBox: [
        Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
        Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3])),
    ] };
}

test('accepts small verified OCR edge overshoot only for a resolved captioned region', async () => {
    const sample = fixture(4, { edgeOvershoot: true });
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        assert.equal(await session.recoverImageGroup(sample.request), null,
            'The separate loose-label recovery path keeps its stricter boundary');
        const result = await session.recoverImageGroup(captionedRegionRequest(sample));
        assert.ok(result);
        assert.ok(result.bbox[0] <= 94, 'Retain the verified OCR edge as well as the original image');
        assert.ok(result.bbox[1] <= 112 && result.bbox[2] >= 899);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

for (const kind of ['wrongPixels', 'wrongCaption', 'duplicateImage', 'fullPage', 'nativeTitle', 'foreignOverlap']) {
    test(`does not expand a resolved region when original image evidence has ${kind}`, async () => {
        const sample = fixture(4, { [kind]: true });
        const request = captionedRegionRequest(sample);
        if (kind === 'foreignOverlap') request.foreignLocations.push({ bbox: [110, 120, 200, 140] });
        const h = harness();
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.recoverImageGroup(request), null);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

test('bounds captioned-region evidence work and rejects malformed foreign boxes before decoding', async () => {
    for (const kind of ['budget', 'foreign', 'region']) {
        const sample = fixture(4);
        const request = captionedRegionRequest(sample);
        if (kind === 'foreign') request.foreignLocations.push({ bbox: null });
        if (kind === 'region') request.visualBBox = [100, 100, 90, 90];
        const h = harness(kind === 'budget' ? { limits: { maxComparisons: 0 } } : {});
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.recoverImageGroup(request), null);
            assert.equal(h.decoded(), 0);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    }
});

// Downscaling the crop to a few pixels makes a one-pixel legend depend on
// platform interpolation. Read the top of the recovered image directly.
function topBandInk(image) {
    const height = Math.max(8, Math.ceil(image.height * 0.08));
    const canvas = createCanvas(image.width, height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, image.width, height, 0, 0, image.width, height);
    const pixels = context.getImageData(0, 0, image.width, height).data;
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 8
            && (pixels[index] < 220 || pixels[index + 1] < 220 || pixels[index + 2] < 220)) {
            ink += 1;
        }
    }
    canvas.width = canvas.height = 0;
    return ink;
}

function harness({ waitDecode, onClose, limits } = {}) {
    const canvases = [];
    let decoded = 0;
    let closed = 0;
    const renderer = createPDFFigureRegionRenderer({
        createCanvas: (width, height) => {
            const canvas = createCanvas(width, height);
            const sizes = { width, height };
            // Node's canvas resets zero dimensions to defaults; record the release setters.
            for (const key of ['width', 'height']) {
                const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(canvas), key);
                Object.defineProperty(canvas, key, {
                    get() { return descriptor.get.call(this); },
                    set(value) { sizes[key] = value; descriptor.set.call(this, value); },
                });
            }
            canvases.push(sizes);
            return canvas;
        },
        encodePNG: async canvas => new Uint8Array(await canvas.encode('png')),
        decodeImage: async asset => {
            await waitDecode?.();
            const image = await loadImage(asset.data);
            decoded++;
            return { image, width: image.width, height: image.height, close: () => { closed++; onClose?.(); } };
        },
        limits,
    });
    return { renderer, decoded: () => decoded,
        released: () => canvases.every(canvas => !canvas.width && !canvas.height) && decoded === closed };
}

for (const [count, options] of [[2, {}], [4, {}], [16, {}], [4, { irregular: true }], [2, { splitCaption: true }]]) {
    test(`restores a complete PDF image with ${count} ${options.irregular ? 'irregular' : 'regular'} panels${options.splitCaption ? ' and separate caption letters' : ''} and its labels`, async () => {
        const sample = fixture(count, options);
        const h = harness();
        try {
            const service = new FigureLabelRecoveryService({ openPDF: (...args) => h.renderer.open(...args), hash: sha256Hex });
            const result = await service.recover(sample.document, { fileData: sample.fileData });
            assert.equal(result.figureMap?.figures.length, 1);
            assert.doesNotMatch(result.markdown, /^\([A-P]\)\s*$/mu);
            assert.match(result.markdown, /Body text referring to \(A\)/);
            const figure = result.figureMap.figures[0];
            assert.equal(figure.panels.length, count);
            assert.ok(figure.visualBBox[1] < sample.request.panels[0].bbox[1]);
            const image = await loadImage(result.assets.at(-1).data);
            assert.ok(image.width > 800 && image.height > 600);
            assert.ok(topBandInk(image) > 24,
                'The shared legend and first label must remain in the top band');
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

for (const kind of ['wrongPixels', 'wrongCaption', 'duplicateImage', 'externalLabel', 'fullPage']) {
    test(`preserves OCR labels for a PDF with ${kind}`, async () => {
        const sample = fixture(2, { [kind]: true });
        const h = harness();
        try {
            const service = new FigureLabelRecoveryService({ openPDF: (...args) => h.renderer.open(...args), hash: sha256Hex });
            assert.equal(await service.recover(sample.document, { fileData: sample.fileData }), sample.document);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

test('reads image dimensions without allocating a decoded image', () => {
    const canvas = createCanvas(4, 6);
    const data = new Uint8Array(canvas.toBuffer('image/png'));
    assert.deepEqual(figureImageDimensions({ mimeType: 'image/png', data }), { width: 4, height: 6 });
    new DataView(data.buffer).setUint32(16, 0xffffffff);
    assert.equal(figureImageDimensions({ mimeType: 'image/png', data }).width, 0xffffffff);
    assert.equal(figureImageDimensions({ mimeType: 'image/jpeg', data }), null);
    assert.deepEqual(figureImageDimensions({ mimeType: 'image/jpeg',
        data: new Uint8Array(canvas.toBuffer('image/jpeg')) }), { width: 4, height: 6 });
    for (let length = 0; length < 24; length++) {
        assert.equal(figureImageDimensions({ mimeType: 'image/png', data: data.subarray(0, length) }), null);
    }
    canvas.width = canvas.height = 0;
});

test('preserves labels and never decodes panels with oversized declared dimensions or foreign overlap', async () => {
    for (const kind of ['oversized', 'foreign-overlap']) {
        const sample = fixture();
        if (kind === 'oversized') {
            const data = sample.request.panels[0].asset.data;
            new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(16, 0xffffffff);
        }
        else sample.request.foreignLocations.push({ bbox: [120, 120, 180, 160] });
        const h = harness();
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.recoverImageGroup(sample.request), null);
            assert.equal(h.decoded(), 0);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    }
});

test('cancels pending panel decoding and closes an image that arrives after cancellation', async () => {
    const decoding = Promise.withResolvers();
    const started = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const h = harness({ waitDecode: () => { started.resolve(); return decoding.promise; }, onClose: closed.resolve });
    const sample = fixture();
    const controller = new AbortController();
    try {
        const session = await h.renderer.open(sample.fileData);
        const recovery = session.recoverImageGroup(sample.request, { signal: controller.signal });
        const rejected = assert.rejects(recovery, { name: 'AbortError' });
        await started.promise;
        controller.abort();
        await rejected;
        decoding.resolve();
        await closed.promise;
    }
    finally { await h.renderer.disposeAll(); }
    assert.equal(h.decoded(), 1);
    assert.ok(h.released());
});


// An unnumbered graphical abstract is one raster image whose labels MinerU
// reports as ordinary text. Only the PDF image container may own that text.
// The picture is drawn over normalized x 60-900 and y 44.4-688.9.
const EMBEDDED_PLACEMENT = { left: 60, top: 44.444, width: 840, height: 644.444 };
function embeddedPoint(x, y) {
    return [EMBEDDED_PLACEMENT.left + x * EMBEDDED_PLACEMENT.width / 900,
        EMBEDDED_PLACEMENT.top + y * EMBEDDED_PLACEMENT.height / 620];
}
function embeddedBox(x, y, right, bottom) {
    const [left, top] = embeddedPoint(x, y);
    const [rightEdge, bottomEdge] = embeddedPoint(right, bottom);
    return [left, top, rightEdge, bottomEdge];
}

function embeddedFixture({ nativeText = false, wrongPixels = false, duplicateImage = false,
    fullPage = false, bodyText = false } = {}) {
    const picture = createCanvas(900, 620);
    const context = picture.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 900, 620);
    context.fillStyle = '#000000';
    context.font = '22px sans-serif';
    context.fillText('Graphical abstract heading', 40, 34);
    const panels = [];
    [[60, 60, 420, 330], [460, 60, 850, 290], [460, 320, 850, 580]]
        .forEach(([x, y, right, bottom], index) => {
            context.strokeStyle = '#444444';
            context.strokeRect(x + 4, y + 4, right - x - 8, bottom - y - 8);
            for (let bar = 0; bar < 4; bar++) {
                context.fillStyle = bar % 2 ? '#888888' : '#111111';
                const height = (bottom - y) * (0.25 + (bar + index) % 3 * 0.18);
                context.fillRect(x + 20 + bar * (right - x - 40) / 4, bottom - height - 10,
                    Math.max(3, (right - x) / 9), height);
            }
            const panelCanvas = createCanvas(right - x, bottom - y);
            panelCanvas.getContext('2d').drawImage(picture, x, y, right - x, bottom - y,
                0, 0, right - x, bottom - y);
            if (wrongPixels && index === 0) {
                panelCanvas.getContext('2d').fillStyle = '#ff0000';
                panelCanvas.getContext('2d').fillRect(0, 0, right - x, bottom - y);
            }
            const asset = { path: `images/embedded-${index}.png`, mimeType: 'image/png',
                data: new Uint8Array(panelCanvas.toBuffer('image/png')) };
            panelCanvas.width = panelCanvas.height = 0;
            panels.push({ bbox: embeddedBox(x, y, right, bottom), asset });
        });
    const jpeg = picture.toBuffer('image/jpeg');
    picture.width = picture.height = 0;
    // MediaBox is 1000x900, so the placement is 840x580 user units at (60, 280).
    const placement = fullPage ? '1000 0 0 900 0 0' : '840 0 0 580 60 280';
    const content = `q ${placement} cm /Im Do Q\n`
        + (duplicateImage ? `q ${placement} cm /Im Do Q\n` : '')
        + (nativeText ? 'BT /F 14 Tf 300 500 Td (Printed inside the image) Tj ET\n' : '')
        + (bodyText ? 'BT /F 14 Tf 100 120 Td (Article body text below the image) Tj ET\n' : '');
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
        Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 900] /Resources << /XObject << /Im 4 0 R >> /Font << /F 6 0 R >> >> /Contents 5 0 R >>'),
        Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 900 /Height 620 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
        Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
        Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ];
    const chunks = [Buffer.from('%PDF-1.4\n')];
    const offsets = [0];
    let size = chunks[0].length;
    objects.forEach((object, index) => {
        offsets.push(size);
        const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
        chunks.push(chunk);
        size += chunk.length;
    });
    chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`
        + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
    return { fileData: new Uint8Array(Buffer.concat(chunks)),
        container: [EMBEDDED_PLACEMENT.left, EMBEDDED_PLACEMENT.top,
            EMBEDDED_PLACEMENT.left + EMBEDDED_PLACEMENT.width,
            EMBEDDED_PLACEMENT.top + EMBEDDED_PLACEMENT.height],
        request: { mode: 'embedded-text', pageIndex: 0, panels, foreignLocations: [],
            textBlocks: [
                { id: 'heading', bbox: embeddedBox(40, 14, 340, 40) },
                { id: 'endpoint', bbox: embeddedBox(20, 380, 430, 500) },
                { id: 'definition', bbox: embeddedBox(20, 570, 300, 600) },
            ] } };
}

function closeTo(actual, expected, tolerance = 1) {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) <= tolerance,
        `${axis}: ${value} != ${expected[axis]}`));
}

test('recovers one PDF image that holds an unnumbered graphical abstract and its labels', async () => {
    const sample = embeddedFixture();
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const result = await session.recoverImageGroup(sample.request);
        assert.ok(result, 'The PDF image container must verify');
        assert.equal(result.captionBBox, null);
        assert.deepEqual(result.ownedTextBlockIds, ['heading', 'endpoint', 'definition']);
        closeTo(result.bbox, sample.container);
        assert.equal(result.rotation, 0);
        const image = await loadImage(result.crop.data);
        assert.ok(image.width > 600 && image.height > 400);
        assert.ok(topBandInk(image) > 24, 'The embedded heading must stay in the crop');
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('consumes a label that overshoots the raster image edge and leaves the article body alone', async () => {
    const sample = embeddedFixture();
    // The note row ends a few units below the image container edge.
    sample.request.textBlocks[2].bbox = [sample.container[0] + 5, sample.container[3] - 40,
        sample.container[0] + 300, sample.container[3] + 6];
    sample.request.textBlocks.push({ id: 'body', bbox: [60, 720, 900, 780] });
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const result = await session.recoverImageGroup(sample.request);
        assert.ok(result);
        assert.deepEqual(result.ownedTextBlockIds, ['heading', 'endpoint', 'definition']);
        assert.ok(result.bbox[3] > sample.container[3]);
        assert.ok(result.bbox[3] < 720, 'The article body stays outside the crop');
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('keeps the captioned-figure path for a request without the embedded-text mode', async () => {
    const sample = fixture();
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const result = await session.recoverImageGroup(sample.request);
        assert.ok(result);
        assert.notEqual(result.captionBBox, null);
        assert.equal(result.ownedTextBlockIds, undefined);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

for (const kind of ['wrongPixels', 'duplicateImage', 'fullPage', 'nativePDFText',
    'oversizedText', 'straddlingText', 'foreignOverlap', 'noText']) {
    test(`refuses embedded-text recovery for ${kind}`, async () => {
        const sample = embeddedFixture({
            wrongPixels: kind === 'wrongPixels',
            duplicateImage: kind === 'duplicateImage',
            fullPage: kind === 'fullPage',
            nativeText: kind === 'nativePDFText',
        });
        if (kind === 'oversizedText') sample.request.textBlocks.push({ id: 'page', bbox: [0, 0, 1000, 900] });
        if (kind === 'straddlingText') sample.request.textBlocks.push({ id: 'below', bbox: [60, 660, 900, 730] });
        if (kind === 'foreignOverlap') sample.request.foreignLocations.push({ bbox: [60, 300, 900, 360] });
        if (kind === 'noText') sample.request.textBlocks = [];
        const h = harness();
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.recoverImageGroup(sample.request), null);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

test('charges container, OCR text, and native PDF text comparisons against maxComparisons', async () => {
    const sample = embeddedFixture({ bodyText: true });
    let minimum = null;
    for (let budget = 0; budget <= 16 && minimum === null; budget++) {
        const h = harness({ limits: { maxComparisons: budget } });
        try {
            const session = await h.renderer.open(sample.fileData);
            const result = await session.recoverImageGroup(sample.request);
            if (result) {
                minimum = budget;
                assert.deepEqual(result.ownedTextBlockIds, ['heading', 'endpoint', 'definition']);
                assert.ok(h.decoded() > 0);
            }
            // A budget rejection must land before any panel pixel is decoded.
            else assert.equal(h.decoded(), 0, `budget ${budget} decoded panels`);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    }
    // 1 image container x 3 panels, two text-block passes of 3, and the single
    // native PDF text item outside the crop.
    assert.equal(minimum, 10);
});

test('never decodes panel pixels for a malformed embedded-text request', async () => {
    for (const mutate of [
        request => { request.textBlocks = 'nope'; },
        request => { request.textBlocks.push({ bbox: [100, 100, 200, 200] }); },
        request => { request.textBlocks.push({ ...request.textBlocks[0] }); },
        request => { request.panels = request.panels.slice(0, 1); },
        request => { request.foreignLocations.push({ bbox: [100, 100, 50, 200] }); },
        request => { request.foreignLocations.push({ bbox: null }); },
    ]) {
        const sample = embeddedFixture();
        mutate(sample.request);
        const h = harness();
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.recoverImageGroup(sample.request), null);
            assert.equal(h.decoded(), 0);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    }
});
