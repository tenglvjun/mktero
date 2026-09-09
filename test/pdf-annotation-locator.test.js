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
        assert.deepEqual(index.outline, []);
    }
    finally {
        await engine.dispose();
    }
});

test('keeps PDF bookmarks when getOutline succeeds and ignores outline failures', async () => {
    const fileData = new Uint8Array([1]);
    const engine = createTestPDFEngine({
        loadDocument() {
            const loadingTask = createSyntheticPDFDocument([[
                createTextItem('Selected text'),
            ]]);
            loadingTask.promise = loadingTask.promise.then(document => ({
                ...document,
                async getOutline() {
                    return [{
                        title: 'Introduction',
                        dest: ['page', 1],
                        items: [],
                    }];
                },
            }));
            return loadingTask;
        },
    });
    const failingEngine = createTestPDFEngine({
        loadDocument() {
            const loadingTask = createSyntheticPDFDocument([[
                createTextItem('Selected text'),
            ]]);
            loadingTask.promise = loadingTask.promise.then(document => ({
                ...document,
                async getOutline() {
                    throw new Error('outline unavailable');
                },
            }));
            return loadingTask;
        },
    });

    try {
        const indexed = await engine.extract(fileData);
        const failed = await failingEngine.extract(fileData);
        assert.deepEqual(indexed.outline, [{
            title: 'Introduction',
            items: [],
        }]);
        assert.equal(indexed.pages[0].rawText, 'Selected text');
        assert.deepEqual(failed.outline, []);
        assert.equal(failed.pages[0].rawText, 'Selected text');
    }
    finally {
        await engine.dispose();
        await failingEngine.dispose();
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

test('locates a Markdown passage that continues onto the next PDF page', async () => {
    const locator = await createSyntheticLocator([
        [createTextItem(
            'Wiki Layer (wiki/) This layer compiles raw traces into structured, '
                + 'compounding knowledge and is maintained throughout skill '
                + 'evolution. It contains a pattern directory (patterns/) populated',
            { width: 900, hasEOL: true }
        )],
        [createTextItem(
            'with individual markdown files that document specific failure modes '
                + 'and their fixes.',
            { width: 900, hasEOL: true }
        )],
    ]);

    const located = await locator.locate(
        42,
        'Wiki Layer (wiki/) This layer compiles raw traces into structured, '
            + 'compounding knowledge and is maintained throughout skill evolution. '
            + 'It contains a pattern directory (patterns/) populated with individual '
            + 'markdown files that document specific failure modes and their fixes.',
        { pdfPageIndexHint: 0 }
    );

    assert.equal(located.segments.length, 2);
    assert.equal(located.segments[0].position.pageIndex, 0);
    assert.equal(located.segments[1].position.pageIndex, 1);
    assert.match(located.segments[0].text, /populated$/u);
    assert.match(located.segments[1].text, /^with individual/u);
    locator.dispose();
});

test('locates cross-page text across repeated headers and page numbers', async () => {
    const runningHeader = 'WikiSkill: Compiling Agent Experience into Persistent Knowledge for Skill Evolution';
    const locator = await createSyntheticLocator([
        [
            createTextItem(runningHeader, { y: 780, hasEOL: true }),
            createTextItem(
                'Wiki Layer (wiki/) This layer compiles raw traces into structured, '
                    + 'compounding knowledge and is maintained throughout skill evolution. '
                    + 'It contains a pattern directory (patterns/) populated',
                { y: 100, width: 900, hasEOL: true }
            ),
            createTextItem('1', { y: 55, hasEOL: true }),
        ],
        [
            createTextItem(runningHeader, { y: 780, hasEOL: true }),
            createTextItem(
                'with individual markdown files that document specific failure modes '
                    + 'and successful strategies, along with actionable workarounds.',
                { y: 740, width: 900, hasEOL: true }
            ),
            createTextItem('2', { y: 55, hasEOL: true }),
        ],
    ]);

    const located = await locator.locate(
        42,
        'Wiki Layer (wiki/) This layer compiles raw traces into structured, '
            + 'compounding knowledge and is maintained throughout skill evolution. '
            + 'It contains a pattern directory (patterns/) populated with individual '
            + 'markdown files that document specific failure modes and successful '
            + 'strategies, along with actionable workarounds.',
        { pdfPageIndexHint: 0 }
    );

    assert.deepEqual(
        located.segments.map(segment => segment.position.pageIndex),
        [0, 1]
    );
    assert.match(located.segments[0].text, /populated$/u);
    assert.match(located.segments[1].text, /^with individual/u);
    locator.dispose();
});

test('keeps repeated cross-page passages ambiguous without a page hint', async () => {
    const locator = await createSyntheticLocator([
        [createTextItem('Shared passage begins', { width: 900, hasEOL: true })],
        [createTextItem('and continues', { width: 900, hasEOL: true })],
        [createTextItem('Shared passage begins', { width: 900, hasEOL: true })],
        [createTextItem('and continues', { width: 900, hasEOL: true })],
    ]);
    const selectedText = 'Shared passage begins and continues';

    await assert.rejects(
        locator.locate(42, selectedText),
        error => error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 2,
    });
    assert.deepEqual(
        located.segments.map(segment => segment.position.pageIndex),
        [2, 3]
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

test('extracts context for the PDF occurrence encoded by its sort index', async () => {
    const target = 'repeated result';
    const prefix = 'Opening context before the chosen ';
    const pageText = prefix + target
        + ' and unique first suffix. Later context before the other '
        + target + ' and other suffix.';
    const locator = await createSyntheticLocator([[
        createTextItem(pageText),
    ]]);
    const sourceOffset = pageText.indexOf(target);

    const textQuote = await locator.locateTextQuote(42, target, {
        pdfPageIndexHint: 0,
        sortIndex: `00000|${String(sourceOffset).padStart(6, '0')}|00000`,
    });

    assert.equal(textQuote.prefix, prefix);
    assert.match(textQuote.suffix, /^ and unique first suffix\./u);
    assert.ok([...textQuote.suffix].length <= 80);
    locator.dispose();
});

test('extracts folded context for a mixed-hyphen PDF occurrence', async () => {
    const target = 'pre-exercise and preexercise';
    const prefix = 'self-\nesteem context before ';
    const pdfTarget = 'pre-\nexercise and pre-\nexercise';
    const pageText = `${prefix}${pdfTarget} and unique suffix.`;
    const locator = await createSyntheticLocator([[
        createTextItem(pageText),
    ]]);
    const sourceOffset = pageText.indexOf(pdfTarget);

    const textQuote = await locator.locateTextQuote(42, target, {
        pdfPageIndexHint: 0,
        sortIndex: `00000|${String(sourceOffset).padStart(6, '0')}|00000`,
    });

    assert.equal(textQuote.prefix, 'selfesteem context before ');
    assert.match(textQuote.suffix, /^ and unique suffix\./u);
    locator.dispose();
});

test('bounds extracted PDF context by Unicode code points', async () => {
    const target = 'repeated result';
    const expectedPrefix = '😀'.repeat(80);
    const pageText = `Discarded prefix ${expectedPrefix}${target}`;
    const locator = await createSyntheticLocator([[
        createTextItem(pageText),
    ]]);
    const sourceOffset = pageText.indexOf(target);

    const textQuote = await locator.locateTextQuote(42, target, {
        pdfPageIndexHint: 0,
        sortIndex: `00000|${String(sourceOffset).padStart(6, '0')}|00000`,
    });

    assert.equal(textQuote.prefix, expectedPrefix);
    assert.equal([...textQuote.prefix].length, 80);
    locator.dispose();
});

test('rejects malformed or mismatched sort indexes for PDF context', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Opening context repeated result closing context.'),
    ]]);
    const invalidOptions = [
        { pdfPageIndexHint: 0, sortIndex: '' },
        { pdfPageIndexHint: 0, sortIndex: '00000|000016' },
        { pdfPageIndexHint: 0, sortIndex: '00000|000016|0000' },
        { pdfPageIndexHint: 0, sortIndex: '00000|000016|000000' },
        { pdfPageIndexHint: 1, sortIndex: '00000|000016|00000' },
        { pdfPageIndexHint: 0, sortIndex: '00000|000017|00000' },
    ];

    for (const options of invalidOptions) {
        assert.equal(
            await locator.locateTextQuote(42, 'repeated result', options),
            null
        );
    }
    locator.dispose();
});

test('returns no PDF context when the local text index is unavailable', async () => {
    const locator = new PDFAnnotationLocator({
        engine: {
            profile: 'test-profile',
            extract: async () => assert.fail('PDF extraction must not start'),
        },
        createSourceHash: async () => 'a'.repeat(64),
    });

    const textQuote = await locator.locateTextQuote(42, 'repeated result', {
        pdfPageIndexHint: 0,
        sortIndex: '00000|000000|00000',
    });

    assert.equal(textQuote, null);
    locator.dispose();
});

test('uses surrounding text to disambiguate repeated text on one page', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('BACKGROUND: Repeated result in prior work.', {
            y: 700,
            hasEOL: true,
        }),
        createTextItem('SUMMARY ANSWER: Repeated result for this study.', {
            y: 680,
        }),
    ]]);

    const located = await locator.locate(42, 'Repeated result', {
        pdfPageIndexHint: 0,
        textQuote: {
            prefix: 'SUMMARY ANSWER: ',
            suffix: ' for this study.',
        },
    });

    assert.equal(located.position.pageIndex, 0);
    assertRectCloseTo(
        located.position.rects[0],
        [232, 677.6, 382, 689.6]
    );
    locator.dispose();
});

