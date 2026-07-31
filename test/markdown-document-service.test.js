import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createMarkdownDocumentService,
    MarkdownDocumentService,
} from '../src/core/markdown-document-service.js';
import { MarkdownAnnotationOverlay } from '../src/core/markdown-annotation-overlay.js';

function createPdfItem(overrides = {}) {
    return {
        id: 42,
        parentItem: null,
        isPDFAttachment: () => true,
        getDisplayTitle: () => 'Example Paper',
        ...overrides,
    };
}

test('converts the opened PDF through Zotero structured text when available', async () => {
    const zotero = {
        Items: {
            getAsync: async () => createPdfItem(),
        },
        SDT: {
            getReader: async (_itemID, options) => {
                options.onProgress?.(50);
                return {
                    materialize: async () => ({
                        catalog: { outline: [{ title: 'Intro', ref: [0] }], pages: [] },
                        content: [{ type: 'heading', content: [{ text: 'Intro' }] }],
                    }),
                };
            },
        },
        PDFWorker: {
            getFullText: async () => {
                throw new Error('plain-text fallback should not run');
            },
        },
    };
    const progress = [];
    const service = createMarkdownDocumentService({ zotero });

    const result = await service.convert(42, {
        onProgress: value => progress.push(value),
    });

    assert.deepEqual(result, {
        itemID: 42,
        title: 'Example Paper',
        markdown: '# Intro',
        sourceKind: 'structured',
        extractedPages: null,
        totalPages: null,
        warnings: [],
    });
    assert.deepEqual(progress, [50]);
});

test('falls back to Zotero PDF full text when structured text is unavailable', async () => {
    const zotero = {
        Items: {
            getAsync: async () => createPdfItem(),
        },
        SDT: {
            getReader: async () => null,
        },
        PDFWorker: {
            getFullText: async () => ({
                text: 'Fallback text',
                extractedPages: 2,
                totalPages: 3,
            }),
        },
    };
    const service = createMarkdownDocumentService({ zotero });

    const result = await service.convert(42);

    assert.equal(result.markdown, 'Fallback text');
    assert.equal(result.sourceKind, 'plain');
    assert.equal(result.extractedPages, 2);
    assert.equal(result.totalPages, 3);
    assert.deepEqual(result.warnings, [
        'Structured PDF extraction was unavailable; showing plain text.',
    ]);
});

test('rejects a non-PDF attachment through the conversion interface', async () => {
    const zotero = {
        Items: {
            getAsync: async () => createPdfItem({ isPDFAttachment: () => false }),
        },
    };
    const service = createMarkdownDocumentService({ zotero });

    await assert.rejects(
        () => service.convert(42),
        /Only PDF attachments can be converted/
    );
});

test('rejects an empty structured document as non-extractable', async () => {
    const zotero = {
        Items: {
            getAsync: async () => createPdfItem(),
        },
        SDT: {
            getReader: async () => ({
                materialize: async () => ({ content: [] }),
            }),
        },
    };
    const service = createMarkdownDocumentService({ zotero });

    await assert.rejects(
        () => service.convert(42),
        /no extractable text/i
    );
});

test('passes through Markdown produced by MinerU', async () => {
    const service = new MarkdownDocumentService({
        extractor: {
            extract: async () => ({
                kind: 'markdown',
                title: 'MinerU Paper',
                markdown: '# Already Markdown\n\n| A | B |',
                extractedPages: 2,
                totalPages: 2,
                warnings: [],
                cacheHit: true,
                cacheKey: 'a'.repeat(64),
            }),
        },
    });

    const result = await service.convert(42);

    assert.equal(result.markdown, '# Already Markdown\n\n| A | B |');
    assert.equal(result.sourceKind, 'markdown');
    assert.equal(result.cacheHit, true);
    assert.equal(result.cacheKey, 'a'.repeat(64));
});

