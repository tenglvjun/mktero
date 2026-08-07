import test from 'node:test';
import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    PDFAnnotationLocator,
    createPDFTextIndexCacheKey,
} from '../src/pdf/pdf-annotation-locator.js';
import {
    createPDFJSTextEngine,
} from '../src/pdf/pdfjs-text-engine.js';
import { sha256Hex } from '../src/core/sha256.js';
import {
    PDFTextIndexCache,
} from '../src/cache/pdf-text-index-cache.js';
import {
    createZoteroAnnotationActions,
} from '../src/platform/zotero-annotation-actions.js';

test('extracts PDF text without loading a packaged fake-worker URL', async () => {
    const fileData = new Uint8Array(await readFile(
        new URL('./fixtures/offline-annotation.pdf', import.meta.url)
    ));
    const engine = createTestPDFEngine({
        workerSrc: 'jar:file:///tmp/mktero.xpi!/pdf.worker.mjs',
    });

    try {
        const index = await engine.extract(fileData);

        assert.equal(index.pages[0].rawText, 'Ovulation limits (±2 days)');
    }
    finally {
        await engine.dispose();
    }
});

test('locates PDF text without an open Zotero reader', async () => {
    const fileData = new Uint8Array(await readFile(
        new URL('./fixtures/offline-annotation.pdf', import.meta.url)
    ));
    const locator = new PDFAnnotationLocator({
        engine: createTestPDFEngine(),
        createSourceHash: data => sha256Hex(data),
        measureText: ({ text }) => [...text].length,
        readerLocator: async () => {
            assert.fail('The open-reader fallback must not be used');
        },
    });
    const selectedText = 'Ovulation limits ( ± 2 days)';

    await locator.prepare(42, { fileData });
    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.pageLabel, '1');
    assert.equal(located.sortIndex, '00000|000000|00081');
    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.position.rects.length, 1);
    assertRectCloseTo(
        located.position.rects[0],
        [72, 698.86328125, 207.036, 710.86328125]
    );
    locator.dispose();
});

test('rejects malformed PDF bytes through the real PDF.js engine', async () => {
    const engine = createTestPDFEngine();

    await assert.rejects(
        engine.extract(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
        error => error instanceof Error
    );
    await engine.dispose();
});

test('extracts PDF bytes returned from another JavaScript realm', async () => {
    const localData = new Uint8Array(await readFile(
        new URL('./fixtures/offline-annotation.pdf', import.meta.url)
    ));
    const originalData = Uint8Array.from(localData);
    const fileData = runInNewContext(
        'new Uint8Array(source.buffer, source.byteOffset, source.byteLength)',
        { source: localData }
    );
    let forwardedData = null;
    const engine = createTestPDFEngine({
        loadDocument: options => {
            forwardedData = options.data;
            return getDocument(options);
        },
    });

    try {
        const index = await engine.extract(fileData);

        assert.equal(fileData instanceof Uint8Array, false);
        assert.equal(ArrayBuffer.isView(fileData), true);
        assert.equal(forwardedData instanceof Uint8Array, true);
        assert.notEqual(forwardedData.buffer, fileData.buffer);
        assert.deepEqual(Array.from(fileData), Array.from(originalData));
        assert.equal(index.pages[0].rawText, 'Ovulation limits (±2 days)');
    }
    finally {
        await engine.dispose();
    }
});

test('saves a Zotero highlight without opening the PDF reader', async () => {
    const fileData = new Uint8Array(await readFile(
        new URL('./fixtures/offline-annotation.pdf', import.meta.url)
    ));
    const locator = new PDFAnnotationLocator({
        engine: createTestPDFEngine(),
        createSourceHash: data => sha256Hex(data),
        loadFile: async itemID => {
            assert.equal(itemID, 42);
            return fileData;
        },
        readerLocator: async () => {
            assert.fail('The PDF reader must not be used');
        },
    });
    const attachment = {
        id: 42,
        isPDFAttachment: () => true,
    };
    let savedJSON;
    const zotero = {
        Items: {
            get: itemID => itemID === 42 ? attachment : null,
        },
        DataObjectUtilities: {
            generateKey: () => 'OFFLINE1',
        },
        Annotations: {
            async saveFromJSON(parent, json) {
                assert.equal(parent, attachment);
                savedJSON = json;
                return { key: json.key };
            },
        },
        Notifier: {
            Queue: class Queue {},
            async commit() {},
        },
    };
    const actions = createZoteroAnnotationActions(zotero, {
        locateText: (itemID, text, options) => (
            locator.locate(itemID, text, options)
        ),
    });

    const created = await actions.createFromText(42, {
        text: 'Ovulation limits ( ± 2 days)',
        comment: 'Offline sync',
        color: '#ffd400',
        pdfPageIndexHint: 0,
    });

    assert.equal(created.id, 'OFFLINE1');
    assert.equal(created.source, 'zotero');
    assert.equal(savedJSON.position.pageIndex, 0);
    assert.equal(savedJSON.position.rects.length, 1);
    assert.equal('Reader' in zotero, false);
    locator.dispose();
});

test('invalidates cached indexes when PDF content or parser profile changes', async () => {
    const first = await createPDFTextIndexCacheKey(
        'a'.repeat(64),
        'pdfjs-test|text-v1'
    );
    const contentChanged = await createPDFTextIndexCacheKey(
        'b'.repeat(64),
        'pdfjs-test|text-v1'
    );
    const profileChanged = await createPDFTextIndexCacheKey(
        'a'.repeat(64),
        'pdfjs-test|text-v2'
    );

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, contentChanged);
    assert.notEqual(first, profileChanged);
});