test('does not guess when repeated text has the same surroundings', async () => {
    const repeated = 'SUMMARY ANSWER: Repeated result for this study.';
    const locator = await createSyntheticLocator([[
        createTextItem(repeated, { y: 700, hasEOL: true }),
        createTextItem(repeated, { y: 680 }),
    ]]);

    await assert.rejects(
        locator.locate(42, 'Repeated result', {
            pdfPageIndexHint: 0,
            textQuote: {
                prefix: 'SUMMARY ANSWER: ',
                suffix: ' for this study.',
            },
        }),
        error => error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
    locator.dispose();
});

test('does not guess from a partially matching surrounding quote', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('SUMMARY ANSWER: Repeated result for another study.', {
            y: 700,
            hasEOL: true,
        }),
        createTextItem('BACKGROUND: Repeated result in prior work.', { y: 680 }),
    ]]);

    await assert.rejects(
        locator.locate(42, 'Repeated result', {
            pdfPageIndexHint: 0,
            textQuote: {
                prefix: 'SUMMARY ANSWER: ',
                suffix: ' for this study.',
            },
        }),
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

test('reorders misplaced ligatures within a visual PDF line', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Result speci', { x: 72, width: 110 }),
        createTextItem(' ', { x: 182, width: 30, height: 0 }),
        createTextItem('city improved.', { x: 192, width: 140 }),
        createTextItem('ﬁ', { x: 182, width: 10 }),
        createTextItem('', { x: 72, y: 680, width: 0, hasEOL: true }),
    ]]);

    const located = await locator.locate(42, 'Result specificity improved.', {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.position.pageIndex, 0);
    assert.ok(located.position.rects.length > 0);
    locator.dispose();
});

