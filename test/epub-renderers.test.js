import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import katex from 'katex';

import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { createZoteroEpubRenderers } from '../src/platform/zotero-epub-renderers.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const WEBP_BYTES = Uint8Array.from(Buffer.from(
    'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
    'base64'
));
const PNG_BYTES = createTestPNG(16, 8);
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';
const FORMULAS = [
    { name: 'pmb', source: String.raw`\pmb{x+y}` },
    { name: 'fcolorbox', source: String.raw`\fcolorbox{red}{yellow}{\(x^2+y_1\)}` },
    { name: 'smallint', source: String.raw`\smallint_0^1 x\,dx` },
    {
        name: 'S25',
        source: String.raw`| F (\pmb{x}) - \tilde{F} (\pmb{x}) | < \epsilon ,\tag{S25}`,
    },
    {
        name: 'W-subscripts',
        source: String.raw`W^{(d)} = W_{\parallel}^{(d)} + W_{\perp}^{(d)}`,
    },
    {
        name: 'W-prescripts',
        source: String.raw`W^{(d)} = ^{\perp}W^{(d)} + ^{\parallel}W^{(d)}`,
    },
    { name: 'linebreak', source: String.raw`a\\b`, directKaTeX: true },
];

function generatedMath(source, { directKaTeX = false } = {}) {
    // The Markdown preprocessor currently handles display \\\\ differently.
    // Exercise KaTeX's real linebreak output without changing that layer.
    const html = directKaTeX ? katex.renderToString(source, {
        output: 'mathml', displayMode: false, strict: 'ignore',
        throwOnError: true, trust: false, maxExpand: 1_000, maxSize: 20,
    }) : renderMarkdownHTML(`$$${source}$$`, { target: 'epub' });
    const dom = new JSDOM(html);
    try {
        assert.equal(dom.window.document.querySelector('.math-fallback, .katex-error'), null);
        const formulas = dom.window.document.querySelectorAll('math');
        assert.equal(formulas.length, 1);
        assert.equal(formulas[0].namespaceURI, MATHML_NAMESPACE);
        assert.equal(formulas[0].querySelector('annotation')?.getAttribute('encoding'), 'application/x-tex');
        return formulas[0].outerHTML;
    }
    finally {
        dom.window.close();
    }
}

// Compare presentation structure, attributes, and text independently of XML
// namespace declaration placement and attribute serialization order.
function mathPresentation(element) {
    return {
        name: element.localName,
        namespace: element.namespaceURI,
        attributes: [...element.attributes]
            .filter(attribute => attribute.name !== 'xmlns')
            .map(attribute => [attribute.name, attribute.value]).sort(),
        children: [...element.childNodes]
            .filter(node => node.nodeType !== 1 || node.localName !== 'annotation')
            .map(node => node.nodeType === 1 ? mathPresentation(node) : node.textContent),
    };
}

// The real EPUB and figure-canvas adapters run against this local window.
// Bitmap decoding and canvas encoding are browser API stubs, not codec tests.
function createRendererHarness({
    width = 16,
    height = 8,
    encode = callback => callback(new Blob([PNG_BYTES], { type: 'image/png' })),
} = {}) {
    const blobs = [];
    const decodedBlobs = [];
    const canvases = [];
    const bitmap = {
        width,
        height,
        closeCalls: 0,
        close() {
            this.closeCalls++;
        },
    };
    const view = {
        closed: false,
        Blob: class WindowBlob extends Blob {
            constructor(parts, options) {
                super(parts, options);
                blobs.push(this);
            }
        },
        async createImageBitmap(blob) {
            assert.equal(this, view);
            assert.ok(blob instanceof view.Blob);
            decodedBlobs.push(blob);
            return bitmap;
        },
    };
    const document = {
        defaultView: view,
        createElementNS(namespace, tag) {
            assert.equal(namespace, 'http://www.w3.org/1999/xhtml');
            assert.equal(tag, 'canvas');
            const fills = [];
            const draws = [];
            const encodings = [];
            const context = {
                fillStyle: '',
                fillRect(...args) {
                    fills.push({ color: this.fillStyle, args });
                },
                drawImage(...args) {
                    assert.equal(bitmap.closeCalls, 0);
                    draws.push(args);
                },
            };
            const canvas = {
                ownerDocument: document,
                width: 0,
                height: 0,
                fills,
                draws,
                encodings,
                getContext(type, options) {
                    assert.equal(type, '2d');
                    assert.deepEqual(options, { alpha: false });
                    return context;
                },
                toBlob(callback, type) {
                    assert.equal(bitmap.closeCalls, 0);
                    encodings.push({ type, width: this.width, height: this.height });
                    encode(callback, type);
                },
            };
            canvases.push(canvas);
            return canvas;
        },
    };
    view.document = document;
    const renderers = createZoteroEpubRenderers({ getMainWindow: () => view }, {
        services: {},
    });
    return { renderers, view, bitmap, blobs, decodedBlobs, canvases };
}

function assertReleased(harness) {
    assert.equal(harness.bitmap.closeCalls, 1);
    for (const canvas of harness.canvases) {
        assert.equal(canvas.width, 0);
        assert.equal(canvas.height, 0);
    }
}

// JSDOM exercises the real MathML validation and SVG construction. Its layout,
// image decoding, and PNG encoding below are stubs, not real pixel validation.
function createTableRendererHarness() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const view = dom.window;
    const canvases = [];
    const encodings = [];
    const images = [];
    const svgSources = [];
    const mounts = [];
    const nativeAppend = view.document.body.append.bind(view.document.body);
    view.document.body.append = (...nodes) => {
        mounts.push(...nodes);
        nativeAppend(...nodes);
    };
    let serializedTable = '';
    const nativeCreate = view.document.createElementNS.bind(view.document);
    view.document.createElementNS = (...args) => {
        const element = nativeCreate(...args);
        if (element.localName === 'canvas') canvases.push(element);
        return element;
    };
    view.HTMLElement.prototype.getBoundingClientRect = function getRect() {
        return this.querySelector('math')
            ? { width: 120, height: 40, top: 0, bottom: 40 }
            : { width: 0, height: 0, top: 30, bottom: 30 };
    };
    view.HTMLCanvasElement.prototype.getContext = () => ({
        fillStyle: '',
        fillRect() {},
        setTransform() {},
        drawImage() {},
    });
    view.HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type) {
        assert.equal(type, 'image/png');
        encodings.push({ width: this.width, height: this.height });
        callback(new view.Blob([PNG_BYTES], { type }));
    };
    class ImageStub {
        naturalWidth = 320;
        naturalHeight = 120;

        constructor() {
            images.push(this);
        }

        set src(value) {
            this.source = value;
            svgSources.push(value);
            this.onload?.();
        }

        removeAttribute(name) {
            if (name === 'src') this.source = '';
        }
    }
    view.Image = ImageStub;
    const NativeXMLSerializer = view.XMLSerializer;
    view.XMLSerializer = class extends NativeXMLSerializer {
        serializeToString(node) {
            serializedTable = super.serializeToString(node);
            return serializedTable;
        }
    };
    const renderers = createZoteroEpubRenderers(
        { getMainWindow: () => view },
        { services: {} }
    );
    return {
        dom,
        renderers,
        canvases,
        encodings,
        images,
        svgSources,
        mounts,
        get serializedTable() {
            return serializedTable;
        },
    };
}