test('reuses a persisted PDF text index after restart', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-pdf-index-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const fileData = new Uint8Array(await readFile(
        new URL('./fixtures/offline-annotation.pdf', import.meta.url)
    ));
    const cache = new PDFTextIndexCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
        now: () => 1_700_000_000_000,
    });
    const first = new PDFAnnotationLocator({
        engine: createTestPDFEngine(),
        cache,
        createSourceHash: data => sha256Hex(data),
    });
    await first.prepare(42, { fileData });
    first.dispose();
    const restored = new PDFAnnotationLocator({
        engine: createTestPDFEngine({
            loadDocument() {
                assert.fail('A cached PDF must not be parsed again');
            },
        }),
        cache,
        loadFile: async itemID => {
            assert.equal(itemID, 42);
            return fileData;
        },
        createSourceHash: data => sha256Hex(data),
    });

    const located = await restored.locate(42, 'Ovulation limits', {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.pageLabel, '1');
    restored.dispose();
});

test('destroys in-flight PDF.js work when the engine is disposed', async () => {
    let rejectLoading;
    let destroyCalls = 0;
    const engine = createTestPDFEngine({
        loadDocument() {
            return {
                promise: new Promise((_resolve, reject) => {
                    rejectLoading = reject;
                }),
                destroy() {
                    destroyCalls++;
                    rejectLoading(new Error('PDF loading destroyed'));
                    return Promise.resolve();
                },
            };
        },
    });
    const extraction = engine.extract(new Uint8Array([1]));

    await Promise.resolve();
    await engine.dispose();

    await assert.rejects(extraction, /PDF loading destroyed/);
    assert.equal(destroyCalls, 1);
    await assert.rejects(
        engine.extract(new Uint8Array([1])),
        error => error?.code === 'MKTERO_PDF_INDEX_UNAVAILABLE'
    );
});

test('cancels lazy PDF.js work on locator disposal without a caller signal', async () => {
    let rejectLoading;
    let notifyLoadingStarted;
    let destroyCalls = 0;
    const loadingStarted = new Promise(resolve => {
        notifyLoadingStarted = resolve;
    });
    const locator = new PDFAnnotationLocator({
        engine: createTestPDFEngine({
            loadDocument() {
                notifyLoadingStarted();
                return {
                    promise: new Promise((_resolve, reject) => {
                        rejectLoading = reject;
                    }),
                    destroy() {
                        destroyCalls++;
                        rejectLoading(new Error('PDF loading destroyed'));
                    },
                };
            },
        }),
        createSourceHash: async () => 'f'.repeat(64),
        loadFile: async () => new Uint8Array([1]),
    });
    const location = locator.locate(42, 'Selected text');
    await loadingStarted;

    locator.dispose();

    await assert.rejects(
        location,
        error => error?.code === 'MKTERO_PDF_INDEX_UNAVAILABLE'
    );
    assert.equal(destroyCalls, 1);
});