test('does not reorder text across a wide multi-column gap', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Right column', { x: 350, width: 100 }),
        createTextItem('Left column', {
            x: 72,
            width: 100,
            hasEOL: true,
        }),
    ]]);

    const located = await locator.locate(42, 'Right columnLeft column', {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.position.pageIndex, 0);
    locator.dispose();
});

test('does not reorder text across a narrow multi-column gap', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Right column', { x: 350, width: 100 }),
        createTextItem('Left column', {
            x: 72,
            width: 260,
            hasEOL: true,
        }),
    ]]);

    const located = await locator.locate(42, 'Right columnLeft column', {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.position.pageIndex, 0);
    locator.dispose();
});

test('does not move a trailing ligature across a narrow column gap', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('speci', { x: 72, width: 40 }),
        createTextItem(' ', { x: 112, width: 30, height: 0 }),
        createTextItem('city', { x: 122, width: 30 }),
        createTextItem('Right column', { x: 170, width: 100 }),
        createTextItem('ﬁ', { x: 112, width: 10 }),
        createTextItem('', { x: 72, y: 680, width: 0, hasEOL: true }),
    ]]);

    const located = await locator.locate(
        42,
        'speci city Right columnﬁ',
        { pdfPageIndexHint: 0 }
    );

    assert.equal(located.position.pageIndex, 0);
    locator.dispose();
});

