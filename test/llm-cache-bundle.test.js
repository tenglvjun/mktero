import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLLMCacheEntries } from '../src/mineru/llm-cache-bundle.js';

const attachment = { id: 7, key: 'PDFKEY77', libraryID: 1 };
const text = 'A synthetic paper body with source coordinates.';
const block = { type: 'text', text, page_idx: 0, bbox: [10, 10, 900, 100] };
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const entry = (path, value) => ({ path, data: bytes(value) });
const entries = extra => [entry('full.md', text), entry('content_list.json', [block]), ...extra];
const source = extra => ({ kind: 'llm-for-zotero/mineru-cache-source', version: 2,
    attachmentId: 7, attachmentKey: 'PDFKEY77', origin: 'parsed', ...extra });
const code = expected => error => error.code === expected;

test('reads v2, legacy, missing and restored provenance without inventing a PDF binding', () => {
    for (const [value, format] of [[source({}), 'v2'],
        [{ attachmentId: 7, attachmentKey: 'PDFKEY77', parsedAt: '2026-01-01' }, 'legacy'],
        [source({ origin: 'restored', parentItemKey: 'OLDPARENT', sourceFilename: 'old.pdf' }), 'v2']]) {
        const inspected = inspectLLMCacheEntries(entries([entry('_llm_source.json', value)]), { attachment });
        assert.equal(inspected.sourceFormat, format);
        assert.deepEqual(inspected.contentList[0].bbox, block.bbox);
    }
    const missing = inspectLLMCacheEntries(entries([]), { attachment });
    assert.equal(missing.sourceFormat, 'missing');
    assert.deepEqual(missing.warnings, ['LLM_CACHE_SOURCE_MISSING']);
});

test('rejects declared future/wrong source formats and conflicting attachment identity', () => {
    for (const value of [source({ version: 3 }), source({ kind: 'another-plugin' })]) {
        assert.throws(() => inspectLLMCacheEntries(entries([entry('_llm_source.json', value)]), { attachment }),
            code('LLM_CACHE_UNSUPPORTED_SOURCE'));
    }
    for (const value of [source({ attachmentId: 8 }), source({ attachmentKey: 'OTHERKEY' })]) {
        assert.throws(() => inspectLLMCacheEntries(entries([entry('_llm_source.json', value)]), { attachment }),
            code('LLM_CACHE_ATTACHMENT_MISMATCH'));
    }
});

test('checks JavaScript character length and actual PDF page count', () => {
    const inspected = inspectLLMCacheEntries(entries([entry('manifest.json', { totalChars: text.length, totalPages: 2 })]),
        { attachment, pdfPageCount: 2 });
    assert.equal(inspected.manifest.totalPages, 2);
    assert.throws(() => inspectLLMCacheEntries(entries([entry('manifest.json', { totalChars: text.length + 1 })])),
        code('LLM_CACHE_CHANGED'));
    assert.throws(() => inspectLLMCacheEntries(entries([entry('manifest.json', { totalPages: 3 })]), { pdfPageCount: 2 }),
        code('LLM_CACHE_PAGE_MISMATCH'));
});

test('preserves chunked global pages and safe resource subdirectories', () => {
    const list = [{ ...block, page_idx: 200 }, { type: 'image', page_idx: 201,
        bbox: [10, 100, 900, 500], img_path: 'images/chunk-002/figure.png', image_caption: ['Figure 2'] }];
    const inspected = inspectLLMCacheEntries([entry('full.md', text), entry('paper_content_list.json', list)],
        { pdfPageCount: 202 });
    assert.equal(inspected.contentList[0].page_idx, 200);
    assert.equal(inspected.contentList[1].img_path, 'images/chunk-002/figure.png');
    assert.throws(() => inspectLLMCacheEntries([entry('full.md', text), entry('content_list.json', list)],
        { pdfPageCount: 201 }), code('LLM_CACHE_INVALID_STRUCTURE'));
});

test('rejects bbox-less local V1 instead of inventing source coordinates', () => {
    const { bbox, ...withoutBox } = block;
    assert.throws(() => inspectLLMCacheEntries([entry('full.md', text), entry('content_list.json', [withoutBox])]),
        code('LLM_CACHE_UNSUPPORTED_BBOX'));
});