test('does not start PDF.js after disposal during source hashing', async () => {
    let resolveHash;
    let extractCalls = 0;
    const locator = new PDFAnnotationLocator({
        engine: {
            profile: 'test-profile',
            async extract() {
                extractCalls++;
                return { profile: 'test-profile', pages: [] };
            },
            dispose() {},
        },
        createSourceHash: () => new Promise(resolve => {
            resolveHash = resolve;
        }),
    });
    const preparation = locator.prepare(42, {
        fileData: new Uint8Array([1]),
    });
    locator.dispose();
    resolveHash('a'.repeat(64));

    await assert.rejects(
        preparation,
        error => error?.code === 'MKTERO_PDF_INDEX_UNAVAILABLE'
    );
    assert.equal(extractCalls, 0);
});

test('does not start PDF.js after disposal during a cache lookup', async () => {
    let resolveCache;
    let notifyCacheStarted;
    let extractCalls = 0;
    const cacheStarted = new Promise(resolve => {
        notifyCacheStarted = resolve;
    });
    const locator = new PDFAnnotationLocator({
        engine: {
            profile: 'test-profile',
            async extract() {
                extractCalls++;
                return { profile: 'test-profile', pages: [] };
            },
            dispose() {},
        },
        cache: {
            get() {
                notifyCacheStarted();
                return new Promise(resolve => {
                    resolveCache = resolve;
                });
            },
        },
        createSourceHash: async () => 'a'.repeat(64),
    });
    const preparation = locator.prepare(42, {
        fileData: new Uint8Array([1]),
    });
    await cacheStarted;
    locator.dispose();
    resolveCache(null);

    await assert.rejects(
        preparation,
        error => error?.code === 'MKTERO_PDF_INDEX_UNAVAILABLE'
    );
    assert.equal(extractCalls, 0);
});

test('isolates cancellation between items sharing one PDF index task', async () => {
    let engineSignal;
    const resolveIndexes = [];
    let extractCalls = 0;
    let notifyExtractionStarted;
    const extractionStarted = new Promise(resolve => {
        notifyExtractionStarted = resolve;
    });
    let notifySecondConsumerStarted;
    const secondConsumerStarted = new Promise(resolve => {
        notifySecondConsumerStarted = resolve;
    });
    const secondSignal = {
        aborted: false,
        addEventListener(type) {
            if (type === 'abort') notifySecondConsumerStarted();
        },
        removeEventListener() {},
    };
    const index = { profile: 'test-profile', pages: [] };
    const locator = new PDFAnnotationLocator({
        engine: {
            profile: 'test-profile',
            extract(_fileData, { signal }) {
                extractCalls++;
                engineSignal = signal;
                notifyExtractionStarted();
                return new Promise(resolve => {
                    resolveIndexes.push(resolve);
                });
            },
            dispose() {},
        },
        createSourceHash: async () => 'a'.repeat(64),
    });
    const firstController = new AbortController();
    const fileData = new Uint8Array([1]);
    const first = locator.prepare(42, {
        fileData,
        signal: firstController.signal,
    });
    await extractionStarted;
    const second = locator.prepare(84, {
        fileData,
        signal: secondSignal,
    });
    await secondConsumerStarted;
    assert.equal(extractCalls, 1);

    firstController.abort();
    const firstOutcome = await Promise.race([
        first.then(
            () => 'fulfilled',
            error => error?.name
        ),
        new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]);
    for (const resolveIndex of resolveIndexes) resolveIndex(index);
    const secondIndex = await Promise.race([
        second,
        new Promise(resolve => setImmediate(() => resolve('pending'))),
    ]);

    assert.equal(firstOutcome, 'AbortError');
    assert.equal(engineSignal.aborted, false);
    assert.equal(secondIndex, index);
    locator.dispose();
});

