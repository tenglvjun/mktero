import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'fflate';
import { inspectLLMCacheEntries } from '../src/mineru/llm-cache-bundle.js';
import { adaptLLMCacheAssets, llmCropManifestHash } from '../src/mineru/llm-cache-assets.js';
import { extractMinerUResultFromZip } from '../src/mineru/zip-markdown.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const attachment = { id: 7, key: 'PDFKEY77', libraryID: 1 };
const text = 'A synthetic paper body with enough text to verify source positions.';
const body = { type: 'text', text, page_idx: 0, bbox: [10, 10, 900, 100] };
const image = { type: 'image', page_idx: 0, bbox: [100, 200, 800, 600],
    img_path: 'images/fig1.png', image_caption: ['Figure 1. Synthetic figure.'] };
const enc = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const entry = (path, value) => ({ path, data: value instanceof Uint8Array ? value : enc(value) });
const code = expected => error => error.code === expected;
const options = { yieldToUI: async () => {} };

function fixture({ blocks = [body, image], files = [], cropEntries, source = {}, manifest: extraManifest = {} } = {}) {
    const group = { blockId: 'figure-block-1', kind: 'figure', imagePaths: ['images/fig1.png'],
        labelHints: ['Figure 1'], captionHints: ['Figure 1. Synthetic figure.'], ambiguous: false };
    const manifest = { totalPages: 1, totalChars: text.length, figureBlocks: [group],
        allFigures: [{ label: 'Figure 1', baseLabel: 'Figure 1', path: 'images/fig1.png',
            caption: 'Figure 1. Synthetic figure.' }], ...extraManifest };
    const crop = { id: 'fig1', label: 'Figure 1', baseLabel: 'Figure 1', pageNumber: 1,
        cropPath: 'figure_crops/crops/fig1.png', rect: { left: 10, top: 10, width: 300, height: 200 },
        mineruImagePaths: [] };
    const geometry = { version: 2, algorithmVersion: 14, attachmentId: 7,
        manifestHash: llmCropManifestHash(manifest), pdfFingerprint: 'display-metadata-only',
        entries: cropEntries || [crop], missingFigures: [] };
    const entries = [entry('full.md', text), entry('content_list.json', blocks),
        entry('manifest.json', manifest), entry('_llm_source.json', {
            kind: 'llm-for-zotero/mineru-cache-source', version: 2, attachmentId: 7,
            attachmentKey: 'PDFKEY77', origin: 'parsed', ...source,
        }), entry('figure_crops/figure_geometry.json', geometry), ...files];
    const input = inspectLLMCacheEntries(entries, { attachment, pdfPageCount: 1, sourceRoot: '/cache/7' });
    return { input, geometry, manifest, crop };
}

function renderer({ rotation = 0, mediaBox = [0, 0, 600, 800], controller } = {}) {
    const calls = [];
    let closed = 0;
    return { calls, get closed() { return closed; },
        async openPDF() {
            return {
                async getPageGeometry(pageIndex) {
                    return { pageIndex, width: 600, height: 800, rotation, userUnit: 1,
                        coordinateFrame: 'display-cropbox', viewBox: [0, 0, 600, 800], mediaBox };
                },
                async renderRegion(request) {
                    calls.push(request);
                    controller?.abort();
                    return { data: createTestPNG(), width: 8, height: 8, mimeType: 'image/png' };
                },
                async close() { closed++; },
            };
        },
    };
}

test('preserves original images even if the Markdown has stripped its image embeds', async () => {
    const { input } = fixture({ files: [entry('images/fig1.png', createTestPNG())] });
    const adapted = await adaptLLMCacheAssets(input, options);
    assert.equal(adapted.counts.preserved, 1);
    assert.ok(adapted.entries.some(file => file.path === 'images/fig1.png'));
    const result = extractMinerUResultFromZip(zipSync(Object.fromEntries(adapted.entries.map(file => [file.path, file.data]))));
    assert.equal(result.contentList[1].assetPath, 'images/fig1.png');
    assert.equal(result.assets.length, 1);
    assert.ok(!adapted.entries.some(file => /manifest|source|geometry/u.test(file.path)));
});