test('reorders a misplaced comparison operator before its number', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Excluded for', { x: 72, width: 100 }),
        createTextItem(' ', { x: 172, width: 50, height: 0 }),
        createTextItem('80% of the required duration', {
            x: 182,
            width: 250,
        }),
        createTextItem('<', { x: 176, width: 6 }),
        createTextItem('', { x: 72, y: 680, width: 0, hasEOL: true }),
    ]]);

    const located = await locator.locate(
        42,
        'Excluded for <80% of the required duration',
        { pdfPageIndexHint: 0 }
    );

    assert.equal(located.position.pageIndex, 0);
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
    await assert.rejects(
        createSyntheticLocator([[
            createTextItem('Selected', { x: 72, width: 80 }),
            createTextItem(' ', { x: 152, width: Infinity, height: 0 }),
            createTextItem('text', { x: 160, width: 40, hasEOL: true }),
        ]]),
        /PDF text item geometry is invalid/
    );
});

test('indexes a maximum-size PDF.js line without argument expansion', async () => {
    const item = createTextItem('', { width: 0, height: 0 });
    const engine = createTestPDFEngine({
        loadDocument() {
            return createSyntheticPDFDocument([
                Array(250_000).fill(item),
            ]);
        },
    });

    const index = await engine.extract(new Uint8Array([1]));

    assert.equal(index.pages[0].items.length, 250_000);
    await engine.dispose();
});

test('reorders a maximum-size PDF.js line in linear time', async () => {
    const placeholder = createTextItem(' ', {
        x: 112,
        width: 30,
        height: 0,
    });
    const pageItems = [
        createTextItem('speci', { x: 72, width: 40 }),
        ...Array(249_996).fill(placeholder),
        createTextItem('city', { x: 122, width: 30 }),
        createTextItem('ﬁ', { x: 112, width: 10 }),
        createTextItem('', { x: 72, y: 680, width: 0, hasEOL: true }),
    ];
    const engine = createTestPDFEngine({
        loadDocument: () => createSyntheticPDFDocument([pageItems]),
    });

    const index = await engine.extract(new Uint8Array([1]));

    assert.equal(pageItems.length, 250_000);
    assert.equal(index.pages[0].rawText, 'speciﬁcity\n');
    await engine.dispose();
});

test('rejects aggregate source TextItems beyond the index limit', async () => {
    const ignoredItem = { str: null };
    const engine = createTestPDFEngine({
        loadDocument: () => createSyntheticPDFDocument([
            Array(250_000).fill(ignoredItem),
            [createTextItem('overflow')],
        ]),
    });

    await assert.rejects(
        engine.extract(new Uint8Array([1])),
        /PDF text index exceeds the safety limit/
    );
    await engine.dispose();
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

test('matches Markdown LaTeX formulas against PDF math text', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem(
            'Raw Layer stores traces 𝜏𝑖 ∈ Ttrain,𝑘 collected from training.',
            { hasEOL: true }
        ),
    ]]);

    const selectedText = 'Raw Layer stores traces \\tau_{i} \\in '
        + 'T_{train,k} collected from training.';
    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.position.rects.length, 1);
    locator.dispose();
});

test('matches a spaced Markdown citation against attached PDF superscript text', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('studies', {
            width: 25,
            height: 9,
            transform: [9, 0, 0, 9, 72, 700],
        }),
        createTextItem('11–14', {
            width: 14,
            height: 5.85,
            transform: [5.85, 0, 0, 5.85, 97, 703.15],
        }),
        createTextItem(', result.', {
            width: 32,
            height: 9,
            transform: [9, 0, 0, 9, 111, 700],
        }),
    ]]);
    const selectedText = 'studies 11-14 , result.';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.position.rects.length, 3);
    locator.dispose();
});

test('keeps prose spacing before ordinary PDF numbers significant', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('lasted', {
            width: 30,
            height: 9,
            transform: [9, 0, 0, 9, 72, 700],
        }),
        createTextItem('35', {
            width: 10,
            height: 9,
            transform: [9, 0, 0, 9, 102, 700],
        }),
        createTextItem(' days.', {
            width: 28,
            height: 9,
            transform: [9, 0, 0, 9, 112, 700],
        }),
    ]]);

    await assert.rejects(
        locator.locate(42, 'lasted 35 days.', {
            pdfPageIndexHint: 0,
        }),
        error => error?.code === 'MKTERO_PDF_TEXT_NOT_FOUND'
    );
    locator.dispose();
});