test('aborts shared PDF.js work after its final consumer cancels', async () => {
    let engineSignal;
    let notifyExtractionStarted;
    const extractionStarted = new Promise(resolve => {
        notifyExtractionStarted = resolve;
    });
    const locator = new PDFAnnotationLocator({
        engine: {
            profile: 'test-profile',
            extract(_fileData, { signal }) {
                engineSignal = signal;
                notifyExtractionStarted();
                return new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(signal.reason);
                    }, { once: true });
                });
            },
            dispose() {},
        },
        createSourceHash: async () => 'a'.repeat(64),
    });
    const controller = new AbortController();
    const preparation = locator.prepare(42, {
        fileData: new Uint8Array([1]),
        signal: controller.signal,
    });
    await extractionStarted;

    controller.abort();

    await assert.rejects(
        preparation,
        error => error?.name === 'AbortError'
    );
    assert.equal(engineSignal.aborted, true);
    locator.dispose();
});

test('destroys PDF.js work when the conversion signal is aborted', async () => {
    let rejectLoading;
    let destroyCalls = 0;
    const controller = new AbortController();
    const engine = createTestPDFEngine({
        loadDocument() {
            return {
                promise: new Promise((_resolve, reject) => {
                    rejectLoading = reject;
                }),
                destroy() {
                    destroyCalls++;
                    rejectLoading(new Error('PDF loading aborted'));
                },
            };
        },
    });
    const extraction = engine.extract(new Uint8Array([1]), {
        signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(extraction, /PDF loading aborted/);
    assert.equal(destroyCalls, 1);
    await engine.dispose();
});

test('does not search a ready PDF index after its signal is aborted', async () => {
    let readerCalls = 0;
    const locator = await createSyntheticLocator([[
        createTextItem('Selected text'),
    ]], {
        readerLocator: async () => {
            readerCalls++;
            return null;
        },
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        locator.locate(42, 'Selected text', {
            signal: controller.signal,
        }),
        error => error?.name === 'AbortError'
    );
    assert.equal(readerCalls, 0);
    locator.dispose();
});

test('classifies an offline PDF parsing failure as an unavailable index', async () => {
    const locator = new PDFAnnotationLocator({
        engine: {
            profile: 'test-profile',
            async extract() {
                throw new Error('private attachment path');
            },
        },
        createSourceHash: async () => 'a'.repeat(64),
        loadFile: async () => new Uint8Array([1]),
        readerLocator: async () => null,
    });

    await assert.rejects(
        locator.locate(42, 'Selected text'),
        error => error?.code === 'MKTERO_PDF_INDEX_UNAVAILABLE'
            && error.message === 'The local PDF text index is unavailable'
    );
    locator.dispose();
});

test('uses a PDF page hint to disambiguate repeated text', async () => {
    const locator = await createSyntheticLocator([
        [createTextItem('Repeated result', { y: 700 })],
        [createTextItem('Repeated result', { y: 640 })],
    ]);

    const located = await locator.locate(42, 'Repeated result', {
        pdfPageIndexHint: 1,
    });

    assert.equal(located.position.pageIndex, 1);
    assert.equal(located.pageLabel, '2');
    await assert.rejects(
        locator.locate(42, 'Repeated result'),
        error => error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
    locator.dispose();
});

test('does not guess between repeated text on the hinted page', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Repeated result', { y: 700, hasEOL: true }),
        createTextItem('Repeated result', { y: 680 }),
    ]]);

    await assert.rejects(
        locator.locate(42, 'Repeated result', { pdfPageIndexHint: 0 }),
        error => error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
    locator.dispose();
});

test('creates exact rectangles for partial and multi-line TextItems', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('prefix Selected suffix', {
            width: 220,
            y: 700,
            hasEOL: true,
        }),
        createTextItem('text continues', {
            width: 140,
            y: 680,
        }),
    ]]);

    const partial = await locator.locate(42, 'Selected', {
        pdfPageIndexHint: 0,
    });
    const multiLine = await locator.locate(42, 'suffix text', {
        pdfPageIndexHint: 0,
    });

    assertRectCloseTo(partial.position.rects[0], [142, 697.6, 222, 709.6]);
    assert.equal(multiLine.position.rects.length, 2);
    assert.ok(multiLine.position.rects.every(rect => (
        rect.every(Number.isFinite) && rect[2] > rect[0] && rect[3] > rect[1]
    )));
    locator.dispose();
});