test('adds current Zotero PDF annotations without changing Markdown', async () => {
    const annotationOverlay = new MarkdownAnnotationOverlay({
        extractor: {
            extract: async () => [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'important result',
                comment: 'Review this',
                color: '#ffd400',
                pageLabel: '4',
                pageIndex: 3,
                sortIndex: '00001',
            }],
        },
    });
    const service = new MarkdownDocumentService({
        extractor: {
            extract: async () => ({
                kind: 'markdown',
                title: 'Annotated paper',
                markdown: 'An **important** result.',
                warnings: [],
            }),
        },
        annotationOverlay,
    });

    const result = await service.convert(42);

    assert.equal(result.markdown, 'An **important** result.');
    assert.deepEqual(result.annotationOverlay, {
        matched: [{
            id: 'HIGH0001',
            type: 'highlight',
            text: 'important result',
            comment: 'Review this',
            color: '#ffd400',
            pageLabel: '4',
            pageIndex: 3,
            sortIndex: '00001',
            matchKind: 'exact',
            ranges: [{ from: 5, to: 23 }],
        }],
        unmatched: [],
    });
});

test('combines Zotero PDF annotations with local Markdown annotations', async () => {
    const localResolveOptions = [];
    const service = new MarkdownDocumentService({
        extractor: {
            extract: async () => ({
                kind: 'markdown',
                title: 'Annotated paper',
                markdown: 'Important result.',
                warnings: [],
            }),
        },
        annotationOverlay: {
            async resolve() {
                return {
                    matched: [{ id: 'PDF1', ranges: [{ from: 0, to: 9 }] }],
                    unmatched: [],
                };
            },
        },
        localAnnotations: {
            async resolve(_itemID, _markdown, options) {
                localResolveOptions.push(options);
                return {
                    matched: [{
                        id: 'mktero-local-1',
                        source: 'markdown',
                        ranges: [{ from: 10, to: 16 }],
                    }],
                    unmatched: [],
                };
            },
        },
    });

    const result = await service.convert(42);
    await service.resolveAnnotations(42, 'Important result.');

    assert.deepEqual(result.annotationOverlay.matched.map(({ id }) => id), [
        'PDF1',
        'mktero-local-1',
    ]);
    assert.deepEqual(localResolveOptions, [
        { retryFailed: true },
        { retryFailed: false },
    ]);
});

test('keeps a successful conversion when Zotero annotations cannot be read', async () => {
    const annotationOverlay = new MarkdownAnnotationOverlay({
        extractor: {
            extract: async () => {
                throw new Error('annotation database unavailable');
            },
        },
    });
    const service = new MarkdownDocumentService({
        extractor: {
            extract: async () => ({
                kind: 'markdown',
                title: 'Readable paper',
                markdown: 'Readable body',
                warnings: [],
            }),
        },
        annotationOverlay,
    });

    const result = await service.convert(42);

    assert.equal(result.markdown, 'Readable body');
    assert.deepEqual(result.annotationOverlay, { matched: [], unmatched: [] });
    assert.deepEqual(result.warnings, [
        'Zotero PDF annotations could not be loaded.',
    ]);
});

test('reopens an intentionally empty user-edited Markdown document', async () => {
    const service = new MarkdownDocumentService({
        extractor: {
            extract: async () => ({
                kind: 'markdown',
                title: 'Edited paper',
                markdown: '',
                warnings: [],
                cacheHit: true,
                cacheKey: 'a'.repeat(64),
                userEdited: true,
            }),
        },
    });

    const result = await service.convert(42);

    assert.equal(result.markdown, '');
    assert.equal(result.cacheHit, true);
});

test('allows a fresh conversion while an aborted conversion is settling', async () => {
    let calls = 0;
    const service = new MarkdownDocumentService({
        extractor: {
            extract: async (_itemID, { signal }) => {
                calls++;
                if (calls === 1) {
                    return new Promise((_, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason), {
                            once: true,
                        });
                    });
                }
                return {
                    kind: 'markdown',
                    title: 'Fresh conversion',
                    markdown: '# Fresh conversion',
                    extractedPages: 1,
                    totalPages: 1,
                    warnings: [],
                };
            },
        },
    });
    const firstController = new AbortController();
    const first = service.convert(42, { signal: firstController.signal });
    firstController.abort();

    const second = service.convert(42, { signal: new AbortController().signal });

    await assert.rejects(first, error => error.name === 'AbortError');
    assert.equal((await second).markdown, '# Fresh conversion');
    assert.equal(calls, 2);
});
