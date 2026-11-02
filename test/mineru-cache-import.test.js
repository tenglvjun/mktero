import test from 'node:test';
import assert from 'node:assert/strict';
import { MinerUCacheImportService, validateImportedFigureCoverage } from '../src/core/mineru-cache-import.js';
import { LLMCacheError } from '../src/mineru/llm-cache-bundle.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { collectFigureImageNodes } from '../src/figures/figure-model.js';
import { sha256Hex } from '../src/core/sha256.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const encode = value => new TextEncoder().encode(value);
const fileData = encode('synthetic PDF');
const content = 'A synthetic article with a useful source location.';
const textBlock = { type: 'text', text: content, page_idx: 0, bbox: [10, 10, 900, 100] };
const entries = [
    { path: 'full.md', data: encode(content) },
    { path: 'content_list.json', data: encode(JSON.stringify([textBlock])) },
];
const document = { markdown: content, sourceMap: [{ type: 'text', markdownFrom: 0,
    markdownTo: content.length, locations: [{ pageIndex: 0, bbox: [10, 10, 900, 100] }] }], assets: [] };

function fixture(overrides = {}) {
    const events = [];
    let raw;
    let derived;
    let selection;
    const attachment = { id: 1, key: 'PDFKEY', libraryID: 1,
        isPDFAttachment: () => true, getFilePathAsync: async () => '/local.pdf',
        getDisplayTitle: () => 'Synthetic paper' };
    const options = {
        zotero: { Items: { getAsync: async () => attachment } },
        source: { capture: async () => ({ entries, sourceRoot: '/source' }),
            verify: async () => { events.push('verify'); } },
        index: { publish: async record => { events.push('publish'); selection = record; return record; } },
        cache: { put: async (_key, result) => { events.push('derived'); derived = result; },
            get: async () => derived },
        resultStore: { put: async (_key, record) => { events.push('raw'); raw = record; }, get: async () => raw },
        readFile: async () => fileData,
        countPages: async () => 1,
        isCacheEnabled: () => true,
        prepareResult: async () => document,
        confirm: async () => true,
        ...overrides,
    };
    return { events, options, attachment, service: new MinerUCacheImportService(options),
        get selection() { return selection; } };
}

function figureEntries(includeAsset = true) {
    return [entries[0],
        { path: 'content_list.json', data: encode(JSON.stringify([textBlock,
            { type: 'image', page_idx: 0, bbox: [100, 200, 800, 600], img_path: 'images/figure.png' },
        ])) },
        ...(includeAsset ? [{ path: 'images/figure.png', data: createTestPNG() }] : []),
    ];
}

function layoutEntries() {
    const line = (bbox, span) => ({ bbox, spans: [{ bbox, ...span }] });
    const bbox = [100, 200, 800, 600];
    return [entries[0], { path: 'layout.json', data: encode(JSON.stringify({ pdf_info: [{
        page_idx: 0, page_size: [1000, 1000], discarded_blocks: [], para_blocks: [
            { type: 'text', bbox: textBlock.bbox, lines: [line(textBlock.bbox, { type: 'text', content })] },
            { type: 'image', bbox, blocks: [
                { type: 'image_body', bbox, lines: [line(bbox, { type: 'image', image_path: 'images/figure.png' })] },
                { type: 'image_caption', bbox: [100, 610, 800, 650], lines: [line([100, 610, 800, 650],
                    { type: 'text', content: 'Figure 1. Synthetic result.' })] },
            ] },
        ],
    }] })) }, { path: 'images/figure.png', data: createTestPNG() }];
}

async function prepareRealFigures(raw, context) {
    const input = createMinerUFigureInput(raw);
    assert.deepEqual(input.contentList, []);
    const restoration = new FigureRestorationService({ hash: sha256Hex, openPDF: async () => ({
        getPageGeometry: async pageIndex => ({ pageIndex, width: 1000, height: 1000, rotation: 0,
            userUnit: 1, coordinateFrame: 'display-cropbox', viewBox: [0, 0, 1000, 1000],
            mediaBox: null, viewportTransform: [1, 0, 0, -1, 0, 1000] }),
        renderRegion: async () => ({ data: createTestPNG(), width: 8, height: 8, mimeType: 'image/png' }),
        close: async () => {},
    }) });
    const draft = await restoration.restore(input, context);
    return finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash: sha256Hex });
}