test('recovers a visual word space between adjacent PDF.js TextItems', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('hello', { x: 72, width: 50 }),
        createTextItem('world', { x: 128, width: 50 }),
    ]]);

    const located = await locator.locate(42, 'hello world', {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, 'hello world');
    assert.equal(located.position.rects.length, 2);
    locator.dispose();
});

test('does not invent spaces inside contiguous or CJK TextItems', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('hello', { x: 72, width: 50 }),
        createTextItem('world', { x: 122, width: 50, hasEOL: true }),
        createTextItem('中', { x: 72, y: 680, width: 12 }),
        createTextItem('文', { x: 90, y: 680, width: 12 }),
    ]]);

    const contiguous = await locator.locate(42, 'helloworld', {
        pdfPageIndexHint: 0,
    });
    const cjk = await locator.locate(42, '中文', {
        pdfPageIndexHint: 0,
    });

    assert.equal(contiguous.position.pageIndex, 0);
    assert.equal(cjk.position.pageIndex, 0);
    locator.dispose();
});

test('rejects untrusted non-finite PDF.js TextItem geometry', async () => {
    await assert.rejects(
        createSyntheticLocator([[
            createTextItem('Selected text', {
                transform: [12, 0, 0, 12, Infinity, 700],
            }),
        ]]),
        /PDF text item geometry is invalid/
    );
});

test('matches PDF whitespace, signed numbers, dehyphenation, and CJK text', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('A\u00a0total (±2 days) 中文 ovu-', {
            y: 700,
            hasEOL: true,
        }),
        createTextItem('lation result', { y: 680 }),
    ]]);

    const located = await locator.locate(
        42,
        'A total ( ± 2 days) 中文 ovulation result',
        { pdfPageIndexHint: 0 }
    );

    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.position.rects.length, 2);
    locator.dispose();
});

test('matches a LaTeX signed number against a compact PDF symbol', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('equivalence limits (±2 days).'),
    ]]);

    const located = await locator.locate(
        42,
        'equivalence limits ( \\pm 2 days).',
        { pdfPageIndexHint: 0 }
    );

    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.position.rects.length, 1);
    locator.dispose();
});

test('reports text-less PDFs as not found', async () => {
    const locator = await createSyntheticLocator([[]]);

    await assert.rejects(
        locator.locate(42, 'OCR-only text', { pdfPageIndexHint: 0 }),
        error => error?.code === 'MKTERO_PDF_TEXT_NOT_FOUND'
    );
    locator.dispose();
});

test('creates finite rectangles for rotated and right-to-left text', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Rotated text', {
            width: 120,
            hasEOL: true,
            transform: [0, 12, -12, 0, 160, 620],
        }),
        createTextItem('אבשלוםגד', {
            dir: 'rtl',
            width: 80,
            y: 580,
        }),
    ]]);

    const rotated = await locator.locate(42, 'Rotated', {
        pdfPageIndexHint: 0,
    });
    const rtl = await locator.locate(42, 'שלום', {
        pdfPageIndexHint: 0,
    });

    for (const rect of [rotated.position.rects[0], rtl.position.rects[0]]) {
        assert.ok(rect.every(Number.isFinite));
        assert.ok(rect[2] > rect[0]);
        assert.ok(rect[3] > rect[1]);
    }
    assert.ok(rotated.position.rects[0][3] - rotated.position.rects[0][1] > 60);
    assertRectCloseTo(rtl.position.rects[0], [92, 577.6, 132, 589.6]);
    locator.dispose();
});