test('does not infer citation spacing before ordinary PDF exponents', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('x', {
            width: 5,
            height: 9,
            transform: [9, 0, 0, 9, 72, 700],
        }),
        createTextItem('2 ', {
            width: 5,
            height: 5.85,
            transform: [5.85, 0, 0, 5.85, 77, 703.15],
        }),
        createTextItem(' result', {
            width: 32,
            height: 9,
            transform: [9, 0, 0, 9, 81, 700],
        }),
    ]]);

    await assert.rejects(
        locator.locate(42, 'x 2 result', { pdfPageIndexHint: 0 }),
        error => error?.code === 'MKTERO_PDF_TEXT_NOT_FOUND'
    );
    locator.dispose();
});

test('does not infer citation spacing for numeric PDF subscripts', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('studies', {
            width: 25,
            height: 9,
            transform: [9, 0, 0, 9, 72, 700],
        }),
        createTextItem('11–14', {
            width: 14,
            height: 5.85,
            transform: [5.85, 0, 0, 5.85, 97, 696.85],
        }),
    ]]);

    await assert.rejects(
        locator.locate(42, 'studies 11-14', { pdfPageIndexHint: 0 }),
        error => error?.code === 'MKTERO_PDF_TEXT_NOT_FOUND'
    );
    locator.dispose();
});

test('recovers spaces after attached PDF superscript citations', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('authors', {
            width: 30,
            height: 9,
            transform: [9, 0, 0, 9, 72, 700],
        }),
        createTextItem('16', {
            width: 8,
            height: 5.85,
            transform: [5.85, 0, 0, 5.85, 102, 703.15],
        }),
        createTextItem('state-space models', {
            width: 80,
            height: 9,
            transform: [9, 0, 0, 9, 110, 700],
        }),
    ]]);

    const located = await locator.locate(
        42,
        'authors 16 state-space models',
        { pdfPageIndexHint: 0 }
    );

    assert.equal(located.position.rects.length, 3);
    locator.dispose();
});

test('locates spaced PDF citations and a statistical exponent', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('Bortot at al. (2010)', {
            width: 90,
            height: 9,
            transform: [9, 0, 0, 9, 72, 700],
        }),
        createTextItem('16 ', {
            width: 9,
            height: 5.85,
            transform: [5.85, 0, 0, 5.85, 162, 703.15],
        }),
        createTextItem('while contradicting the results of', {
            width: 120,
            height: 9,
            transform: [9, 0, 0, 9, 171, 700],
        }),
        createTextItem('2 ', {
            width: 6,
            height: 5.85,
            transform: [5.85, 0, 0, 5.85, 291, 703.15],
        }),
        createTextItem('who report an R', {
            width: 60,
            height: 9,
            transform: [9, 0, 0, 9, 297, 700],
        }),
        createTextItem('2', {
            width: 4,
            height: 5.85,
            transform: [5.85, 0, 0, 5.85, 357, 703.15],
        }),
        createTextItem(' = 0.99.', {
            width: 36,
            height: 9,
            transform: [9, 0, 0, 9, 361, 700],
        }),
    ]]);
    const selectedText = 'Bortot at al. (2010) $^{16}$ while '
        + 'contradicting the results of $^{2}$ who report an '
        + 'R^{2}=0.99.';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.pageIndex, 0);
    locator.dispose();
});

test('locates a lexical hyphen split across a PDF line after a citation', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('According to these authors', {
            width: 96,
            height: 9,
            transform: [9, 0, 0, 9, 72, 700],
        }),
        createTextItem('16', {
            width: 8,
            height: 5.85,
            transform: [5.85, 0, 0, 5.85, 168, 703.15],
        }),
        createTextItem(', state-', {
            width: 32,
            height: 9,
            transform: [9, 0, 0, 9, 176, 700],
            hasEOL: true,
        }),
        createTextItem('space models under a Bayesian approach.', {
            width: 168,
            height: 9,
            transform: [9, 0, 0, 9, 72, 680],
        }),
    ]]);
    const selectedText = 'According to these authors 16 , state-space '
        + 'models under a Bayesian approach.';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.position.rects.length, 4);
    locator.dispose();
});