test('figure coverage follows original assets through composed figures rather than counts', () => {
    const input = { coverage: [
        { required: true, path: 'images/panel-a.png' },
        { required: true, path: 'images/panel-b.png' },
        { required: true, path: 'images/panel-a.png' },
        { required: false, path: 'images/table-preview.png' },
    ] };
    assert.throws(() => validateImportedFigureCoverage(input, {
        markdown: '![](images/unrelated.png)\n\n![](images/another.png)',
    }), { code: 'LLM_CACHE_MISSING_IMAGE' });
    assert.doesNotThrow(() => validateImportedFigureCoverage(input, {
        markdown: '![](images/composed.png)',
        figureMap: { figures: [{ render: { assetPath: 'images/composed.png' }, panels: [
            { originalAssetPath: 'images/panel-a.png' }, { originalAssetPath: 'images/panel-b.png' },
        ] }] },
    }));
    assert.throws(() => validateImportedFigureCoverage(input, {
        markdown: '![](images/unrelated.png)',
        figureMap: { figures: [{ render: { assetPath: 'images/composed.png' }, panels: [
            { originalAssetPath: 'images/panel-a.png' }, { originalAssetPath: 'images/panel-b.png' },
        ] }] },
    }), { code: 'LLM_CACHE_MISSING_IMAGE' });
    assert.throws(() => validateImportedFigureCoverage(input, {
        markdown: '![](images/composed.png)',
        figureMap: { figures: [
            { render: { assetPath: 'images/composed.png' }, panels: [{ originalAssetPath: 'images/panel-a.png' }] },
            { render: { assetPath: 'images/panel-a.png' }, panels: [{ originalAssetPath: 'images/panel-b.png' }] },
        ] },
    }), { code: 'LLM_CACHE_MISSING_IMAGE' });
});

test('publishes a self-contained local import only after both stores are readable', async () => {
    const f = fixture();
    const result = await f.service.importConfirmed(1);
    assert.equal(result.provider, 'llm-for-zotero');
    assert.equal(result.markdown, content);
    assert.deepEqual(f.events, ['verify', 'raw', 'derived', 'verify', 'publish']);
    assert.match(result.cacheKey, /^[a-f0-9]{64}$/);
});

test('rejecting confirmation does not write either store or publish a selection', async () => {
    const f = fixture({ confirm: async () => false });
    await assert.rejects(f.service.importConfirmed(1), { name: 'AbortError' });
    assert.deepEqual(f.events, []);
});