test('imports a validated crop by manifest label/page when mineruImagePaths is empty', async () => {
    const { input } = fixture({ files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
    const adapted = await adaptLLMCacheAssets(input, options);
    assert.equal(adapted.counts.importedCrops, 1);
    assert.equal(adapted.contentList[1].img_path, 'images/imported-crop-0.png');
    assert.deepEqual(adapted.contentList[1].bbox, image.bbox);
    assert.equal(adapted.coverage[0].pageIndex, 0);
});

test('maps current-root absolute paths and restored Windows paths by their complete safe suffix', async () => {
    for (const [cropPath, origin] of [['/cache/7/figure_crops/crops/fig1.png', 'parsed'],
        ['C:\\Old\\7\\figure_crops\\crops\\fig1.png', 'restored']]) {
        const f = fixture({ source: { origin }, files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
        f.input.geometry.entries[0].cropPath = cropPath;
        if (origin === 'restored') f.input.geometry.attachmentId = 888;
        assert.equal((await adaptLLMCacheAssets(f.input, options)).counts.importedCrops, 1);
    }
});

test('never reads arbitrary crop paths or falls back to basename matching', async () => {
    for (const path of ['/other/figure.png', 'https://example.test/figure.png', '../figure.png',
        '/cache/7/figure_crops/../fig1.png', 'file:///cache/7/figure_crops/crops/fig1.png']) {
        const f = fixture({ files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
        f.input.geometry.entries[0].cropPath = path;
        await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_UNSAFE_PATH'));
    }
    const f = fixture({ files: [entry('figure_crops/crops/another/fig1.png', createTestPNG())] });
    await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_MISSING_IMAGE'));
});

test('does not conflate Figure 1, supplementary Figure S1, panels, tables or different pages', async () => {
    for (const label of ['Figure S1', 'Supplementary Figure 1', 'Figure 1a', 'Table 1']) {
        const f = fixture({ files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
        f.input.geometry.entries[0].label = label;
        await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_MISSING_IMAGE'));
    }
    const f = fixture({ files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
    f.input.geometry.entries[0].pageNumber = 2;
    await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_INVALID_CROP'));
});

test('deduplicates adjacent manifest-confirmed panels covered by one complete figure crop', async () => {
    const second = { ...image, img_path: 'images/panel-b.png', bbox: [100, 610, 800, 900], image_caption: [] };
    const f = fixture({ blocks: [body, image, second], files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
    f.input.manifest.figureBlocks[0].imagePaths.push('images/panel-b.png');
    f.input.geometry.manifestHash = llmCropManifestHash(f.input.manifest);
    const result = await adaptLLMCacheAssets(f.input, options);
    assert.equal(result.contentList.length, 2);
    assert.equal(result.counts.importedCrops, 1);
    assert.deepEqual(result.contentList[1].bbox, [100, 200, 800, 900]);
    assert.equal(result.coverage.filter(entry => entry.method === 'imported-crop').length, 2);
});

test('does not merge image panels across intervening prose or ambiguous many-to-many crops', async () => {
    const second = { ...image, img_path: 'images/panel-b.png' };
    const f = fixture({ blocks: [body, image, body, second], files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
    f.input.manifest.figureBlocks[0].imagePaths.push('images/panel-b.png');
    f.input.geometry.manifestHash = llmCropManifestHash(f.input.manifest);
    await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_MISSING_IMAGE'));
    const ambiguous = fixture({ files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
    ambiguous.input.geometry.entries.push({ ...ambiguous.input.geometry.entries[0], id: 'duplicate' });
    await assert.rejects(adaptLLMCacheAssets(ambiguous.input, options), code('LLM_CACHE_AMBIGUOUS_FIGURE'));
});

test('treats real table HTML as equivalent but does not discard a figure classified as a table', async () => {
    const table = { ...image, type: 'table', img_path: 'images/table.png',
        table_body: '<table><tr><td>Value</td></tr></table>', table_caption: ['Table 1. Values.'] };
    const f = fixture({ blocks: [body, table] });
    const result = await adaptLLMCacheAssets(f.input, options);
    assert.equal(result.counts.equivalent, 1);
    assert.equal(result.contentList[1].img_path, undefined);
    f.input.contentList[1].table_caption = ['Figure 1. Forest plot.'];
    await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_MISSING_IMAGE'));
});

test('locally restores missing original blocks using unchanged normalized coordinates and closes the PDF', async () => {
    const f = fixture();
    const r = renderer();
    const result = await adaptLLMCacheAssets(f.input, { ...options, openPDF: r.openPDF, fileData: Uint8Array.of(1) });
    assert.equal(result.counts.localCrops, 1);
    assert.deepEqual(r.calls[0].bbox, image.bbox);
    assert.equal(r.calls[0].coordinateFrame, 'display-cropbox');
    assert.equal(r.closed, 1);
});

test('refuses uncertain rotated or cropped page geometry instead of fabricating coordinates', async () => {
    for (const config of [{ rotation: 90 }, { mediaBox: [0, 0, 700, 900] }]) {
        const f = fixture();
        const r = renderer(config);
        await assert.rejects(adaptLLMCacheAssets(f.input, { ...options,
            openPDF: r.openPDF, fileData: Uint8Array.of(1) }), code('LLM_CACHE_UNSUPPORTED_GEOMETRY'));
        assert.equal(r.calls.length, 0);
        assert.equal(r.closed, 1);
    }
});

test('rejects stale/unknown crop algorithms, invalid image bytes and cancellation', async () => {
    for (const change of [geometry => geometry.algorithmVersion++, geometry => geometry.manifestHash = 'stale']) {
        const f = fixture({ files: [entry('figure_crops/crops/fig1.png', createTestPNG())] });
        change(f.input.geometry);
        await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_MISSING_IMAGE'));
    }
    const invalid = fixture({ files: [entry('figure_crops/crops/fig1.png', new Uint8Array(32))] });
    await assert.rejects(adaptLLMCacheAssets(invalid.input, options), code('LLM_CACHE_INVALID_IMAGE'));
    const controller = new AbortController();
    const r = renderer({ controller });
    const f = fixture();
    await assert.rejects(adaptLLMCacheAssets(f.input, { ...options, fileData: Uint8Array.of(1),
        openPDF: r.openPDF, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(r.closed, 1);
});

test('enforces output budgets and rejects unresolved remote Markdown images', async () => {
    const f = fixture({ files: [entry('images/fig1.png', createTestPNG())] });
    await assert.rejects(adaptLLMCacheAssets(f.input, { ...options, limits: { maxTotalBytes: 1 } }), code('LLM_CACHE_RESOURCE_LIMIT'));
    f.input.markdown += '\n![remote](https://example.test/private.png)';
    await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_UNSAFE_PATH'));
});

test('records layout-only image coverage and preserves the resource filename extension', async () => {
    const layout = { pdf_info: [{ page_idx: 0, page_size: [600, 800], discarded_blocks: [], para_blocks: [
        { type: 'text', bbox: [10, 10, 500, 100], lines: [{ bbox: [10, 10, 500, 100],
            spans: [{ type: 'text', content: text }] }] },
        { type: 'image', bbox: [100, 200, 500, 600], blocks: [{ type: 'image_body',
            bbox: [100, 200, 500, 600], lines: [{ bbox: [100, 200, 500, 600],
                spans: [{ type: 'image', image_path: 'images/source.png' }] }] }] },
    ] }] };
    const input = inspectLLMCacheEntries([entry('full.md', text), entry('layout.json', layout),
        entry('images/source.png', createTestPNG())], { attachment, pdfPageCount: 1 });
    const adapted = await adaptLLMCacheAssets(input, options);
    assert.deepEqual(adapted.coverage, [{ layoutPath: 'images/source.png', pageIndex: 0,
        type: 'image', required: true, method: 'preserved', path: 'images/source.png' }]);
    assert.equal(adapted.counts.preserved, 1);
    assert.ok(adapted.entries.some(file => file.path === 'images/source.png'));
    input.files.delete('images/source.png');
    await assert.rejects(adaptLLMCacheAssets(input, options), code('LLM_CACHE_MISSING_IMAGE'));
});

function layoutInput(blocks, files = [], contentBlocks = []) {
    const layout = { pdf_info: [{ page_idx: 0, page_size: [1000, 1000], discarded_blocks: [], para_blocks: [
        { type: 'text', bbox: body.bbox, lines: [{ bbox: body.bbox, spans: [{ type: 'text', content: text }] }] },
        ...blocks,
    ] }] };
    return inspectLLMCacheEntries([entry('full.md', text), entry('layout.json', layout),
        ...(contentBlocks.length ? [entry('content_list.json', contentBlocks)] : []), ...files],
    { attachment, pdfPageCount: 1 });
}

function layoutBlock(type, path, { html, content, caption } = {}) {
    const bbox = image.bbox;
    return { type, bbox, blocks: [
        { type: `${type}_body`, bbox, lines: [{ bbox, spans: [{ type: type === 'table' ? 'table' : 'image',
            image_path: path, ...(html ? { html } : {}), ...(content ? { content } : {}) }] }] },
        ...(caption ? [{ type: `${type}_caption`, bbox: [100, 610, 800, 650],
            lines: [{ spans: [{ type: 'text', content: caption }] }] }] : []),
    ] };
}

test('marks only proven table and equation previews as optional in content coverage', async () => {
    const blocks = [body, image, { ...image, type: 'chart', img_path: 'images/chart.png' },
        { ...image, type: 'table', img_path: 'images/table.png', table_caption: ['Table 1'],
            table_body: '<table><tr><td>Value</td></tr></table>' },
        { ...image, type: 'table', img_path: 'images/plot.png', table_caption: ['Figure 2'],
            table_body: '<table><tr><td>Study</td></tr></table>' },
        { ...image, type: 'table', img_path: 'images/table-only.png' },
        { ...image, type: 'equation', img_path: 'images/equation.png', text: 'E=mc^2' },
        { ...image, type: 'equation', img_path: 'images/equation-only.png' },
    ];
    const f = fixture({ blocks, files: blocks.slice(1).map(block => entry(block.img_path, createTestPNG())) });
    const result = await adaptLLMCacheAssets(f.input, options);
    assert.deepEqual(result.coverage.map(record => [record.type, record.required]), [
        ['image', true], ['chart', true], ['table', false], ['table', true], ['table', true],
        ['equation', false], ['equation', true],
    ]);
});

test('layout coverage separates figures from textual previews and page chrome', async () => {
    const blocks = [layoutBlock('image', 'images/figure.png'), layoutBlock('chart', 'images/chart.png',
        { html: '<table><tr><td>Chart data</td></tr></table>' }),
    layoutBlock('table', 'images/table.png', { html: '<table><tr><td>Value</td></tr></table>', caption: 'Table 1' }),
    layoutBlock('table', 'images/plot.png', { html: '<table><tr><td>Study</td></tr></table>', caption: 'Figure 2' }),
    { type: 'interline_equation', bbox: image.bbox, lines: [{ spans: [
        { type: 'interline_equation', content: 'E=mc^2', image_path: 'images/equation.png' },
    ] }] }, layoutBlock('header', 'images/logo.png')];
    const files = ['figure', 'chart', 'table', 'plot', 'equation', 'logo'].map(name => entry(`images/${name}.png`, createTestPNG()));
    const adapted = await adaptLLMCacheAssets(layoutInput(blocks, files), options);
    assert.deepEqual(adapted.coverage.map(record => [record.path, record.type, record.required]), [
        ['images/figure.png', 'image', true], ['images/chart.png', 'chart', true],
        ['images/table.png', 'table', false], ['images/plot.png', 'table', true],
        ['images/equation.png', 'equation', false], ['images/logo.png', 'header', false],
    ]);
});

test('layout may omit equivalent previews but never an image-only table or equation', async () => {
    const equivalent = [layoutBlock('table', 'images/table.png',
        { html: '<table><tr><td>Value</td></tr></table>' }),
    { type: 'interline_equation', bbox: image.bbox, lines: [{ spans: [
        { type: 'interline_equation', content: 'x^2', image_path: 'images/equation.png' },
    ] }] }, layoutBlock('header', 'images/logo.png')];
    const result = await adaptLLMCacheAssets(layoutInput(equivalent), options);
    assert.ok(result.coverage.every(record => record.required === false));
    for (const block of [layoutBlock('table', 'images/table.png'),
        { type: 'interline_equation', bbox: image.bbox, lines: [{ spans: [
            { type: 'interline_equation', image_path: 'images/equation.png' },
        ] }] }]) {
        await assert.rejects(adaptLLMCacheAssets(layoutInput([block]), options), code('LLM_CACHE_MISSING_IMAGE'));
    }
});

test('layout-only visual blocks without an image path cannot silently disappear', async () => {
    for (const block of [layoutBlock('image', undefined), layoutBlock('chart', undefined),
        { type: 'interline_equation', bbox: image.bbox, lines: [{ spans: [{ type: 'interline_equation' }] }] }]) {
        await assert.rejects(adaptLLMCacheAssets(layoutInput([block]), options), code('LLM_CACHE_MISSING_IMAGE'));
    }
});

test('table previews stay required when another body has HTML or a split caption identifies a figure', async () => {
    const table = layoutBlock('table', 'images/table.png', { html: '<table><tr><td>Value</td></tr></table>' });
    table.blocks.push(layoutBlock('table', 'images/image-only.png').blocks[0]);
    const figure = layoutBlock('table', 'images/figure.png', { html: '<table><tr><td>Study</td></tr></table>' });
    figure.blocks.push({ type: 'table_caption', lines: [{ spans: [
        { type: 'text', content: 'Figure' }, { type: 'text', content: '2. Forest plot.' },
    ] }] });
    const files = ['table', 'image-only', 'figure'].map(name => entry(`images/${name}.png`, createTestPNG()));
    const adapted = await adaptLLMCacheAssets(layoutInput([table, figure], files), options);
    assert.deepEqual(adapted.coverage.map(record => [record.path, record.required]), [
        ['images/table.png', false], ['images/image-only.png', true], ['images/figure.png', true],
    ]);
    await assert.rejects(adaptLLMCacheAssets(layoutInput([table], files.filter(file => file.path !== 'images/image-only.png')), options),
        code('LLM_CACHE_MISSING_IMAGE'));
});

test('deduplicated layout paths retain the strongest coverage requirement', async () => {
    const input = layoutInput([layoutBlock('image', 'images/shared.png'), layoutBlock('header', 'images/shared.png'),
        layoutBlock('image', 'images/shared.png')], [entry('images/shared.png', createTestPNG())]);
    const result = await adaptLLMCacheAssets(input, options);
    assert.equal(result.coverage.length, 1);
    assert.equal(result.coverage[0].required, true);
    assert.equal(result.counts.preserved, 1);
});

test('dropping a repaired layout cannot silently discard a layout-only required figure', async () => {
    const input = layoutInput([layoutBlock('image', 'images/layout-only.png')],
        [entry('images/layout-only.png', createTestPNG())], [body, image]);
    const r = renderer();
    await assert.rejects(adaptLLMCacheAssets(input, { ...options, openPDF: r.openPDF, fileData: Uint8Array.of(1) }),
        code('LLM_CACHE_MISSING_IMAGE'));
    assert.equal(r.closed, 1);
});

test('a repaired content figure also covers its original layout reference', async () => {
    const input = layoutInput([layoutBlock('image', image.img_path)], [], [body, image]);
    const r = renderer();
    const result = await adaptLLMCacheAssets(input, { ...options, openPDF: r.openPDF, fileData: Uint8Array.of(1) });
    assert.equal(result.entries.some(file => file.path === 'layout.json'), false);
    assert.ok(result.coverage.some(record => record.layoutPath === image.img_path
        && record.required && record.path === 'images/local-crop-1.png'));
});

test('releases decoded image resources after validation and cancellation', async () => {
    const f = fixture({ files: [entry('images/fig1.png', createTestPNG())] });
    let opened = 0;
    let closed = 0;
    const decodeImage = async (_, { signal }) => {
        assert.equal(signal, undefined);
        opened++;
        return { width: 8, height: 8, close() { closed++; } };
    };
    await adaptLLMCacheAssets(f.input, { ...options, decodeImage });
    assert.equal(opened, closed);
    const controller = new AbortController();
    await assert.rejects(adaptLLMCacheAssets(f.input, { ...options, signal: controller.signal,
        async decodeImage() {
            opened++;
            controller.abort();
            return { width: 8, height: 8, close() { closed++; } };
        },
    }), { name: 'AbortError' });
    assert.equal(opened, closed);
});

test('does not treat image-only table markup as an equivalent textual table', async () => {
    const f = fixture({ blocks: [body, { ...image, type: 'table', table_caption: ['Table 1'],
        table_body: '<table><tr><td><img src="plot.png"></td></tr></table>' }] });
    f.input.geometry = null;
    await assert.rejects(adaptLLMCacheAssets(f.input, options), code('LLM_CACHE_MISSING_IMAGE'));
});
