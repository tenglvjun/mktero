import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPDFJSTextEngine } from '../src/pdf/pdfjs-text-engine.js';
import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';

// One native PDF image at normalized x 140-760, y 110-607.6, with its caption
// printed outside it in the page's left margin. The OCR fragments may be one
// picture or two halves of it; both must resolve to the same native container.
const PAGE = { width: 1000, height: 900 };
// The panel box and the rasterized image share one aspect ratio, so pixel
// verification sees the same picture; its bottom (607.6) stays above the
// printed caption at y 620.
const PICTURE = { left: 140, top: 110, width: 620, height: 497.6, pixels: { width: 900, height: 650 } };
const CAPTION = { label: 'Figure 4', text: 'Figure 4. Sensitivity test in adults.', box: [90, 620, 400, 660] };
const LONG_CAPTION = 'Figure 4. Estimated responses for each study population at baseline and follow up; '
    + 'effect sizes with confidence intervals and sample weights are displayed together to compare '
    + 'treatment groups across repeated observations and sensitivity analyses.';

function points(value, axis) {
    return value * (axis === 'x' ? PAGE.width : PAGE.height) / 1000;
}

function point(x, y) {
    return [PICTURE.left + x * PICTURE.width / 1000, PICTURE.top + y * PICTURE.height / 1000];
}

function box(x0, y0, x1, y1) {
    const [left, top] = point(x0, y0);
    const [right, bottom] = point(x1, y1);
    return [left, top, right, bottom];
}

function placement() {
    const left = points(PICTURE.left, 'x');
    const width = points(PICTURE.width, 'x');
    const height = points(PICTURE.height, 'y');
    const top = points(PICTURE.top, 'y');
    const bottom = PAGE.height - top - height;
    return { left, width, height, bottom };
}

// Alternating font runs stop PDF.js coalescing a line into one text item.
// Four runs per line exercise both the item budget and within-line continuation
// after the first line has ended.
function fragmentedCaption(text, left, top) {
    const words = text.split(' ');
    const commands = [`${left} ${top} Td`];
    for (let index = 0; index < words.length; index += 2) {
        const run = index / 2;
        if (run > 0 && run % 4 === 0) commands.push('0 -17 Td');
        commands.push(`/${run % 2 ? 'G' : 'F'} 14 Tf (${words.slice(index, index + 2).join(' ')} ) Tj`);
    }
    return `BT ${commands.join(' ')} ET`;
}

