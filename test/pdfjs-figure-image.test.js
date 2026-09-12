import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import '../src/pdf/pdfjs-text-engine.js';
import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';
import { FigureLabelRecoveryService } from '../src/figures/figure-label-recovery.js';
import { sha256Hex } from '../src/core/sha256.js';
import { figureImageDimensions } from '../src/figures/figure-image-dimensions.js';

function fixture(count = 2, { irregular = false, wrongPixels = false, externalLabel = false, wrongCaption = false,
    duplicateImage = false, fullPage = false, splitCaption = false } = {}) {
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
        const panelCanvas = createCanvas(w, h);
        panelCanvas.getContext('2d').drawImage(picture, panelX, panelY, w, h, 0, 0, w, h);
        if (wrongPixels && index === 0) {
            panelCanvas.getContext('2d').fillStyle = '#ff0000';
            panelCanvas.getContext('2d').fillRect(0, 0, w, h);
        }
        const asset = { path: `images/panel-${index}.png`, mimeType: 'image/png',
            data: new Uint8Array(panelCanvas.toBuffer('image/png')) };
        assets.push(asset);
        panelCanvas.width = panelCanvas.height = 0;
        const bbox = [100 + panelX, (100 + panelY) * 1000 / 900,
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
        + (externalLabel ? 'BT /F 14 Tf 80 660 Td (\\(A\\)) Tj ET\n' : '');
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

function harness({ waitDecode, onClose } = {}) {
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
            const canvas = createCanvas(80, 60);
            canvas.getContext('2d').drawImage(image, 0, 0, 80, 60);
            const pixels = canvas.getContext('2d').getImageData(0, 0, 80, 4).data;
            assert.ok(Array.from(pixels).filter((value, index) => index % 4 !== 3 && value < 100).length > 10,
                'The shared legend and first label must remain in the top band');
            canvas.width = canvas.height = 0;
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