test('rejects ambiguous lexical hyphens split across PDF lines', async () => {
    const splitLine = () => [
        createTextItem('state-', { hasEOL: true }),
        createTextItem('space model', { y: 680 }),
    ];
    const locator = await createSyntheticLocator([
        splitLine(),
        splitLine(),
    ]);

    await assert.rejects(
        locator.locate(42, 'state-space model'),
        error => error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
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

test('locates a parenthesized LaTeX relation in the NExT passage', async () => {
    const pdfText = 'PA encompasses any body movement that results in energy '
        + 'expenditure (≥\u20091.5 MET).';
    const locator = await createSyntheticLocator([[
        createTextItem(pdfText),
    ]]);
    const selectedText = 'PA encompasses any body movement that results in '
        + 'energy expenditure ( \\geq 1.5 MET).';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.position.rects.length, 1);
    locator.dispose();
});

test('locates the NExT Lafer passage with Markdown percentages', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem(
            'The pilot trial conducted by Lafer et al. [84], examined the '
            + 'impact of 12 weeks, three times per week of exercise '
            + '(aerobics and strength exercises) interven-',
            { hasEOL: true }
        ),
        createTextItem(
            'tion on individuals with BD. The study involved 15 subjects '
            + 'with BD, utilized the Montgomery Åsberg Depression Rating '
            + 'Scale (MADRS), and demonstrated that 82% of participants '
            + 'exhibited an antidepressant response, characterized by a '
            + 'reduction exceeding 50% in depressive symptoms. Additionally, '
            + '45% of these patients met the criteria for complete remission. '
            + 'The baseline MADRS score observed was 23.6 ± 8.3 points, and '
            + 'post intervention, the score decreased to 10.2 ± 4.8 points.',
            { y: 680 }
        ),
    ]]);
    const selectedText = 'The pilot trial conducted by Lafer et al. [84], '
        + 'examined the impact of 12 weeks, three times per week of exercise '
        + '(aerobics and strength exercises) intervention on individuals '
        + 'with BD. The study involved 15 subjects with BD, utilized the '
        + 'Montgomery Åsberg Depression Rating Scale (MADRS), and demonstrated '
        + 'that 82\\% of participants exhibited an antidepressant response, '
        + 'characterized by a reduction exceeding 50\\% in depressive symptoms. '
        + 'Additionally, 45\\% of these patients met the criteria for complete '
        + 'remission. The baseline MADRS score observed was 23.6 \\pm 8.3 '
        + 'points, and post intervention, the score decreased to 10.2 \\pm '
        + '4.8 points.';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.rects.length, 2);
    locator.dispose();
});

test('locates the NExT psychosocial passage with mixed line-end hyphens', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem(
            'Evidence from other mental disorders indicates that PA can '
            + 'improve self-',
            { hasEOL: true }
        ),
        createTextItem(
            'esteem, reduce internalized stigma, and enhance self-efficacy, '
            + "defined as one's belief in one's own abilities to execute a "
            + 'task and achieve predetermined objec-',
            { y: 680, hasEOL: true }
        ),
        createTextItem(
            'tives [62, 116, 145] , such psychosocial outcomes may be '
            + 'particularly important for individuals with BD, who often '
            + 'face challenges of social isolation and diminished self-',
            { y: 660, hasEOL: true }
        ),
        createTextItem(
            'efficacy, both of which are negatively associated with lower '
            + 'PA participation',
            { y: 640 }
        ),
    ]]);
    const selectedText = 'Evidence from other mental disorders indicates '
        + 'that PA can improve self-esteem, reduce internalized stigma, and '
        + "enhance self-efficacy, defined as one's belief in one's own "
        + 'abilities to execute a task and achieve predetermined objectives '
        + '[62, 116, 145] , such psychosocial outcomes may be particularly '
        + 'important for individuals with BD, who often face challenges of '
        + 'social isolation and diminished self-efficacy, both of which are '
        + 'negatively associated with lower PA participation';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.rects.length, 4);
    locator.dispose();
});