function fixture({ split = false, wrongPixels = false, duplicateImage = false,
    foreignText = false, nativeText = false, captionText = CAPTION.text,
    captionLines = false, fullPage = false, captionItems = false,
    vectorMargin = false, edgeText = false } = {}) {
    const picture = createCanvas(PICTURE.pixels.width, PICTURE.pixels.height);
    const context = picture.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, PICTURE.pixels.width, PICTURE.pixels.height);
    context.fillStyle = '#000000';
    context.font = '22px sans-serif';
    context.fillText('Study or Subgroup', 40, 30);
    for (let row = 0; row < 5; row++) {
        context.strokeStyle = '#333333';
        context.strokeRect(40, 60 + row * 100, 820, 70);
        context.fillStyle = row % 2 ? '#888888' : '#111111';
        context.fillRect(120, 70 + row * 100, 240 + row * 60, 46);
        context.fillRect(560, 82 + row * 100, 120 + row * 40, 22);
    }
    // The OCR boxes of the mixed figure. The default is the raster itself; the
    // vector mode surrounds it with a printed axis label left of the raster
    // and a legend to its right, which a native-container crop would cut off.
    // The raster keeps its own aspect ratio on the page; only the OCR fragment
    // and the vector paths are wider.
    const regions = split ? [[0, 0, 500, 1000], [500, 0, 1000, 1000]]
        : [[0, 0, 1000, 1000]];
    const panels = [];
    const raster = {
        left: PICTURE.left, top: PICTURE.top,
        right: PICTURE.left + PICTURE.width, bottom: PICTURE.top + PICTURE.height,
    };
    const panelBoxes = split
        ? [box(0, 0, 500, 1000), box(500, 0, 1000, 1000)]
        : vectorMargin
            ? [[raster.left - 50, raster.top, raster.right + 50, raster.bottom]]
            : [[raster.left, raster.top, raster.right, raster.bottom]];
    for (const [index, region] of regions.entries()) {
        const x = Math.round(Math.max(0, region[0]) * PICTURE.pixels.width / 1000);
        const y = Math.round(Math.max(0, region[1]) * PICTURE.pixels.height / 1000);
        const right = Math.round(Math.min(1000, region[2]) * PICTURE.pixels.width / 1000);
        const bottom = Math.round(Math.min(1000, region[3]) * PICTURE.pixels.height / 1000);
        const pictureWidth = Math.max(1, right - x);
        const height = Math.max(1, bottom - y);
        const width = vectorMargin ? Math.round(pictureWidth * (PICTURE.width + 100) / PICTURE.width) : pictureWidth;
        const panelCanvas = createCanvas(width, height);
        const panelContext = panelCanvas.getContext('2d');
        panelContext.fillStyle = '#ffffff';
        panelContext.fillRect(0, 0, width, height);
        const margin = vectorMargin ? 50 * pictureWidth / PICTURE.width : 0;
        panelContext.drawImage(picture, x, y, pictureWidth, height, margin, 0, pictureWidth, height);
        if (vectorMargin) {
            // The vector label and legend sit outside the raster container but
            // inside the OCR fragment, so the expanded crop must keep them.
            const panelContext = panelCanvas.getContext('2d');
            panelContext.strokeStyle = '#000000';
            panelContext.lineWidth = 2 * pictureWidth / points(PICTURE.width, 'x');
            const [panelLeft, , panelRight] = panelBoxes[index];
            const scaleX = width / (panelRight - panelLeft);
            const leftX = Math.round((raster.left - 40 - panelLeft) * scaleX);
            const rightX = Math.round((raster.right + 40 - panelLeft) * scaleX);
            panelContext.beginPath();
            panelContext.moveTo(leftX, Math.round(height * 0.35));
            panelContext.lineTo(leftX, Math.round(height * 0.65));
            panelContext.moveTo(rightX, Math.round(height * 0.35));
            panelContext.lineTo(rightX, Math.round(height * 0.65));
            panelContext.stroke();
        }
        if (wrongPixels && index === 0) {
            panelCanvas.getContext('2d').fillStyle = '#ff0000';
            panelCanvas.getContext('2d').fillRect(0, 0, width, height);
        }
        const asset = { path: `images/document-${index}.png`, mimeType: 'image/png',
            data: new Uint8Array(panelCanvas.toBuffer('image/png')) };
        panelCanvas.width = panelCanvas.height = 0;
        panels.push({ id: `p0-${index}:body0`, bbox: panelBoxes[index], asset });
    }
    const jpeg = picture.toBuffer('image/jpeg');
    picture.width = picture.height = 0;
    const placed = placement();
    const placementMatrix = fullPage
        ? `1000 0 0 900 0 0`
        : `${placed.width} 0 0 ${placed.height} ${placed.left} ${placed.bottom}`;
    // The caption baseline sits inside CAPTION.box, above the printed descender.
    const captionY = PAGE.height - points(CAPTION.box[3], 'y') + 8;
    const captionX = points(CAPTION.box[0], 'x');
    // captionText is what the page prints; the request always names CAPTION.
    // A different or truncated printed caption must not verify.
    const captionLine = captionLines
        ? `BT /F 14 Tf ${captionX} ${captionY} Td (${CAPTION.label}) Tj /F 16 Tf 0 -17 Td (${CAPTION.text.slice(CAPTION.label.length + 1)}) Tj ET`
        : captionItems
            ? fragmentedCaption(LONG_CAPTION, captionX, captionY)
            : `BT /F 14 Tf ${captionX} ${captionY} Td (${captionText}) Tj ET`;
    // The vector paths sit outside the raster container but inside the OCR
    // fragment, so only the expanded mode keeps them.
    const vectors = vectorMargin
        ? [raster.left - 40, raster.right + 40].map(x => (
            `q 2 w 0 0 0 RG ${points(x, 'x')} ${PAGE.height - points(raster.top + PICTURE.height * 0.35, 'y')} m `
            + `${points(x, 'x')} ${PAGE.height - points(raster.top + PICTURE.height * 0.65, 'y')} l S Q\n`
        )).join('') : '';
    const content = `q ${placementMatrix} cm /Im Do Q\n${vectors}`
        + (duplicateImage ? `q ${placementMatrix} cm /Im Do Q\n` : '')
        + `${captionLine}\n`
        + (nativeText ? 'BT /F 14 Tf 300 500 Td (Printed inside the image) Tj ET\n' : '')
        // Small selectable text wholly outside the raster, in the narrow strip
        // that an owned OCR edge error would add to the crop.
        + (edgeText ? `BT /F 2 Tf 135 ${PAGE.height - points(300, 'y')} Td (Body) Tj ET\n` : '')
        + (foreignText ? vectorMargin
            ? `BT /F 14 Tf 100 ${PAGE.height - points(300, 'y')} Td (Body) Tj ET\n`
            : 'BT /F 14 Tf 100 120 Td (Article body text below the image) Tj ET\n' : '');
    const objects = [
        Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
        Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
        Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 900] /Resources << /XObject << /Im 4 0 R >> /Font << /F 6 0 R /G 7 0 R >> >> /Contents 5 0 R >>'),
        Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${PICTURE.pixels.width} /Height ${PICTURE.pixels.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]),
        Buffer.from(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
        Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
        Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>'),
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
    const request = {
        mode: 'document-figure', pageIndex: 0, panels,
        caption: { label: CAPTION.label, text: captionItems ? LONG_CAPTION : CAPTION.text,
            bbox: captionItems ? [90, 620, 900, 760] : [...CAPTION.box] },
        foreignLocations: [],
    };
    if (foreignText) request.foreignLocations.push({ bbox: [90, 675, 400, 700] });
    return { fileData: new Uint8Array(Buffer.concat(chunks)), request };
}