test('keeps offline annotation location usable when cache writes fail', async () => {
    const failure = new Error('cache unavailable');
    const diagnostics = [];
    const locator = await createSyntheticLocator([[
        createTextItem('Selected text'),
    ]], {
        cache: {
            get: async () => null,
            put: async () => { throw failure; },
        },
        onError: error => diagnostics.push(error),
    });

    const located = await locator.locate(42, 'Selected text', {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.position.pageIndex, 0);
    assert.deepEqual(diagnostics, [failure]);
    locator.dispose();
});

test('preserves selected Markdown text when using the Reader fallback', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Different PDF text'),
    ]], {
        readerLocator: async () => ({
            text: 'Different Reader text',
            pageLabel: '1',
            sortIndex: '00000|0000001|0000001',
            position: {
                pageIndex: 0,
                rects: [[72, 700, 180, 712]],
            },
        }),
    });

    const located = await locator.locate(42, 'Selected Markdown text', {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, 'Selected Markdown text');
    locator.dispose();
});

async function createSyntheticLocator(pageItems, {
    cache = null,
    onError = () => {},
    readerLocator = null,
} = {}) {
    const engine = createTestPDFEngine({
        loadDocument() {
            return {
                promise: Promise.resolve({
                    numPages: pageItems.length,
                    async getPageLabels() {
                        return pageItems.map((_items, index) => (
                            String(index + 1)
                        ));
                    },
                    async getPage(pageNumber) {
                        return {
                            getViewport() {
                                return {
                                    transform: [1, 0, 0, -1, 0, 792],
                                    width: 612,
                                    height: 792,
                                };
                            },
                            async getTextContent() {
                                return {
                                    items: pageItems[pageNumber - 1],
                                    styles: {
                                        F1: {
                                            fontFamily: 'sans-serif',
                                            ascent: 0.8,
                                            descent: -0.2,
                                            vertical: false,
                                        },
                                    },
                                };
                            },
                            cleanup() {},
                        };
                    },
                }),
                destroy: async () => {},
            };
        },
    });
    const locator = new PDFAnnotationLocator({
        engine,
        cache,
        createSourceHash: async () => 'b'.repeat(64),
        measureText: ({ text }) => [...text].length,
        onError,
        readerLocator,
    });
    await locator.prepare(42, { fileData: new Uint8Array([1]) });
    return locator;
}

function createTextItem(text, {
    x = 72,
    y = 700,
    width = [...text].length * 10,
    height = 12,
    hasEOL = false,
    dir = 'ltr',
    transform = [12, 0, 0, 12, x, y],
} = {}) {
    return {
        str: text,
        dir,
        width,
        height,
        transform,
        fontName: 'F1',
        hasEOL,
    };
}

function createTestPDFEngine(options = {}) {
    return createPDFJSTextEngine({
        standardFontDataUrl: fileURLToPath(new URL(
            '../node_modules/pdfjs-dist/standard_fonts/',
            import.meta.url
        )),
        ...options,
    });
}

function assertRectCloseTo(actual, expected) {
    assert.equal(actual.length, expected.length);
    for (let index = 0; index < expected.length; index++) {
        assert.ok(
            Math.abs(actual[index] - expected[index]) < 0.01,
            `Expected ${actual[index]} to be close to ${expected[index]}`
        );
    }
}

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await stat(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        async makeDirectory(filePath, { ignoreExisting } = {}) {
            await mkdir(filePath, { recursive: Boolean(ignoreExisting) });
        },
        async readUTF8(filePath) {
            return readFile(filePath, 'utf8');
        },
        async writeUTF8(filePath, data, { tmpPath } = {}) {
            if (!tmpPath) return writeFile(filePath, data, 'utf8');
            await writeFile(tmpPath, data, 'utf8');
            await rename(tmpPath, filePath);
        },
        stat,
        async getChildren(filePath) {
            return (await readdir(filePath)).map(child => (
                path.join(filePath, child)
            ));
        },
        async remove(filePath, { recursive, ignoreAbsent } = {}) {
            await rm(filePath, {
                recursive: Boolean(recursive),
                force: Boolean(ignoreAbsent),
            });
        },
    };
}