// Model the observed Chromium box metrics and an engine with native additive
// mpadded sizing. These rectangles test the contract, not actual glyph pixels.
function simulateMathBoxLayout(harness, { relativeSizes = false, bodyWidth = 72 } = {}) {
    const view = harness.dom.window;
    const reads = [];
    const snapshots = [];
    // JSDOM lacks MathMLElement.style; use its HTML CSSOM with attribute
    // reflection so the real adapter can apply its controlled padding.
    Object.defineProperty(view.Element.prototype, 'style', {
        get() {
            const element = this;
            const declaration = view.document.createElement('span').style;
            declaration.cssText = element.getAttribute('style') || '';
            return new Proxy(declaration, {
                get(target, property) {
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
                set(target, property, value) {
                    Reflect.set(target, property, value, target);
                    element.setAttribute('style', target.cssText);
                    return true;
                },
            });
        },
    });
    let fontsReady = false;
    let releaseFonts;
    Object.defineProperty(view.document, 'fonts', {
        value: {
            ready: new Promise(resolve => {
                releaseFonts = () => {
                    fontsReady = true;
                    resolve();
                };
            }),
        },
    });
    const rect = (left, top, width, height) => ({
        left, top, width, height, right: left + width, bottom: top + height,
    });
    view.Element.prototype.getBoundingClientRect = function getMathRect() {
        assert.ok(this.isConnected, 'Box measurements require mounted MathML');
        assert.ok(fontsReady, 'Box measurements must wait for fonts');
        let bounds;
        if (this.localName === 'mpadded') {
            const padding = Number.parseFloat(this.style.padding || '0') * 4 / 3;
            bounds = relativeSizes || padding > 0
                ? rect(0, 0, bodyWidth + 2 * (padding || 4) + 2, 28 + 2 * (padding || 4) + 2)
                : rect(0, 0, 10, 10);
        }
        else if (this.parentElement?.localName === 'mpadded') {
            bounds = rect(5, 5, bodyWidth, 28);
        }
        else if (this.localName === 'math') {
            bounds = this.querySelector('mpadded').getBoundingClientRect();
        }
        else {
            assert.fail('Unexpected MathML layout measurement: ' + this.localName);
        }
        reads.push({ name: this.localName, width: bounds.width, padding: this.style.padding });
        return bounds;
    };
    view.HTMLElement.prototype.getBoundingClientRect = function getContentRect() {
        const math = this.querySelector('math');
        return math ? math.getBoundingClientRect() : rect(0, 28, 0, 0);
    };
    const serialize = view.XMLSerializer.prototype.serializeToString;
    view.XMLSerializer.prototype.serializeToString = function serializeToString(node) {
        const box = node.querySelector('mpadded');
        snapshots.push({
            box: box.getBoundingClientRect(),
            body: box.firstElementChild.getBoundingClientRect(),
        });
        return serialize.call(this, node);
    };
    return { reads, snapshots, releaseFonts: () => releaseFonts() };
}

// These Range/line-box rectangles model glyphs outside the inline advance
// width; they verify raster dimensions and positioning, not real pixels.
function simulateMathRangeLayout(harness, ink, { width = 120 } = {}) {
    const view = harness.dom.window;
    const line = { left: -100_000, right: -100_000 + width, top: 12, bottom: 52, width, height: 40 };
    const reads = [];
    view.HTMLElement.prototype.getBoundingClientRect = function getRect() {
        assert.ok(this.isConnected, 'Range and baseline measurements require mounted MathML');
        return this.querySelector('math') ? line : {
            left: line.right, right: line.right, top: 42, bottom: 42, width: 0, height: 0,
        };
    };
    view.Range.prototype.getBoundingClientRect = function getRect() {
        const content = this.startContainer;
        assert.ok(content.isConnected, 'The content range must be measured while mounted');
        assert.ok(content.querySelector('math'));
        assert.equal(this.startOffset, 0);
        assert.equal(this.endContainer, content);
        assert.equal(this.endOffset, content.childNodes.length, 'The range must cover the final superscript');
        reads.push(content);
        return ink;
    };
    return { reads };
}

function assertRasterResourcesReleased(harness) {
    assert.equal(harness.dom.window.document.body.children.length, 0, 'Temporary DOM must be removed');
    for (const canvas of harness.canvases) {
        assert.equal(canvas.width, 0, 'Canvas width must be released');
        assert.equal(canvas.height, 0, 'Canvas height must be released');
    }
    for (const image of harness.images) {
        assert.equal(image.source, '', 'Decoded SVG source must be released');
        assert.equal(image.onload, null);
        assert.equal(image.onerror, null);
    }
}

async function renderMathInContext(harness, html, context) {
    if (context === 'formula') return harness.renderers.renderMathToPNG({ html });
    const precedingCells = context === 'wide-table'
        ? Array.from({ length: 8 }, (_, index) => `<td>Measured value ${index + 1}: 0.123 ± 0.004</td>`).join('') : '';
    return harness.renderers.renderWideTable({
        html: `<table><tbody><tr>${precedingCells}<td>${html}</td></tr></tbody></table>`,
    });
}

function serializedMath(harness) {
    const parsed = new harness.dom.window.DOMParser().parseFromString(harness.serializedTable, 'application/xml');
    assert.equal(parsed.querySelector('parsererror'), null);
    const formulas = parsed.querySelectorAll('math');
    assert.equal(formulas.length, 1);
    assert.equal(formulas[0].querySelector('annotation, annotation-xml'), null, 'Duplicate TeX must not be rasterized');
    return formulas[0];
}

test('converts a local WebP Blob to canvas PNG bytes and releases the bitmap and canvas', async () => {
    const h = createRendererHarness();

    const result = await h.renderers.renderImageToPNG({
        data: WEBP_BYTES,
        mimeType: 'image/webp',
    });

    assert.equal(h.blobs.length, 1);
    assert.deepEqual(h.decodedBlobs, h.blobs);
    assert.equal(h.decodedBlobs[0].type, 'image/webp');
    assert.deepEqual(new Uint8Array(await h.decodedBlobs[0].arrayBuffer()), WEBP_BYTES);
    assert.equal(h.canvases.length, 1);
    assert.deepEqual(h.canvases[0].fills, [{ color: '#fff', args: [0, 0, 16, 8] }]);
    assert.deepEqual(h.canvases[0].draws, [[h.bitmap, 0, 0, 16, 8]]);
    assert.deepEqual(h.canvases[0].encodings, [{ type: 'image/png', width: 16, height: 8 }]);
    assert.ok(result.data instanceof Uint8Array);
    assert.deepEqual(result, { mimeType: 'image/png', data: PNG_BYTES });
    assertReleased(h);
});

test('rasterizes formula presentation once with em dimensions and baseline alignment', async () => {
    const h = createTableRendererHarness();
    const view = h.dom.window;
    try {
        const result = await h.renderers.renderMathToPNG({
            html: '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>'
                + '<msup><mrow/><mtext>ID</mtext></msup>'
                + '<annotation encoding="application/x-tex">^{ID}</annotation>'
                + '</semantics></math>',
        });
        assert.deepEqual(result.data, PNG_BYTES);
        assert.equal(result.mimeType, 'image/png');
        assert.equal(result.width, 128 / 24);
        assert.equal(result.height, 2);
        assert.equal(result.verticalAlign, -14 / 24);
        assert.match(h.serializedTable, /<msup>/u);
        assert.doesNotMatch(h.serializedTable, /annotation|\^\{/u);
        assert.equal(h.canvases.length, 1);
        assertRasterResourcesReleased(h);
    }
    finally {
        view.close();
    }
});

test('preserves real KaTeX MathML presentation identically in formulas, table cells, and wide tables', async t => {
    for (const { name, source, directKaTeX } of FORMULAS) {
        await t.test(name, async () => {
            const html = generatedMath(source, { directKaTeX });
            const presentations = [];
            for (const context of ['formula', 'table', 'wide-table']) {
                const h = createTableRendererHarness();
                try {
                    const before = new h.dom.window.DOMParser().parseFromString(html, 'application/xml').documentElement;
                    assert.equal(before.querySelector('annotation').textContent, source);
                    const result = await renderMathInContext(h, html, context);
                    assert.deepEqual(result.data, PNG_BYTES);
                    assert.equal(result.mimeType, 'image/png');
                    if (context === 'formula') {
                        assert.ok(result.width > 0 && result.height > 0);
                        assert.ok(Number.isFinite(result.verticalAlign));
                    }
                    const math = serializedMath(h);
                    assert.deepEqual(mathPresentation(math), mathPresentation(before), context);
                    presentations.push(mathPresentation(math));
                    if (name === 'pmb') {
                        const bold = math.querySelector('mstyle[style]');
                        assert.equal(bold?.getAttribute('style'), 'text-shadow: 0.02em 0.01em 0.04px');
                        assert.equal(bold.textContent, 'x+y');
                    }
                    else if (name === 'fcolorbox') {
                        const box = math.querySelector('mpadded');
                        assert.equal(box?.getAttribute('style'), 'border: 0.04em solid red');
                        assert.equal(box.getAttribute('mathbackground'), 'yellow');
                        assert.equal(box.getAttribute('width'), '+6pt');
                        assert.equal(box.getAttribute('height'), '+6pt');
                        assert.equal(box.getAttribute('lspace'), '3pt');
                        assert.equal(box.getAttribute('voffset'), '3pt');
                        assert.equal(box.querySelector('msup')?.textContent, 'x2');
                        assert.equal(box.querySelector('msub')?.textContent, 'y1');
                    }
                    else if (name === 'smallint') {
                        assert.equal(math.querySelector('mo[largeop="false"]')?.textContent, '∫');
                        assert.equal(math.querySelector('munderover')?.textContent, '∫01');
                        assert.equal(math.textContent.replace(/\s/gu, ''), '∫01xdx');
                    }
                    else if (name === 'S25') {
                        assert.equal([...math.querySelectorAll('mtext')].filter(node => node.textContent === '(S25)').length, 1);
                        const bold = [...math.querySelectorAll('mstyle[style]')];
                        assert.equal(bold.length, 2);
                        assert.deepEqual(bold.map(node => node.getAttribute('style')), [
                            'text-shadow: 0.02em 0.01em 0.04px',
                            'text-shadow: 0.02em 0.01em 0.04px',
                        ]);
                        assert.deepEqual(bold.map(node => node.textContent), ['x', 'x']);
                        assert.equal([...math.querySelectorAll('mi')].filter(node => node.textContent === 'x').length, 2);
                        assert.ok(math.querySelector('mover'));
                        assert.ok(math.textContent.includes('<ϵ,'));
                        assert.equal(math.querySelector('semantics > mtable > mtr > mtd:last-child')?.textContent, '(S25)');
                    }
                    else if (name === 'W-subscripts' || name === 'W-prescripts') {
                        const row = math.querySelector('semantics > mrow');
                        const terms = [...row.children];
                        const subscripted = name === 'W-subscripts';
                        assert.deepEqual(terms.map(node => node.localName), subscripted
                            ? ['msup', 'mo', 'msubsup', 'mo', 'msubsup']
                            : ['msup', 'msup', 'msup', 'msup', 'msup']);
                        assert.deepEqual(terms.map(node => node.textContent), subscripted
                            ? ['W(d)', '=', 'W∥(d)', '+', 'W⊥(d)']
                            : ['W(d)', '=⊥', 'W(d)', '+∥', 'W(d)']);
                        assert.equal([...math.querySelectorAll('mi')].filter(node => node.textContent === 'W').length, 3);
                        assert.equal([...math.querySelectorAll('mi')].filter(node => node.textContent === 'd').length, 3);
                        const terminal = terms.at(-1);
                        assert.deepEqual([...terminal.children].map(node => node.textContent), subscripted
                            ? ['W', '⊥', '(d)'] : ['W', '(d)']);
                        assert.deepEqual([...terminal.lastElementChild.children].map(node => [node.localName, node.textContent]), [
                            ['mo', '('], ['mi', 'd'], ['mo', ')'],
                        ], 'The rightmost superscript must retain d and both parentheses');
                    }
                    else if (name === 'linebreak') {
                        assert.equal(math.querySelector('mspace')?.getAttribute('linebreak'), 'newline');
                        assert.deepEqual([...math.querySelectorAll('mi')].map(node => node.textContent), ['a', 'b']);
                    }
                    else {
                        assert.fail('Missing assertions for KaTeX fixture: ' + name);
                    }
                    assert.equal(h.canvases.length, 1);
                    assert.equal(h.images.length, 1);
                    assertRasterResourcesReleased(h);
                }
                finally {
                    h.dom.window.close();
                }
            }
            assert.deepEqual(presentations[0], presentations[1]);
            assert.deepEqual(presentations[0], presentations[2]);
        });
    }
});

test('includes glyph Range overflow in PNG dimensions, SVG padding, and baseline without changing the MathML', async t => {
    const rect = (left, top, width, height) => ({
        left, top, width, height, right: left + width, bottom: top + height,
    });
    const cases = [
        {
            name: 'right superscript overflow', ink: rect(-100_000, 12, 126.5, 40),
            dimensions: [135, 48], padding: ['4px', '4px', '4px', '4px'], verticalAlign: -14 / 24,
        },
        {
            name: 'left overflow', ink: rect(-100_006.5, 12, 126.5, 40),
            dimensions: [135, 48], padding: ['4px', '4px', '4px', '10.5px'], verticalAlign: -14 / 24,
        },
        {
            name: 'top overflow', ink: rect(-100_000, 6.75, 120, 45.25),
            dimensions: [128, 54], padding: ['9.25px', '4px', '4px', '4px'], verticalAlign: -14 / 24,
        },
        {
            name: 'bottom overflow', ink: rect(-100_000, 12, 120, 47.75),
            dimensions: [128, 56], padding: ['4px', '4px', '4px', '4px'], verticalAlign: -21.75 / 24,
        },
        {
            name: 'all four directions', ink: rect(-100_003.25, 6.75, 129.75, 53),
            dimensions: [138, 61], padding: ['9.25px', '4px', '4px', '7.25px'], verticalAlign: -21.75 / 24,
        },
        {
            name: 'observed Gecko terminal superscript', ink: rect(-100_000, 12, 200.483, 40), width: 193.966,
            dimensions: [209, 48], padding: ['4px', '4px', '4px', '4px'], verticalAlign: -14 / 24,
        },
        {
            name: 'range equals the line box', ink: rect(-100_000, 12, 120, 40),
            dimensions: [128, 48], padding: ['4px', '4px', '4px', '4px'], verticalAlign: -14 / 24,
        },
        {
            name: 'range contained in the line box', ink: rect(-99_998, 14, 116, 36),
            dimensions: [128, 48], padding: ['4px', '4px', '4px', '4px'], verticalAlign: -14 / 24,
        },
        {
            name: 'zero rectangle at the origin', ink: rect(0, 0, 0, 0),
            dimensions: [128, 48], padding: ['4px', '4px', '4px', '4px'], verticalAlign: -14 / 24,
        },
        {
            name: 'zero rectangle beyond all limits', ink: rect(-1_000_000, -1_000_000, 0, 0),
            dimensions: [128, 48], padding: ['4px', '4px', '4px', '4px'], verticalAlign: -14 / 24,
        },
    ];
    for (const { name, ink, width, dimensions, padding, verticalAlign } of cases) {
        await t.test(name, async () => {
            const h = createTableRendererHarness();
            const layout = simulateMathRangeLayout(h, ink, { width });
            try {
                const formula = FORMULAS.find(fixture => fixture.name === (width ? 'W-prescripts' : 'W-subscripts'));
                const html = generatedMath(formula.source);
                const result = await h.renderers.renderMathToPNG({ html });
                assert.equal(result.width, dimensions[0] / 24);
                assert.equal(result.height, dimensions[1] / 24);
                assert.equal(result.verticalAlign, verticalAlign);
                assert.deepEqual(result.data, PNG_BYTES);
                assert.deepEqual(h.encodings, [{ width: dimensions[0] * 2, height: dimensions[1] * 2 }],
                    'The PNG encoder must receive the expanded canvas dimensions');
                assert.equal(layout.reads.length, 1);
                assert.equal(h.svgSources.length, 1);
                const source = h.svgSources[0];
                assert.match(source, /^data:image\/svg\+xml;charset=utf-8,/u);
                const svg = new h.dom.window.DOMParser().parseFromString(
                    decodeURIComponent(source.slice(source.indexOf(',') + 1)), 'application/xml'
                );
                assert.equal(svg.querySelector('parsererror'), null);
                assert.equal(svg.documentElement.getAttribute('width'), String(dimensions[0]));
                assert.equal(svg.documentElement.getAttribute('height'), String(dimensions[1]));
                assert.equal(svg.documentElement.getAttribute('viewBox'), `0 0 ${dimensions[0]} ${dimensions[1]}`);
                const frame = svg.querySelector('foreignObject').firstElementChild;
                assert.deepEqual([frame.style.paddingTop, frame.style.paddingRight, frame.style.paddingBottom, frame.style.paddingLeft], padding,
                    'Negative glyph positions must be compensated inside the expanded SVG');
                const original = new h.dom.window.DOMParser().parseFromString(html, 'application/xml').documentElement;
                assert.deepEqual(mathPresentation(serializedMath(h)), mathPresentation(original));
                assertRasterResourcesReleased(h);
            }
            finally {
                h.dom.window.close();
            }
        });
    }
});

test('rejects excessive or nonfinite glyph Range overflow before SVG decoding and releases temporary DOM', async t => {
    const cases = [
        { name: 'right overflow', left: -100_000, right: -89_999, top: 12, bottom: 52, width: 10_001, height: 40 },
        { name: 'left overflow', left: -110_001, right: -99_880, top: 12, bottom: 52, width: 10_121, height: 40 },
        { name: 'top overflow', left: -100_000, right: -99_880, top: -10_001, bottom: 52, width: 120, height: 10_053 },
        { name: 'bottom overflow', left: -100_000, right: -99_880, top: 12, bottom: 10_053, width: 120, height: 10_041 },
        { name: 'pixel budget', left: -100_000, right: -94_000, top: 12, bottom: 4_112, width: 6_000, height: 4_100 },
        { name: 'nonfinite overflow', left: -100_000, right: Infinity, top: 12, bottom: 52, width: Infinity, height: 40 },
    ];
    const html = generatedMath(FORMULAS.find(fixture => fixture.name === 'W-subscripts').source);
    for (const { name, ...ink } of cases) {
        await t.test(name, async () => {
            const h = createTableRendererHarness();
            const layout = simulateMathRangeLayout(h, ink);
            try {
                await assert.rejects(h.renderers.renderMathToPNG({ html }), /formula exceeds the rendering size limit/u);
                assert.equal(h.mounts.length, 1);
                assert.equal(layout.reads.length, 1);
                assert.equal(h.serializedTable, '');
                assert.deepEqual(h.svgSources, []);
                assert.deepEqual(h.images, []);
                assert.deepEqual(h.canvases, []);
                assert.deepEqual(h.encodings, []);
                assertRasterResourcesReleased(h);
            }
            finally {
                h.dom.window.close();
            }
        });
    }
});

test('keeps the complete color-box body in formulas and table cells across MathML sizing engines', async t => {
    const html = generatedMath(FORMULAS.find(formula => formula.name === 'fcolorbox').source);
    for (const relativeSizes of [false, true]) {
        for (const context of ['formula', 'table']) {
            await t.test(`${relativeSizes ? 'native relative sizes' : 'Chromium fixed sizes'}: ${context}`, async () => {
                const h = createTableRendererHarness();
                const layout = simulateMathBoxLayout(h, { relativeSizes });
                try {
                    const before = new h.dom.window.DOMParser().parseFromString(html, 'application/xml').documentElement;
                    const expected = before.cloneNode(true);
                    const rendering = renderMathInContext(h, html, context);
                    await new Promise(resolve => setImmediate(resolve));
                    assert.equal(h.mounts.length, 1, 'The math must be mounted while fonts are pending');
                    assert.deepEqual(layout.reads, [], 'No dimensions may be read before fonts are ready');
                    layout.releaseFonts();
                    const result = await rendering;
                    const actual = serializedMath(h);
                    const box = actual.querySelector('mpadded');
                    const originalBox = before.querySelector('mpadded');
                    assert.equal(box.style.border, originalBox.style.border);
                    assert.equal(box.getAttribute('mathbackground'), 'yellow');
                    assert.deepEqual(mathPresentation(box.firstElementChild), mathPresentation(originalBox.firstElementChild));
                    assert.equal(box.querySelector('msup')?.textContent, 'x2');
                    assert.equal(box.querySelector('msub')?.textContent, 'y1');
                    if (relativeSizes) {
                        assert.equal(box.style.padding, '', 'Native additive dimensions must stay intact');
                        assert.deepEqual(mathPresentation(actual), mathPresentation(before));
                        assert.ok(layout.reads.filter(read => read.name === 'mpadded').every(read => read.width === 82));
                    }
                    else {
                        assert.ok(layout.reads.some(read => read.name === 'mpadded' && read.width === 10 && !read.padding),
                            'The engine must demonstrate overflow before adaptation');
                        assert.equal(box.style.padding, '3pt');
                        const expectedBox = expected.querySelector('mpadded');
                        for (const attribute of ['width', 'height', 'lspace', 'voffset']) {
                            assert.equal(box.hasAttribute(attribute), false, attribute + ' must be replaced by padding');
                            expectedBox.removeAttribute(attribute);
                        }
                        expectedBox.style.padding = '3pt';
                        assert.deepEqual(mathPresentation(actual), mathPresentation(expected),
                            'Only the four spacing attributes and controlled padding may change');
                    }
                    assert.equal(layout.snapshots.length, 1);
                    const bounds = layout.snapshots[0];
                    assert.ok(bounds.box.left <= bounds.body.left && bounds.box.top <= bounds.body.top);
                    assert.ok(bounds.box.right >= bounds.body.right && bounds.box.bottom >= bounds.body.bottom,
                        'The final box must contain every edge of the complete body');
                    assert.deepEqual(result.data, PNG_BYTES);
                    if (context === 'formula') {
                        assert.equal(result.width, (82 + 8) / 24, 'PNG dimensions must include the complete color box');
                        assert.equal(result.height, (38 + 8) / 24);
                    }
                    assert.equal(h.canvases.length, 1);
                    assert.equal(h.images.length, 1);
                    assertRasterResourcesReleased(h);
                }
                finally {
                    layout.releaseFonts();
                    h.dom.window.close();
                }
            });
        }
    }
});

test('leaves unrelated or unmeasurable mpadded structures intact even in a fixed-size engine', async t => {
    const cases = [
        { name: 'no color background', change: box => box.removeAttribute('mathbackground') },
        { name: 'missing offset', change: box => box.removeAttribute('voffset') },
        { name: 'different width', change: box => box.setAttribute('width', '+7pt') },
        { name: 'different height', change: box => box.setAttribute('height', '+7pt') },
        { name: 'different vertical offset', change: box => box.setAttribute('voffset', '2pt') },
        { name: 'non-point inset', change: box => box.setAttribute('lspace', '3px') },
        { name: 'multiple children', change: box => box.append(box.firstElementChild.cloneNode(true)) },
        {
            name: 'inset above the known box range',
            change(box) {
                box.setAttribute('lspace', '13pt');
                box.setAttribute('voffset', '13pt');
                box.setAttribute('width', '+26pt');
                box.setAttribute('height', '+26pt');
            },
        },
        {
            name: 'zero inset',
            change(box) {
                box.setAttribute('lspace', '0pt');
                box.setAttribute('voffset', '0pt');
                box.setAttribute('width', '+0pt');
                box.setAttribute('height', '+0pt');
            },
        },
        { name: 'unmeasurable body', change() {}, bodyWidth: 0 },
    ];
    const html = generatedMath(FORMULAS.find(formula => formula.name === 'fcolorbox').source);
    for (const { name, change, bodyWidth } of cases) {
        for (const context of ['formula', 'table']) {
            await t.test(`${name}: ${context}`, async () => {
                const h = createTableRendererHarness();
                const layout = simulateMathBoxLayout(h, { bodyWidth });
                try {
                    const before = new h.dom.window.DOMParser().parseFromString(html, 'application/xml').documentElement;
                    change(before.querySelector('mpadded'));
                    const rendering = renderMathInContext(h, before.outerHTML, context);
                    layout.releaseFonts();
                    await rendering;
                    const actual = serializedMath(h);
                    assert.deepEqual(mathPresentation(actual), mathPresentation(before));
                    assert.equal(actual.querySelector('mpadded').style.padding, '');
                    assertRasterResourcesReleased(h);
                }
                finally {
                    layout.releaseFonts();
                    h.dom.window.close();
                }
            });
        }
    }
});

test('accepts legal MathML linebreak and largeop attributes in formulas and table cells', async t => {
    for (const linebreak of ['auto', 'newline', 'nobreak', 'goodbreak', 'badbreak']) {
        await t.test(linebreak, async () => {
            const html = `<math xmlns="${MATHML_NAMESPACE}"><mrow>`
                + '<mo largeop="true">∑</mo><mi>x</mi>'
                + `<mspace width="0em" linebreak="${linebreak}"/>`
                + '<mo largeop="false">∫</mo></mrow></math>';
            for (const context of ['formula', 'table']) {
                const h = createTableRendererHarness();
                try {
                    await renderMathInContext(h, html, context);
                    const math = serializedMath(h);
                    assert.equal(math.querySelector('mspace')?.getAttribute('linebreak'), linebreak, context);
                    assert.deepEqual([...math.querySelectorAll('mo')].map(node => node.getAttribute('largeop')), ['true', 'false']);
                    assert.equal(math.textContent, '∑x∫');
                    assertRasterResourcesReleased(h);
                }
                finally {
                    h.dom.window.close();
                }
            }
        });
    }
});

test('removes only duplicate application/x-tex source while retaining the full presentation', async () => {
    const html = `<math xmlns="${MATHML_NAMESPACE}"><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow>`
        + '<annotation encoding="application/x-tex">\\text{&lt;img src=https://example.invalid/tex onerror=alert(1)&gt;}</annotation>'
        + '</semantics></math>';
    for (const context of ['formula', 'table']) {
        const h = createTableRendererHarness();
        try {
            await renderMathInContext(h, html, context);
            const math = serializedMath(h);
            assert.equal(math.querySelector('semantics > mrow')?.textContent, 'x+y');
            assert.equal(math.textContent, 'x+y');
            assert.doesNotMatch(h.serializedTable, /example\.invalid|onerror|annotation/u);
            assertRasterResourcesReleased(h);
        }
        finally {
            h.dom.window.close();
        }
    }
});

test('rejects unsafe or unknown MathML equally before mounting formulas and table cells', async t => {
    const math = body => `<math xmlns="${MATHML_NAMESPACE}">${body}</math>`;
    const cases = [
        ['unknown element', math('<futuremath><mi>x</mi></futuremath>')],
        ['active script', math('<script>alert(1)</script>')],
        ['unknown attribute', math('<mi future-attribute="value">x</mi>')],
        ['event handler', math('<mi onclick="window.epubUnsafe=true">x</mi>')],
        ['root event handler', `<math xmlns="${MATHML_NAMESPACE}" onload="alert(1)"><mi>x</mi></math>`],
        ['external href', math('<mi href="https://example.invalid/math">x</mi>')],
        ['javascript href', math('<mi href="javascript:alert(1)">x</mi>')],
        ['external mathcolor', math('<mstyle mathcolor="url(https://example.invalid/color)"><mi>x</mi></mstyle>')],
        ['external mathbackground', math('<mstyle mathbackground="url(https://example.invalid/bg)"><mi>x</mi></mstyle>')],
        ['foreign XHTML namespace', math('<mtext><img xmlns="http://www.w3.org/1999/xhtml" src="https://example.invalid/pixel"/></mtext>')],
        ['foreign SVG namespace', math('<mrow xmlns="http://www.w3.org/2000/svg"><mi>x</mi></mrow>')],
        ['wrong root namespace', '<math xmlns="urn:untrusted"><mi>x</mi></math>'],
        ['empty MathML namespace', '<math xmlns=""><mi>x</mi></math>'],
        ['namespaced link attribute', math('<mi xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.invalid/math">x</mi>')],
        ['namespaced allowed attribute name', math('<mi xmlns:evil="urn:untrusted" evil:mathcolor="red">x</mi>')],
        ['background style URL', math('<mstyle style="background:url(https://example.invalid/pixel)"><mi>x</mi></mstyle>')],
        ['extra shadow declaration', math('<mstyle style="text-shadow:0.02em 0.01em 0.04px;color:red"><mi>x</mi></mstyle>')],
        ['shadow URL', math('<mstyle style="text-shadow:url(https://example.invalid/shadow)"><mi>x</mi></mstyle>')],
        ['shadow CSS variable', math('<mstyle style="text-shadow:var(--shadow)"><mi>x</mi></mstyle>')],
        ['oversized shadow', math('<mstyle style="text-shadow:999999em 0em 0px"><mi>x</mi></mstyle>')],
        ['shadow on wrong element', math('<mi style="text-shadow:0.02em 0.01em 0.04px">x</mi>')],
        ['border URL', math('<mpadded style="border:0.04em solid url(https://example.invalid/border)"><mi>x</mi></mpadded>')],
        ['extra border declaration', math('<mpadded style="border:0.04em solid red;position:fixed"><mi>x</mi></mpadded>')],
        ['input padding on known color box', math('<mpadded mathbackground="yellow" width="+6pt" height="+6pt" lspace="3pt" voffset="3pt" style="border:0.04em solid red;padding:3pt"><mi>x</mi></mpadded>')],
        ['input padding alone', math('<mpadded style="padding:3pt"><mi>x</mi></mpadded>')],
        ['oversized border', math('<mpadded style="border:999999em solid red"><mi>x</mi></mpadded>')],
        ['border exceeds four pixels', math('<mpadded style="border:4.001px solid red"><mi>x</mi></mpadded>')],
        ['border exceeds three points', math('<mpadded style="border:3.001pt solid red"><mi>x</mi></mpadded>')],
        ['border exceeds em limit', math('<mpadded style="border:0.2em solid red"><mi>x</mi></mpadded>')],
        ['border with important override', math('<mpadded style="border:0.04em solid red !important"><mi>x</mi></mpadded>')],
        ['border on wrong element', math('<mstyle style="border:0.04em solid red"><mi>x</mi></mstyle>')],
        ['unrelated table style', math('<mstyle style="text-align:center"><mi>x</mi></mstyle>')],
        ['invalid largeop value', math('<mo largeop="yes">∫</mo>')],
        ['invalid linebreak value', math('<mspace linebreak="execute"/>')],
        ['oversized width', math('<mpadded width="999999em"><mi>x</mi></mpadded>')],
        ['oversized height', math('<mpadded height="999999em"><mi>x</mi></mpadded>')],
        ['oversized depth', math('<mpadded depth="999999em"><mi>x</mi></mpadded>')],
        ['oversized offset', math('<mpadded voffset="-999999em"><mi>x</mi></mpadded>')],
        ['oversized scriptlevel', math('<mstyle scriptlevel="999999"><mi>x</mi></mstyle>')],
        ['oversized row spacing', math('<mtable rowspacing="999999em"><mtr><mtd><mi>x</mi></mtd></mtr></mtable>')],
        ['non-finite size', math('<mspace width="Infinity"/>')],
        ['CSS expression size', math('<mspace width="calc(1em + 2px)"/>')],
        ['annotation without encoding', math('<semantics><mi>x</mi><annotation>x</annotation></semantics>')],
        ['annotation with text encoding', math('<semantics><mi>x</mi><annotation encoding="text/plain">different meaning</annotation></semantics>')],
        ['annotation with HTML encoding', math('<semantics><mi>x</mi><annotation encoding="text/html">&lt;img src=x&gt;</annotation></semantics>')],
        ['annotation-xml', math('<semantics><mi>x</mi><annotation-xml encoding="application/x-tex"><mi>y</mi></annotation-xml></semantics>')],
        ['annotation event handler', math('<semantics><mi>x</mi><annotation encoding="application/x-tex" onclick="alert(1)">x</annotation></semantics>')],
        ['annotation with nested markup', math('<semantics><mi>x</mi><annotation encoding="application/x-tex"><mi>y</mi></annotation></semantics>')],
    ];
    for (const [name, html] of cases) {
        await t.test(name, async t => {
            for (const context of ['formula', 'table']) {
                await t.test(context, async () => {
                    const h = createTableRendererHarness();
                    try {
                        await assert.rejects(renderMathInContext(h, html, context), /EPUB (?:formula|table)|MathML/u);
                        assert.equal(h.serializedTable, '', 'Unsafe MathML must not reach SVG serialization');
                        assert.equal(h.mounts.length, 0, 'Unsafe MathML must not be mounted');
                        assert.equal(h.canvases.length, 0);
                        assert.equal(h.images.length, 0);
                        assertRasterResourcesReleased(h);
                    }
                    finally {
                        h.dom.window.close();
                    }
                });
            }
        });
    }
});

test('rejects active or oversized formula markup before adopting it into the window', async t => {
    const cases = [
        '<math xmlns="http://www.w3.org/1998/Math/MathML" onclick="alert(1)"><mi>x</mi></math>',
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><mtext><img xmlns="http://www.w3.org/1999/xhtml" src="https://example.com/pixel" /></mtext></math>',
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><script>alert(1)</script></math>',
        '<!DOCTYPE math [<!ENTITY x "test">]><math xmlns="http://www.w3.org/1998/Math/MathML"><mi>&x;</mi></math>',
        '<math><mi>x</mi></math>',
        'x'.repeat(250_001),
    ];
    for (const [index, html] of cases.entries()) {
        await t.test(String(index), async () => {
            const h = createTableRendererHarness();
            try {
                await assert.rejects(h.renderers.renderMathToPNG({ html }), /EPUB formula/u);
                assert.equal(h.dom.window.document.body.children.length, 0);
                assert.equal(h.serializedTable, '');
            }
            finally {
                h.dom.window.close();
            }
        });
    }
});

test('cleans up MathML DOM, decoded SVGs, and canvases when rasterization fails', async t => {
    const cases = [
        {
            name: 'PNG encoder returns no Blob',
            configure(view) {
                view.HTMLCanvasElement.prototype.toBlob = callback => callback(null);
            },
            error: /PNG encoding failed/u,
        },
        {
            name: 'PNG encoder throws',
            configure(view) {
                view.HTMLCanvasElement.prototype.toBlob = () => { throw new Error('PNG encoder threw'); };
            },
            error: /PNG encoder threw/u,
        },
        {
            name: 'canvas context unavailable',
            configure(view) {
                view.HTMLCanvasElement.prototype.getContext = () => null;
            },
            error: /canvas is unavailable/u,
        },
        {
            name: 'SVG decoding fails',
            configure(view) {
                Object.defineProperty(view.Image.prototype, 'src', {
                    set(value) {
                        this.source = value;
                        this.onerror?.();
                    },
                });
            },
            error: /SVG could not be decoded/u,
        },
    ];
    for (const { name, configure, error } of cases) {
        for (const context of ['formula', 'table']) {
            await t.test(`${name}: ${context}`, async () => {
                const h = createTableRendererHarness();
                configure(h.dom.window);
                try {
                    await assert.rejects(renderMathInContext(h, generatedMath(FORMULAS[0].source), context), error);
                    assert.ok(h.serializedTable.includes('<math'));
                    assert.equal(h.images.length, 1);
                    assert.equal(h.canvases.length, name === 'SVG decoding fails' ? 0 : 1);
                    assertRasterResourcesReleased(h);
                }
                finally {
                    h.dom.window.close();
                }
            });
        }
    }
});

test('rasterizes table citations after removing link-only attributes', async () => {
    const h = createTableRendererHarness();
    try {
        const result = await h.renderers.renderWideTable({
            html: '<table><tbody><tr><td><a href="chapter-01.xhtml#references" '
                + 'rel="noreferrer">[1]</a></td></tr></tbody></table>',
        });

        assert.deepEqual(result, { mimeType: 'image/png', data: PNG_BYTES, alt: '' });
        assert.match(h.serializedTable, /<a>\[1\]<\/a>/u);
        assert.doesNotMatch(h.serializedTable, /\b(?:href|rel)=/iu);
    }
    finally {
        h.dom.window.close();
    }
});

test('rasterizes tables while stripping unsupported markup and attributes', async () => {
    const h = createTableRendererHarness();
    try {
        const result = await h.renderers.renderWideTable({
            html: '<table><tbody><tr><td>'
                + '<mark data-ocr="note">HRV</mark>'
                + '<span onclick="alert(1)" data-extra="value"> values</span>'
                + '<script>window.pwned = true</script>'
                + '<svg xmlns="http://www.w3.org/2000/svg"><text>hidden</text></svg>'
                + '</td></tr></tbody></table>',
        });

        assert.deepEqual(result, { mimeType: 'image/png', data: PNG_BYTES, alt: '' });
        assert.match(h.serializedTable, /HRV/iu);
        assert.match(h.serializedTable, /values/iu);
        assert.doesNotMatch(h.serializedTable, /<(?:mark|script|svg)\b/iu);
        assert.doesNotMatch(h.serializedTable, /\b(?:onclick|data-ocr|data-extra)=/iu);
        assert.doesNotMatch(h.serializedTable, /hidden|pwned/iu);
    }
    finally {
        h.dom.window.close();
    }
});

test('rejects image input above 25 MiB before creating a Blob or decoding', async () => {
    const h = createRendererHarness();

    await assert.rejects(h.renderers.renderImageToPNG({
        data: new Uint8Array(MAX_INPUT_BYTES + 1),
        mimeType: 'image/webp',
    }), { message: 'The EPUB image resource is invalid' });

    assert.deepEqual(h.blobs, []);
    assert.deepEqual(h.decodedBlobs, []);
    assert.deepEqual(h.canvases, []);
    assert.equal(h.bitmap.closeCalls, 0);
});

test('accepts image input at the 25 MiB boundary', async () => {
    const h = createRendererHarness();

    const result = await h.renderers.renderImageToPNG({
        data: new Uint8Array(MAX_INPUT_BYTES),
        mimeType: 'image/webp',
    });

    assert.equal(h.decodedBlobs.length, 1);
    assert.equal(h.decodedBlobs[0].size, MAX_INPUT_BYTES);
    assert.equal(h.canvases.length, 1);
    assert.deepEqual(result, { mimeType: 'image/png', data: PNG_BYTES });
    assertReleased(h);
});

test('rejects decoded images above 24 million pixels and closes the bitmap without a canvas', async () => {
    const h = createRendererHarness({ width: 6_000, height: 4_001 });

    await assert.rejects(h.renderers.renderImageToPNG({
        data: WEBP_BYTES,
        mimeType: 'image/webp',
    }), { message: 'The EPUB image exceeds the decoding limit' });

    assert.equal(h.decodedBlobs.length, 1);
    assert.deepEqual(h.canvases, []);
    assertReleased(h);
});

test('accepts decoded images at the 24 million pixel boundary', async () => {
    const h = createRendererHarness({ width: 6_000, height: 4_000 });

    const result = await h.renderers.renderImageToPNG({
        data: WEBP_BYTES,
        mimeType: 'image/webp',
    });

    assert.equal(h.canvases.length, 1);
    assert.deepEqual(h.canvases[0].draws, [[h.bitmap, 0, 0, 6_000, 4_000]]);
    assert.deepEqual(h.canvases[0].encodings, [{
        type: 'image/png', width: 6_000, height: 4_000,
    }]);
    assert.deepEqual(result, { mimeType: 'image/png', data: PNG_BYTES });
    assertReleased(h);
});

test('releases the bitmap and canvas when PNG encoding fails', async t => {
    const cases = [
        {
            name: 'encoder returns no Blob',
            encode: callback => callback(null),
            message: 'Figure PNG encoding failed or exceeded the limit',
        },
        {
            name: 'encoder throws',
            encode() {
                throw new Error('Canvas encoding failed');
            },
            message: 'Canvas encoding failed',
        },
        {
            name: 'encoded Blob bytes cannot be read',
            encode(callback) {
                callback({
                    type: 'image/png',
                    size: PNG_BYTES.byteLength,
                    async arrayBuffer() {
                        throw new Error('PNG Blob read failed');
                    },
                });
            },
            message: 'PNG Blob read failed',
        },
    ];
    for (const { name, encode, message } of cases) {
        await t.test(name, async () => {
            const h = createRendererHarness({ encode });

            await assert.rejects(h.renderers.renderImageToPNG({
                data: WEBP_BYTES,
                mimeType: 'image/webp',
            }), { message });

            assert.equal(h.decodedBlobs.length, 1);
            assert.equal(h.canvases.length, 1);
            assert.deepEqual(h.canvases[0].draws, [[h.bitmap, 0, 0, 16, 8]]);
            assert.deepEqual(h.canvases[0].encodings, [{
                type: 'image/png', width: 16, height: 8,
            }]);
            assertReleased(h);
        });
    }
});

test('reports an unavailable EPUB image decoder when the local window has no createImageBitmap', async () => {
    const h = createRendererHarness();
    delete h.view.createImageBitmap;

    await assert.rejects(h.renderers.renderImageToPNG({
        data: WEBP_BYTES,
        mimeType: 'image/webp',
    }), { message: 'The EPUB image decoder is unavailable' });

    assert.deepEqual(h.blobs, []);
    assert.deepEqual(h.decodedBlobs, []);
    assert.deepEqual(h.canvases, []);
    assert.equal(h.bitmap.closeCalls, 0);
});

test('rejects invalid image MIME values explicitly before decoding', async t => {
    const cases = [
        { name: 'missing MIME', mimeType: undefined },
        { name: 'non-string MIME', mimeType: 42 },
        { name: 'empty MIME', mimeType: '' },
        { name: 'non-image MIME', mimeType: 'text/html' },
        { name: 'missing image subtype', mimeType: 'image/' },
        { name: 'MIME with parameters', mimeType: 'image/webp; charset=utf-8' },
        { name: 'markup in MIME', mimeType: 'image/<svg>' },
    ];
    for (const { name, mimeType } of cases) {
        await t.test(name, async () => {
            const h = createRendererHarness();

            await assert.rejects(h.renderers.renderImageToPNG({
                data: WEBP_BYTES,
                mimeType,
            }), { message: 'The EPUB image resource is invalid' });

            assert.deepEqual(h.blobs, []);
            assert.deepEqual(h.decodedBlobs, []);
            assert.deepEqual(h.canvases, []);
            assert.equal(h.bitmap.closeCalls, 0);
        });
    }
});