function harness({ waitDecode, onClose, limits } = {}) {
    const canvases = [];
    let decoded = 0;
    let closed = 0;
    const renderer = createPDFFigureRegionRenderer({
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
            return { image, width: image.width, height: image.height,
                close: () => { closed++; onClose?.(); } };
        },
        limits,
    });
    return { renderer, decoded: () => decoded,
        released: () => canvases.every(canvas => !canvas.width && !canvas.height) && decoded === closed };
}

test('restores one native image from a single OCR fragment and keeps the caption outside it', async () => {
    const sample = fixture();
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const result = await session.recoverImageGroup(sample.request);
        assert.ok(result);
        assert.ok(result.bbox[0] <= PICTURE.left + 2 && result.bbox[2] >= PICTURE.left + PICTURE.width - 2);
        assert.ok(result.bbox[3] <= CAPTION.box[1], 'The native crop must not swallow the printed caption');
        assert.ok(result.crop.data.byteLength > 0);
        assert.ok(result.captionBBox[1] >= CAPTION.box[1] - 2 && result.captionBBox[3] <= CAPTION.box[3] + 8,
            'The verified caption is the native text box around the requested region');
        assert.ok(result.captionBBox[0] >= CAPTION.box[0] - 2 && result.captionBBox[2] <= CAPTION.box[2] + 2);
        assert.equal(result.rotation, 0);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('restores one native image from a table and a chart that OCR split apart', async () => {
    const sample = fixture({ split: true });
    assert.equal(sample.request.panels.length, 2);
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const result = await session.recoverImageGroup(sample.request);
        assert.ok(result);
        assert.ok(result.bbox[0] <= PICTURE.left + 2 && result.bbox[2] >= PICTURE.left + PICTURE.width - 2,
            'Both OCR fragments must resolve to the one native container');
        assert.ok(result.bbox[3] <= CAPTION.box[1]);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('restores a caption whose label and description are printed on separate lines', async () => {
    const sample = fixture({ captionLines: true });
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const result = await session.recoverImageGroup(sample.request);
        assert.ok(result);
        assert.ok(result.captionBBox[1] >= CAPTION.box[1] - 2
            && result.captionBBox[3] <= CAPTION.box[3] + 20);
        assert.ok(result.bbox[3] < result.captionBBox[1]);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

// A real journal caption can arrive as 16+ PDF text items over three lines.
// The verifier must read all of it and must compare each item with the line it
// continues, not with the box of the whole caption so far.
test('restores a caption printed as many text items across several lines', async () => {
    const sample = fixture({ captionItems: true });
    const engine = createPDFJSTextEngine();
    try {
        const text = await engine.extract(sample.fileData);
        const items = text.pages[0].items.filter(item => item.text.trim());
        assert.ok(items.length > 12, 'The fixture must exceed the previous item limit');
        assert.ok(new Set(items.map(item => Math.round(item.transform[5]))).size > 2,
            'The caption must include within-line fragments after several line breaks');
    }
    finally { await engine.dispose(); }
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const result = await session.recoverImageGroup(sample.request);
        assert.ok(result, 'A complete multi-line caption must verify');
        assert.ok(result.captionBBox[1] >= sample.request.caption.bbox[1] - 2
            && result.captionBBox[3] <= sample.request.caption.bbox[3]);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

// A mixed figure can be drawn partly as vector paths outside its raster
// container. The explicit preservePanelBounds mode keeps the OCR boxes so
// those paths survive, while the default keeps the native container crop.
test('keeps vector margins outside the native container only when requested', async () => {
    const sample = fixture({ vectorMargin: true });
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const native = await session.recoverImageGroup(sample.request);
        assert.ok(native);
        assert.ok(native.bbox[0] >= PICTURE.left - 2,
            'The default crop is the native image container');
        assert.ok(native.bbox[2] <= PICTURE.left + PICTURE.width + 2);
        const expanded = await session.recoverImageGroup({ ...sample.request, preservePanelBounds: true });
        assert.ok(expanded);
        const panel = sample.request.panels[0].bbox;
        assert.ok(expanded.bbox[0] <= panel[0] + 2,
            'The explicit mode keeps the OCR panel box beyond the raster edge');
        assert.ok(expanded.bbox[2] >= panel[2] - 2);
        assert.ok(expanded.captionBBox[1] >= expanded.bbox[3]);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('includes verified owned-text edge errors in the actual rendered crop', async () => {
    const sample = fixture();
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const original = await session.recoverImageGroup(sample.request);
        assert.ok(original);
        for (const bbox of [
            [200, 550, 400, 600],
            [135, 150, 175, 180],
            [730, 200, original.bbox[2] + 1.585, 230],
            [200, 100, 300, 130],
            [200, 590, 300, original.bbox[3] + 10],
            [135, 100, 175, 150],
            [original.bbox[0] - 10, 200, original.bbox[0] + 15, 230], // Exactly 10 beyond the edge and 60% inside.
        ]) {
            for (const preservePanelBounds of [false, true]) {
                const result = await session.recoverImageGroup({ ...sample.request,
                    preservePanelBounds, ownedTextLocations: [{ bbox }] });
                assert.ok(result, JSON.stringify({ bbox, preservePanelBounds }));
                const boxes = [original.bbox, bbox,
                    ...(preservePanelBounds ? sample.request.panels.map(panel => panel.bbox) : [])];
                assert.deepEqual(result.bbox, [
                    Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
                    Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3])),
                ], 'The actual rendered crop must fully contain owned text for the replacement transaction');
                assert.ok(result.crop.data.byteLength > 0);
            }
        }
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

for (const [edge, bbox] of [
    ['left', [125, 200, 200, 230]],
    ['right', [700, 200, 780, 230]],
    ['top', [200, 90, 300, 130]],
    ['bottom', [200, 590, 300, 630]],
    ['outside a nearby edge', [761, 200, 765, 230]],
    ['less than 60% inside', [135, 200, 146, 230]],
]) {
    test(`rejects a panel description beyond the native image ${edge}`, async () => {
        const sample = fixture();
        const h = harness();
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.recoverImageGroup({ ...sample.request, ownedTextLocations: [{ bbox }] }), null);
            assert.equal(h.decoded(), 0, 'Missing ownership must fail before decoding OCR panels');
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

test('does not use vector margins to authorize consuming text outside the native image', async () => {
    const sample = fixture({ vectorMargin: true });
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        assert.equal(await session.recoverImageGroup({ ...sample.request, preservePanelBounds: true,
            ownedTextLocations: [{ bbox: [95, 200, 110, 230] }] }), null);
        assert.equal(h.decoded(), 0);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('does not use another owned text box or vector margins as ownership evidence', async () => {
    const sample = fixture({ vectorMargin: true });
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        for (const preservePanelBounds of [false, true]) {
            const request = { ...sample.request, preservePanelBounds,
                ownedTextLocations: [{ bbox: [135, 200, 175, 230] }] };
            assert.ok(await session.recoverImageGroup(request));
            const before = h.decoded();
            assert.equal(await session.recoverImageGroup({ ...request, ownedTextLocations: [
                ...request.ownedTextLocations, { bbox: [126, 200, 180, 230] },
            ] }), null, 'Each description must pass against the original native image before union');
            assert.equal(h.decoded(), before);
        }
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

for (const [kind, bbox] of [
    ['article body', [130, 200, 139, 230]],
    ['another figure caption', [132, 350, 139, 370]],
]) {
    test(`rejects an owned-text edge extension that would swallow ${kind}`, async () => {
        const sample = fixture();
        const h = harness();
        try {
            const session = await h.renderer.open(sample.fileData);
            for (const preservePanelBounds of [false, true]) {
                const request = { ...sample.request, preservePanelBounds, foreignLocations: [{ bbox }] };
                assert.ok(await session.recoverImageGroup(request), 'The native image alone is clear of foreign layout');
                const before = h.decoded();
                assert.equal(await session.recoverImageGroup({ ...request,
                    ownedTextLocations: [{ bbox: [135, 150, 175, 180] }] }), null);
                assert.equal(h.decoded(), before, 'Unsafe edge growth must fail before panel decoding');
            }
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

test('rejects owned-text edge growth over selectable PDF text without foreign layout evidence', async () => {
    const sample = fixture({ edgeText: true });
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        assert.ok(await session.recoverImageGroup(sample.request), 'The PDF text is outside the native image');
        for (const preservePanelBounds of [false, true]) {
            const before = h.decoded();
            assert.equal(await session.recoverImageGroup({ ...sample.request, preservePanelBounds,
                ownedTextLocations: [{ bbox: [135, 150, 175, 180] }] }), null);
            assert.equal(h.decoded(), before);
        }
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('checks the growth cap against combined panel margins and owned-text edge errors', async () => {
    const sample = fixture();
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        const panel = sample.request.panels[0];
        const wideBox = [0, panel.bbox[1], 985, panel.bbox[3]];
        assert.ok((wideBox[2] - wideBox[0]) / PICTURE.width < 1.6,
            'The panel extension alone is within the growth limit');
        assert.equal(await session.recoverImageGroup({ ...sample.request, preservePanelBounds: true,
            panels: [{ ...panel, bbox: wideBox }],
            ownedTextLocations: [{ bbox: [200, 100, 300, 130] }] }), null);
        assert.equal(h.decoded(), 0, 'Combined growth must be bounded before pixel verification');
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('charges native container comparisons for every owned text location', async () => {
    const sample = fixture();
    const h = harness({ limits: { maxComparisons: 80 } });
    try {
        const session = await h.renderer.open(sample.fileData);
        assert.ok(await session.recoverImageGroup(sample.request), 'The original request fits within the budget');
        const before = h.decoded();
        assert.equal(await session.recoverImageGroup({ ...sample.request,
            ownedTextLocations: Array.from({ length: 80 }, () => ({ bbox: [200, 550, 400, 600] })) }), null);
        assert.equal(h.decoded(), before, 'Owned text work must exhaust the budget before further decoding');
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('rejects expanded panel bounds that would swallow foreign text', async () => {
    const sample = fixture({ vectorMargin: true });
    const panel = sample.request.panels[0].bbox;
    // A body paragraph printed inside the vector margin, outside the raster.
    const foreign = { bbox: [panel[0] + 4, panel[1] + 20, panel[0] + 40, panel[1] + 40] };
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        assert.equal(await session.recoverImageGroup({ ...sample.request,
            preservePanelBounds: true, foreignLocations: [foreign] }), null);
        // The native container stays clear of the foreign box, so the default
        // mode is still allowed.
        assert.ok(await session.recoverImageGroup({ ...sample.request,
            foreignLocations: [foreign] }));
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

test('rejects an expanded crop that would swallow selectable article text', async () => {
    const sample = fixture({ vectorMargin: true, foreignText: true });
    const h = harness();
    try {
        const session = await h.renderer.open(sample.fileData);
        assert.equal(await session.recoverImageGroup({ ...sample.request,
            preservePanelBounds: true, foreignLocations: [] }), null);
    }
    finally { await h.renderer.disposeAll(); }
    assert.ok(h.released());
});

for (const kind of ['wrongPixels', 'duplicateImage', 'nativeText', 'foreignOverlap', 'wrongCaption', 'partialCaption', 'fullPage']) {
    test(`preserves OCR content when the native image evidence has ${kind}`, async () => {
        const sample = kind === 'wrongCaption'
            ? fixture({ captionText: 'Figure 5. Forest plot in the child population.' })
            : kind === 'partialCaption'
                ? fixture({ captionText: 'Figure 4. Sensitivity test' })
                : fixture({ [kind]: true });
        if (kind === 'foreignOverlap') sample.request.foreignLocations.push({ bbox: [300, 300, 400, 340] });
        const h = harness();
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.recoverImageGroup(sample.request), null);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    });
}

test('rejects malformed document-figure requests before decoding any panel', async () => {
    for (const kind of ['panels', 'caption', 'foreign', 'budget', 'panel-bounds-mode',
        'owned-type', 'owned-null', 'owned-bbox', 'owned-reversed', 'owned-nan', 'owned-count']) {
        const sample = fixture();
        const request = structuredClone(sample.request);
        if (kind === 'panels') request.panels[0].bbox = [300, 300, 200, 200];
        if (kind === 'caption') request.caption.text = '';
        if (kind === 'foreign') request.foreignLocations.push({ bbox: null });
        if (kind === 'panel-bounds-mode') request.preservePanelBounds = 'true';
        if (kind === 'owned-type') request.ownedTextLocations = {};
        if (kind === 'owned-null') request.ownedTextLocations = null;
        if (kind === 'owned-bbox') request.ownedTextLocations = [{ bbox: null }];
        if (kind === 'owned-reversed') request.ownedTextLocations = [{ bbox: [300, 300, 200, 200] }];
        if (kind === 'owned-nan') request.ownedTextLocations = [{ bbox: [200, 200, NaN, 300] }];
        if (kind === 'owned-count') request.ownedTextLocations = [
            { bbox: [200, 200, 300, 300] }, { bbox: [400, 200, 500, 300] },
        ];
        const h = harness(kind === 'budget' ? { limits: { maxComparisons: 0 } }
            : kind === 'owned-count' ? { limits: { maxLayoutBlocks: 1 } } : {});
        try {
            const session = await h.renderer.open(sample.fileData);
            assert.equal(await session.recoverImageGroup(request), null);
            assert.equal(h.decoded(), 0);
        }
        finally { await h.renderer.disposeAll(); }
        assert.ok(h.released());
    }
});

test('cancels pending document-figure decoding and closes an image that arrives late', async () => {
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
