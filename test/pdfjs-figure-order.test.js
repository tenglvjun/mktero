import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import '../src/pdf/pdfjs-text-engine.js';
import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';
import { FigureReadingOrderService } from '../src/figures/figure-reading-order.js';
import { analyzeDocumentFigures } from '../src/figures/figure-analysis.js';
import { collectFigureImageNodes } from '../src/figures/figure-model.js';
import { sha256Hex } from '../src/core/sha256.js';

function fixture({ columns = 2, rows = 2, titlePosition = 'above', duplicateTitle = false,
    wrongTitle = false, wrongCaption = false, duplicateCaption = false, foreignText = false,
    extraFigure = false, rotation = 0, wrongPixels = false, splitTitle = false } = {}) {
    const title = 'Observations across independent sample markets';
    const caption = 'Fig. 12 Measurements across the observed sample markets.';
    const contents = [];
    const panels = [];
    for (let index = 0; index < columns * rows; index++) {
        const width = 800 / columns - 20;
        const height = 640 / rows - 20;
        const x = 100 + index % columns * 800 / columns;
        const y = 160 + Math.floor(index / columns) * 640 / rows;
        const canvas = createCanvas(Math.round(width * 2.75), Math.round(height * 2.75));
        const context = canvas.getContext('2d');
        context.scale(canvas.width / width, canvas.height / height);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.strokeStyle = '#333333';
        context.lineWidth = 1;
        context.strokeRect(4, 4, width - 8, height - 8);
        contents.push(`0.2 G 1 w ${x + 4} ${1000 - y - height + 4} ${width - 8} ${height - 8} re S`);
        for (let bar = 0; bar < 7; bar++) {
            const left = 14 + bar * (width - 24) / 7;
            const barWidth = (width - 40) / 9;
            const barHeight = (height - 24) * (0.15 + ((bar * 3 + index * 5) % 11) * 0.075);
            context.fillStyle = '#333333';
            context.fillRect(left, height - 12 - barHeight, barWidth, barHeight);
            contents.push(`0.2 g ${x + left} ${1000 - y - height + 12} ${barWidth} ${barHeight} re f`);
        }
        if (wrongPixels && !index) {
            context.fillStyle = '#000000';
            context.fillRect(0, 0, width, height);
        }
        panels.push({ bbox: [x, y, x + width, y + height], asset: {
            path: `images/panel-${index}.jpg`, mimeType: 'image/jpeg',
            data: new Uint8Array(canvas.toBuffer('image/jpeg')),
        } });
        canvas.width = canvas.height = 0;
    }
    const titleY = titlePosition === 'above' ? 140 : titlePosition === 'inside' ? 180 : 840;
    if (splitTitle) {
        contents.push(`BT /F 15 Tf 300 ${1000 - titleY} Td (Observations across ) Tj`
            + ' /F2 15 Tf (independent sample markets) Tj ET');
    }
    else contents.push(pdfText(wrongTitle ? 'A different study with other observations' : title, 300, titleY, 15));
    if (duplicateTitle) contents.push(pdfText(title, 300, 90, 15));
    contents.push(pdfText(wrongCaption ? 'Fig. 13 A different caption and topic.' : caption, 100, 828));
    if (duplicateCaption) contents.push(pdfText(caption, 100, 900));
    if (foreignText) contents.push(pdfText('Unrelated prose between the rows', 150, 478, 8));
    if (extraFigure) contents.push(pdfText('Fig. 3 Separate figure', 130, 200));
    const stream = contents.join('\n');
    const fileData = serializePDF([
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 1000] /Rotate ${rotation}`
            + ' /Resources << /Font << /F 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    ]);
    const order = [panels.at(-2), ...panels.filter(panel => panel !== panels.at(-2))];
    let markdown = 'Body preceding the figure.\n\n';
    const sourceMap = [];
    order.forEach((panel, index) => {
        const from = markdown.length;
        markdown += `![](${panel.asset.path})`;
        sourceMap.push({ type: 'chart', markdownFrom: from, markdownTo: markdown.length,
            locations: [{ pageIndex: 0, bbox: panel.bbox }] });
        if (index === order.length - 1) {
            markdown += '  \n' + caption;
            sourceMap.at(-1).markdownTo = markdown.length;
        }
        markdown += '\n\n';
        if (!index) markdown += title + '\n\n';
    });
    return { fileData, request: { pageIndex: 0, title, caption: { label: 'Fig. 12', text: caption },
        panels, foreignLocations: [] },
    document: { markdown, sourceMap, assets: panels.map(panel => panel.asset), assetBasePath: '' } };
}

function pdfText(value, x, y, size = 14) {
    return `BT /F ${size} Tf ${x} ${1000 - y} Td (${value}) Tj ET`;
}

function serializePDF(objects) {
    let source = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(source));
        source += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(source);
    source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`
        + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new Uint8Array(Buffer.from(source));
}

function harness({ waitDecode, onClose, limits } = {}) {
    const canvases = [];
    let decoded = 0;
    let closed = 0;
    const renderer = createPDFFigureRegionRenderer({
        limits,
        createCanvas: (width, height) => {
            const canvas = createCanvas(width, height);
            const sizes = { width, height };
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
        released: () => decoded === closed && canvases.every(canvas => !canvas.width && !canvas.height) };
}

for (const options of [{}, { columns: 4, rows: 4 }, { splitTitle: true }]) {
    test(`reorders a vector PDF figure with independent raster panels ${JSON.stringify(options)}`, async () => {
        const sample = fixture(options);
        const h = harness();
        try {
            const service = new FigureReadingOrderService({ openPDF: (...args) => h.renderer.open(...args), hash: sha256Hex });
            const result = await service.recover(sample.document, { fileData: sample.fileData });
            assert.ok(result !== sample.document);
            const figures = analyzeDocumentFigures(result.markdown);
            assert.equal(figures.length, 1);
            assert.equal(figures[0].images.length, sample.request.panels.length);
            assert.deepEqual(collectFigureImageNodes(result.markdown).map(image => image.assetPath),
                sample.request.panels.map(panel => panel.asset.path));
            assert.ok(result.markdown.indexOf(sample.request.title) < figures[0].from);
            assert.equal(h.decoded(), sample.request.panels.length);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

for (const options of [{ wrongTitle: true }, { duplicateTitle: true }, { titlePosition: 'inside' },
    { titlePosition: 'below' }, { wrongCaption: true }, { duplicateCaption: true },
    { foreignText: true }, { extraFigure: true }, { rotation: 90 }, { wrongPixels: true }]) {
    test(`rejects an ambiguous or mismatched PDF figure ${JSON.stringify(options)}`, async () => {
        const sample = fixture(options);
        const h = harness();
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.verifyFigureOrder(sample.request), null);
            if (!options.wrongPixels) assert.equal(h.decoded(), 0);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

for (const kind of ['foreign-mapping', 'disconnected', 'overlap', 'swapped-panels', 'oversized-image']) {
    test(`rejects ${kind} before rewriting a figure`, async () => {
        const sample = fixture();
        if (kind === 'foreign-mapping') sample.request.foreignLocations.push({ bbox: [200, 300, 400, 320] });
        if (kind === 'disconnected') sample.request.panels.splice(1, 2);
        if (kind === 'overlap') sample.request.panels[0].bbox = sample.request.panels[1].bbox;
        if (kind === 'swapped-panels') {
            const panels = sample.request.panels;
            [panels[0].asset, panels[1].asset] = [panels[1].asset, panels[0].asset];
        }
        const h = harness(kind === 'oversized-image' ? { limits: { maxDecodedImagePixels: 10 } } : {});
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.verifyFigureOrder(sample.request), null);
            if (kind !== 'swapped-panels') assert.equal(h.decoded(), 0);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

test('enforces figure text, comparison, and page rendering budgets before decoding images', async () => {
    const sample = fixture();
    for (const limits of [{ maxComparisons: 1 }, { maxCropPixels: 100 }, { maxLayoutBlocks: 1 }]) {
        const h = harness({ limits });
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.verifyFigureOrder(sample.request), null);
            assert.equal(h.decoded(), 0);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    }
});

test('cancels pending order verification and closes images that finish decoding after cancellation', async () => {
    const started = Promise.withResolvers();
    const decoding = Promise.withResolvers();
    const closed = Promise.withResolvers();
    const h = harness({ waitDecode: () => { started.resolve(); return decoding.promise; }, onClose: closed.resolve });
    const sample = fixture();
    const controller = new AbortController();
    try {
        const session = await h.renderer.open(sample.fileData);
        const pending = session.verifyFigureOrder(sample.request, { signal: controller.signal });
        const rejected = assert.rejects(pending, { name: 'AbortError' });
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