test('cancellation during local processing never publishes a selection', async () => {
    const controller = new AbortController();
    const f = fixture({ prepareResult: async () => { controller.abort(); return document; } });
    await assert.rejects(f.service.importConfirmed(1, { signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(f.events, []);
});

test('ordinary local adapter errors retain their cause and cannot publish', async t => {
    const adapters = [
        ['cache preference', f => f.service, 'isCacheEnabled'],
        ['attachment lookup', f => f.options.zotero.Items, 'getAsync'],
        ['PDF path', f => f.attachment, 'getFilePathAsync'],
        ['PDF read', f => f.service, 'readFile'],
        ['PDF hash', f => f.service, 'hash'],
        ['source capture', f => f.options.source, 'capture'],
        ['PDF page count', f => f.service, 'countPages'],
        ['source inspection', f => f.service, 'inspect'],
        ['confirmation', f => f.service, 'confirm'],
        ['asset adaptation', f => f.service, 'adaptAssets'],
        ['document preparation', f => f.service, 'prepareResult'],
        ['figure recovery', f => f.service, 'recoverFigures'],
        ['source verification', f => f.options.source, 'verify'],
        ['raw result write', f => f.options.resultStore, 'put'],
        ['derived result write', f => f.options.cache, 'put'],
        ['raw result read', f => f.options.resultStore, 'get'],
        ['derived result read', f => f.options.cache, 'get'],
        ['selection write', f => f.options.index, 'publish'],
    ];
    for (const [name, target, method] of adapters) {
        await t.test(name, async () => {
            const cause = Object.assign(new Error('local adapter failed'), { code: 'EIO' });
            const f = fixture();
            target(f)[method] = () => { throw cause; };
            await assert.rejects(f.service.importConfirmed(1), error => {
                assert.ok(error instanceof LLMCacheError);
                assert.equal(error.code, 'LLM_CACHE_IMPORT_FAILED');
                assert.equal(error.cause, cause);
                return true;
            });
            assert.equal(f.events.includes('publish'), false);
        });
    }
});

test('ordinary image decoder and local PDF renderer errors remain local import failures', async t => {
    for (const adapter of ['decodeImage', 'openPDF']) {
        await t.test(adapter, async () => {
            const cause = new Error('local image I/O failed');
            const f = fixture({ [adapter]: async () => { throw cause; } });
            f.options.source.capture = async () => ({ entries: figureEntries(adapter === 'decodeImage') });
            await assert.rejects(f.service.importConfirmed(1), error => {
                assert.ok(error instanceof LLMCacheError);
                assert.equal(error.code, 'LLM_CACHE_IMPORT_FAILED');
                assert.equal(error.cause, cause);
                return true;
            });
            assert.deepEqual(f.events, []);
        });
    }
});

test('publication-time PDF reads and preference failures remain local import failures', async t => {
    for (const adapter of ['readFile', 'isCacheEnabled']) {
        await t.test(adapter, async () => {
            const cause = new Error('local recheck failed');
            const f = fixture();
            const original = f.service[adapter];
            let calls = 0;
            f.service[adapter] = (...args) => {
                if (++calls === 2) throw cause;
                return original(...args);
            };
            await assert.rejects(f.service.importConfirmed(1), error => {
                assert.ok(error instanceof LLMCacheError);
                assert.equal(error.code, 'LLM_CACHE_IMPORT_FAILED');
                assert.equal(error.cause, cause);
                return true;
            });
            assert.equal(f.events.includes('publish'), false);
        });
    }
});

test('disk-full writes and source changes preserve the previous selection and allow another import', async t => {
    for (const [name, store, method] of [
        ['raw write', 'resultStore', 'put'],
        ['derived write', 'cache', 'put'],
        ['source change', 'source', 'verify'],
    ]) {
        await t.test(name, async () => {
            const f = fixture();
            await f.service.importConfirmed(1);
            const previous = f.selection;
            f.events.length = 0;
            f.options.source.capture = async () => ({ entries: [
                { path: 'full.md', data: encode(`${content}\n\nNew local snapshot.`) }, entries[1],
            ] });
            const cause = new Error(store === 'source' ? 'source changed' : 'disk full');
            const original = f.options[store][method];
            f.options[store][method] = async () => { throw cause; };
            await assert.rejects(f.service.importConfirmed(1), error => {
                assert.ok(error instanceof LLMCacheError);
                assert.equal(error.code, 'LLM_CACHE_IMPORT_FAILED');
                assert.equal(error.cause, cause);
                return true;
            });
            assert.equal(f.events.includes('publish'), false);
            assert.equal(f.selection, previous);
            f.options[store][method] = original;
            await f.service.importConfirmed(1);
            assert.notEqual(f.selection.snapshotHash, previous.snapshotHash);
        });
    }
});

test('existing local error codes and cancellation reasons are propagated unchanged', async t => {
    const failures = [
        new LLMCacheError('LLM_CACHE_WRITING', 'Source cache is still being written'),
        Object.assign(new Error('Index write failed'), { code: 'LLM_CACHE_IMPORT_INDEX_WRITE_FAILED' }),
        Object.assign(new Error('Import cancelled'), { name: 'AbortError' }),
    ];
    for (const original of failures) {
        await t.test(original.code || original.name, async () => {
            const f = fixture();
            f.options.source.capture = async () => { throw original; };
            await assert.rejects(f.service.importConfirmed(1), error => error === original);
            assert.deepEqual(f.events, []);
        });
    }
    await t.test('custom signal cancellation reason', async () => {
        const controller = new AbortController();
        const reason = new Error('Owner closed');
        const f = fixture({ prepareResult: async () => { controller.abort(reason); return document; } });
        await assert.rejects(f.service.importConfirmed(1, { signal: controller.signal }), error => error === reason);
        assert.deepEqual(f.events, []);
    });
});

test('figures lost during preparation or final recovery cannot publish', async t => {
    for (const stage of ['prepareResult', 'recoverFigures']) {
        await t.test(stage, async () => {
            const f = fixture({
                prepareResult: async raw => ({ ...document,
                    markdown: `${content}\n\n![](images/figure.png)`, assets: raw.assets }),
                [stage]: async () => document,
            });
            f.options.source.capture = async () => ({ entries: figureEntries() });
            await assert.rejects(f.service.importConfirmed(1), { code: 'LLM_CACHE_MISSING_IMAGE' });
            assert.deepEqual(f.events, []);
        });
    }
});

test('final figure coverage accepts retained input figures', async () => {
    const f = fixture({ prepareResult: async raw => ({ ...document,
        markdown: `${content}\n\n![](images/figure.png)`, assets: raw.assets }) });
    f.options.source.capture = async () => ({ entries: figureEntries() });
    const result = await f.service.importConfirmed(1);
    assert.match(result.markdown, /!\[\]\(images\/figure\.png\)/u);
    assert.equal(result.assets[0].path, 'images/figure.png');
    assert.equal(f.events.at(-1), 'publish');
});

test('real figure preparation cannot lose layout-only or image-only table inputs before publication', async t => {
    const tableEntries = figureEntries();
    tableEntries[1] = { path: 'content_list.json', data: encode(JSON.stringify([textBlock,
        { type: 'table', page_idx: 0, bbox: [100, 200, 800, 600], img_path: 'images/figure.png' },
    ])) };
    for (const [name, sourceEntries] of [['content-list', figureEntries()], ['layout-only', layoutEntries()],
        ['image-only table', tableEntries]]) {
        for (const stage of ['prepareResult', 'recoverFigures']) {
            await t.test(`${name}: ${stage}`, async () => {
                const f = fixture({ prepareResult: prepareRealFigures });
                await f.service.importConfirmed(1);
                const previous = f.selection;
                f.events.length = 0;
                f.options.source.capture = async () => ({ entries: sourceEntries });
                const dropImages = result => ({ ...result, markdown: content, sourceMap: document.sourceMap });
                if (stage === 'prepareResult') {
                    f.service.prepareResult = async (raw, context) => dropImages(await prepareRealFigures(raw, context));
                }
                else f.service.recoverFigures = async result => dropImages(result);
                await assert.rejects(f.service.importConfirmed(1), { code: 'LLM_CACHE_MISSING_IMAGE' });
                assert.deepEqual(f.events, []);
                assert.equal(f.selection, previous);
            });
        }
    }
});

test('real standalone import pipeline retains content-list and layout-only figures', async t => {
    for (const [name, sourceEntries] of [['content-list', figureEntries()], ['layout-only', layoutEntries()]]) {
        await t.test(name, async () => {
            const f = fixture({ prepareResult: prepareRealFigures });
            f.options.source.capture = async () => ({ entries: sourceEntries });
            const result = await f.service.importConfirmed(1);
            assert.ok(collectFigureImageNodes(result.markdown).length > 0);
            assert.equal(result.documentStructure, 'mineru-ir-v1');
            if (name === 'layout-only') {
                assert.ok(result.figureMap.figures.some(figure => figure.panels.some(panel => (
                    panel.originalAssetPath === 'images/figure.png'
                ))));
            }
            assert.equal(f.events.at(-1), 'publish');
        });
    }
});

test('real standalone import permits redundant textual previews and shared panel assets', async t => {
    const table = { type: 'table', page_idx: 0, bbox: [100, 200, 800, 400],
        table_body: '<table><tr><td>Value</td></tr></table>', img_path: 'images/table.png' };
    const equation = { type: 'equation', page_idx: 0, bbox: [100, 500, 800, 600],
        text: 'E=mc^2', img_path: 'images/equation.png' };
    const textPreviewEntries = [entries[0],
        { path: 'content_list.json', data: encode(JSON.stringify([textBlock, table, equation])) },
        { path: 'images/table.png', data: createTestPNG() },
        { path: 'images/equation.png', data: createTestPNG() },
    ];
    const layoutPreviewEntries = layoutEntries();
    const layout = JSON.parse(new TextDecoder().decode(layoutPreviewEntries[1].data));
    layout.pdf_info[0].para_blocks.splice(1, 1,
        { type: 'table', bbox: table.bbox, blocks: [{ type: 'table_body', bbox: table.bbox,
            lines: [{ spans: [{ type: 'table', html: table.table_body, image_path: table.img_path }] }] }] },
        { type: 'interline_equation', bbox: equation.bbox,
            lines: [{ spans: [{ type: 'interline_equation', content: equation.text, image_path: equation.img_path }] }] },
        { type: 'header', bbox: [10, 0, 900, 9], lines: [{ spans: [{ type: 'image', image_path: 'images/figure.png' }] }] });
    layoutPreviewEntries[1] = { path: 'layout.json', data: encode(JSON.stringify(layout)) };
    layoutPreviewEntries.push(...textPreviewEntries.slice(2));
    for (const [name, sourceEntries] of [['content-list', textPreviewEntries], ['layout', layoutPreviewEntries]]) {
        await t.test(`${name}: textual equivalents`, async () => {
            const f = fixture({ prepareResult: prepareRealFigures });
            f.options.source.capture = async () => ({ entries: sourceEntries });
            const result = await f.service.importConfirmed(1);
            assert.equal(collectFigureImageNodes(result.markdown).length, 0);
            assert.match(result.markdown, /<table>/u);
            assert.match(result.markdown, /E=mc\^2/u);
            assert.equal(f.events.at(-1), 'publish');
        });
    }
    await t.test('shared asset across panels', async () => {
        const sourceEntries = figureEntries();
        const blocks = JSON.parse(new TextDecoder().decode(sourceEntries[1].data));
        blocks.push({ ...blocks[1], bbox: [100, 650, 800, 950] });
        sourceEntries[1] = { path: 'content_list.json', data: encode(JSON.stringify(blocks)) };
        const f = fixture({ prepareResult: prepareRealFigures });
        f.options.source.capture = async () => ({ entries: sourceEntries });
        const result = await f.service.importConfirmed(1);
        assert.equal(result.assets.length, 1);
        assert.equal(collectFigureImageNodes(result.markdown).length, 2);
        assert.equal(f.events.at(-1), 'publish');
    });
});

test('a readable cache copy that loses a required figure cannot replace the previous selection', async () => {
    const f = fixture({ prepareResult: prepareRealFigures });
    await f.service.importConfirmed(1);
    const previous = f.selection;
    f.events.length = 0;
    f.options.source.capture = async () => ({ entries: layoutEntries() });
    f.options.cache.get = async () => document;
    await assert.rejects(f.service.importConfirmed(1), { code: 'LLM_CACHE_MISSING_IMAGE' });
    assert.equal(f.events.includes('publish'), false);
    assert.equal(f.selection, previous);
});

test('PDF replacement before publication is rejected', async () => {
    let reads = 0;
    const f = fixture({ readFile: async () => ++reads === 1 ? fileData : encode('new PDF') });
    await assert.rejects(f.service.importConfirmed(1), { code: 'LLM_CACHE_CHANGED' });
    assert.equal(f.events.includes('publish'), false);
});

test('disabled caches and invalid final image references cannot publish', async () => {
    const disabled = fixture({ isCacheEnabled: () => false });
    await assert.rejects(disabled.service.importConfirmed(1), { code: 'LLM_CACHE_DISABLED' });
    const broken = fixture({ prepareResult: async () => ({ ...document, markdown: `${content}\n\n![](images/missing.png)` }) });
    await assert.rejects(broken.service.importConfirmed(1), { code: 'LLM_CACHE_MISSING_IMAGE' });
    assert.deepEqual(disabled.events, []);
    assert.deepEqual(broken.events, []);
});