test('locates the NExT neuroimaging passage with mixed line-end hyphens', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem(
            'In this study, neuroimaging findings revealed that before '
            + 'exercise, those with BD showed atypical patterns of activation '
            + 'and deactivation, particularly in the ventral prefrontal '
            + 'cortex, amygdala, hippocampus, and anterior cin-',
            { hasEOL: true }
        ),
        createTextItem(
            'gulate cortex, which correlated with depressive and manic '
            + 'symptoms. After exercise, these pre-',
            { y: 680, hasEOL: true }
        ),
        createTextItem(
            'exercise symptom–brain activation relationships were no longer '
            + 'evident, and task performance matched that of control subjects.',
            { y: 660 }
        ),
    ]]);
    const selectedText = 'In this study, neuroimaging findings revealed that '
        + 'before exercise, those with BD showed atypical patterns of '
        + 'activation and deactivation, particularly in the ventral '
        + 'prefrontal cortex, amygdala, hippocampus, and anterior cingulate '
        + 'cortex, which correlated with depressive and manic symptoms. '
        + 'After exercise, these pre-exercise symptom–brain activation '
        + 'relationships were no longer evident, and task performance '
        + 'matched that of control subjects.';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.rects.length, 3);
    locator.dispose();
});

test('resolves repeated line-end hyphen decisions per occurrence', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('pre-', { hasEOL: true }),
        createTextItem('exercise and pre-', { y: 680, hasEOL: true }),
        createTextItem('exercise', { y: 660 }),
    ]]);

    const located = await locator.locate(
        42,
        'pre-exercise and preexercise',
        { pdfPageIndexHint: 0 }
    );

    assert.equal(located.position.rects.length, 3);
    locator.dispose();
});

test('uses folded hyphen context to disambiguate mixed line endings', async () => {
    const target = 'pre-exercise and objectives';
    const firstPrefix = 'self-\nesteem context for first. ';
    const first = 'pre-\nexercise and objec-\ntives';
    const pageText = firstPrefix + first
        + '. Other context for second. '
        + first;
    const locator = await createSyntheticLocator([[
        createTextItem(pageText),
    ]]);
    const sourceOffset = pageText.indexOf(first, firstPrefix.length);

    const located = await locator.locate(42, target, {
        pdfPageIndexHint: 0,
        textQuote: {
            prefix: 'self-esteem context for first. ',
            suffix: '',
        },
    });

    assert.equal(
        located.sortIndex.split('|')[1],
        String(sourceOffset).padStart(6, '0')
    );
    locator.dispose();
});

test('keeps identical folded hyphen contexts ambiguous', async () => {
    const repeated = 'self-\nesteem context. '
        + 'pre-\nexercise and objec-\ntives.';
    const locator = await createSyntheticLocator([[
        createTextItem(`${repeated} ${repeated}`),
    ]]);

    await assert.rejects(
        locator.locate(42, 'pre-exercise and objectives', {
            pdfPageIndexHint: 0,
            textQuote: {
                prefix: 'self-esteem context. ',
                suffix: '.',
            },
        }),
        error => error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
    locator.dispose();
});

test('matches a LaTeX temperature threshold against a misencoded PDF degree', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem(
            'cycles with>=0.2\uFFFDC wrist temperature signal.'
        ),
    ]]);
    const selectedText = 'cycles with \\geq0.2^{\\circ}\\mathrm{C} wrist '
        + 'temperature signal.';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.pageIndex, 0);
    assert.equal(located.position.rects.length, 1);
    locator.dispose();
});

test('matches a long signed-number passage against a misencoded PDF glyph', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('If the labelled day falls within', {
            x: 72,
            width: 300,
        }),
        createTextItem(' ', { x: 372, width: 40, height: 0 }),
        createTextItem('2 days of the actual start, it is deemed accurate.', {
            x: 382,
            width: 400,
        }),
        createTextItem('§', { x: 374, width: 8, hasEOL: true }),
    ]]);
    const selectedText = 'If the labelled day falls within ±2 days of the '
        + 'actual start, it is deemed accurate.';

    const located = await locator.locate(42, selectedText, {
        pdfPageIndexHint: 0,
    });

    assert.equal(located.text, selectedText);
    assert.equal(located.position.pageIndex, 0);
    locator.dispose();
});

test('does not treat a short section reference as a plus-minus value', async () => {
    const locator = await createSyntheticLocator([[
        createTextItem('See §2 for details.'),
    ]]);

    await assert.rejects(
        locator.locate(42, '±2', { pdfPageIndexHint: 0 }),
        error => error?.code === 'MKTERO_PDF_TEXT_NOT_FOUND'
    );
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
            return createSyntheticPDFDocument(pageItems);
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

function createSyntheticPDFDocument(pageItems) {
    return {
        promise: Promise.resolve({
            numPages: pageItems.length,
            async getPageLabels() {
                return pageItems.map((_items, index) => String(index + 1));
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