test('rejects malformed JSON, ambiguous structures, pending markers and unsupported legacy Markdown', () => {
    assert.throws(() => inspectLLMCacheEntries([entry('full.md', text), entry('content_list.json', '{')]),
        code('LLM_CACHE_INVALID_JSON'));
    assert.throws(() => inspectLLMCacheEntries(entries([entry('paper_content_list.json', [block])])),
        code('LLM_CACHE_AMBIGUOUS_STRUCTURE'));
    assert.throws(() => inspectLLMCacheEntries(entries([entry('_llm_write_pending.json', {})])), code('LLM_CACHE_WRITING'));
    assert.throws(() => inspectLLMCacheEntries([entry('_content.md', text)]), code('LLM_CACHE_MISSING_MARKDOWN'));
    assert.throws(() => inspectLLMCacheEntries([entry('full.md', text)]), code('LLM_CACHE_UNSUPPORTED_FORMAT'));
});

test('rejects traversal, encoded traversal, network resources and duplicate paths', () => {
    for (const path of ['../leak.png', 'images/%2e%2e/leak.png', 'https://example.test/x.png', 'C:/x.png', 'images\\x.png']) {
        assert.throws(() => inspectLLMCacheEntries(entries([entry(path, 'bad')])), code('LLM_CACHE_UNSAFE_PATH'));
        assert.throws(() => inspectLLMCacheEntries([entry('full.md', text),
            entry('content_list.json', [{ ...block, img_path: path }])]), code('LLM_CACHE_UNSAFE_PATH'));
    }
    assert.throws(() => inspectLLMCacheEntries(entries([entry('full.md', 'duplicate')])), code('LLM_CACHE_UNSAFE_PATH'));
});

test('enforces file, byte, structure and depth budgets before processing resources', () => {
    assert.throws(() => inspectLLMCacheEntries(entries([]), { limits: { maxEntries: 1 } }), code('LLM_CACHE_RESOURCE_LIMIT'));
    assert.throws(() => inspectLLMCacheEntries(entries([]), { limits: { maxTotalBytes: 2 } }), code('LLM_CACHE_RESOURCE_LIMIT'));
    assert.throws(() => inspectLLMCacheEntries(entries([]), { limits: { maxContentBlocks: 0 } }), code('LLM_CACHE_INVALID_STRUCTURE'));
    assert.throws(() => inspectLLMCacheEntries(entries([entry('images/a/b/c.png', 'x')]),
        { limits: { maxDepth: 3 } }), code('LLM_CACHE_UNSAFE_PATH'));
});

test('accepts validated layout-only input and rejects layouts that silently lose pages', () => {
    const layout = { pdf_info: [{ page_idx: 0, page_size: [600, 800], para_blocks: [{ type: 'text',
        bbox: [10, 10, 500, 100], lines: [{ bbox: [10, 10, 500, 100], spans: [{ type: 'text', content: text }] }] }], discarded_blocks: [] }] };
    assert.ok(inspectLLMCacheEntries([entry('full.md', text), entry('layout.json', layout)], { pdfPageCount: 1 }).layout);
    layout.pdf_info.push({ page_idx: 0, page_size: [600, 800] });
    assert.throws(() => inspectLLMCacheEntries([entry('full.md', text), entry('layout.json', layout)]),
        code('LLM_CACHE_INVALID_STRUCTURE'));
    for (const invalid of ['null', 'false', '{}', '{']) {
        assert.throws(() => inspectLLMCacheEntries(entries([entry('layout.json', invalid)])),
            error => ['LLM_CACHE_INVALID_STRUCTURE', 'LLM_CACHE_INVALID_JSON'].includes(error.code));
    }
});

test('rejects unsupported future block kinds and non-string image paths explicitly', () => {
    assert.throws(() => inspectLLMCacheEntries([entry('full.md', text),
        entry('content_list.json', [{ ...block, type: 'new-visual-kind' }])]), code('LLM_CACHE_UNSUPPORTED_FORMAT'));
    assert.throws(() => inspectLLMCacheEntries([entry('full.md', text),
        entry('content_list.json', [{ ...block, img_path: 4 }])]), code('LLM_CACHE_INVALID_STRUCTURE'));
});
