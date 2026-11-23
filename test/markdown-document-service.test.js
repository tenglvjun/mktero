import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createMarkdownDocumentService,
    MarkdownDocumentService,
} from '../src/core/markdown-document-service.js';
import { MarkdownAnnotationOverlay } from '../src/core/markdown-annotation-overlay.js';
import {
    createPDFAnnotationTextParts,
    MarkdownLocalAnnotations,
} from '../src/core/markdown-local-annotations.js';
import { PDFAnnotationGroups } from '../src/core/pdf-annotation-groups.js';
import { projectSourceAnnotationRanges } from '../src/editor/translation-presentation.js';

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
    const sourceMap = [{
        type: 'text',
        markdownFrom: 2,
        markdownTo: 18,
        locations: [{ pageIndex: 0, bbox: [100, 120, 900, 220] }],
    }];
    const chromeRanges = [{ from: 0, to: 2 }];
    const service = new MarkdownDocumentService({
        extractor: {
            extract: async () => ({
                kind: 'markdown',
                provider: 'mineru',
                parserProfile: 'mineru-profile-v1',
                title: 'MinerU Paper',
                markdown: '# Already Markdown\n\n| A | B |',
                extractedPages: 2,
                totalPages: 2,
                warnings: [],
                cacheHit: true,
                resumedTask: true,
                cacheKey: 'a'.repeat(64),
                sourceHash: 'b'.repeat(64),
                sourceMap,
                chromeRanges,
                documentStructure: 'mineru-ir-v1',
            }),
        },
    });

    const result = await service.convert(42);
    assert.equal(result.documentStructure, 'mineru-ir-v1');

    assert.equal(result.markdown, '# Already Markdown\n\n| A | B |');
    assert.equal(result.sourceKind, 'markdown');
    assert.equal(result.provider, 'mineru');
    assert.equal(result.parserProfile, 'mineru-profile-v1');
    assert.equal(result.cacheHit, true);
    assert.equal(result.resumedTask, true);
    assert.equal(result.cacheKey, 'a'.repeat(64));
    assert.equal(result.sourceHash, 'b'.repeat(64));
    assert.equal(result.sourceMap, sourceMap);
    assert.equal(result.chromeRanges, chromeRanges);
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
    const pdfResolveOptions = [];
    const localResolveOptions = [];
    const sourceMap = [{
        type: 'text',
        markdownFrom: 0,
        markdownTo: 17,
        locations: [{ pageIndex: 2, bbox: [100, 100, 900, 220] }],
    }];
    const service = new MarkdownDocumentService({
        extractor: {
            extract: async () => ({
                kind: 'markdown',
                title: 'Annotated paper',
                markdown: 'Important result.',
                warnings: [],
                sourceMap,
            }),
        },
        annotationOverlay: {
            async resolve(_itemID, _markdown, options) {
                pdfResolveOptions.push(options);
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
    await service.resolveAnnotations(42, 'Important result.', { sourceMap });

    assert.deepEqual(result.annotationOverlay.matched.map(({ id }) => id), [
        'PDF1',
        'mktero-local-1',
    ]);
    assert.deepEqual(pdfResolveOptions, [
        { sourceMap },
        { sourceMap },
    ]);
    assert.deepEqual(localResolveOptions, [
        { retryFailed: true, sourceMap, figureMap: null, sourceHash: null },
        { retryFailed: false, sourceMap, figureMap: null, sourceHash: null },
    ]);
});

test('propagates current PDF caption identity through conversion, saved open, and annotation refresh', async () => {
    const figureMap = { version: 1, markdownHash: 'c'.repeat(64), figures: [] };
    const sourceHash = 'b'.repeat(64);
    const calls = [];
    const document = {
        kind: 'markdown', markdown: 'Caption document.', sourceHash, figureMap,
        sourceMap: [], renderMode: 'markdown', sourceItemID: 42,
    };
    const service = new MarkdownDocumentService({
        extractor: { extract: async () => document },
        savedResolver: { resolve: async () => document },
        localAnnotations: {
            async resolve(itemID, markdown, options) {
                calls.push({ itemID, markdown, options });
                return { matched: [], unmatched: [] };
            },
        },
    });

    await service.convert(42);
    await service.openSaved(100);
    await service.resolveAnnotations(42, document.markdown, { sourceHash, figureMap });

    assert.equal(calls.length, 3);
    for (const call of calls) {
        assert.equal(call.itemID, 42);
        assert.equal(call.options.figureMap, figureMap);
        assert.equal(call.options.sourceHash, sourceHash);
    }
    assert.deepEqual(calls.map(call => call.options.retryFailed), [true, true, false]);
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


test('reopens a translated annotation whose first sentence spans two PDF pages', async () => {
    const source = 'Initial results carried over. This sentence stays unmarked. Final evidence.';
    const first = 'Initial results carried over.';
    const last = 'Final evidence.';
    const lastStart = source.indexOf(last);
    const ranges = [{ from: 0, to: first.length }, { from: lastStart, to: source.length }];
    const annotationStore = makeStore();
    const groupStore = makeStore();
    let finished;
    const synchronized = new Promise(resolve => { finished = resolve; });
    const pdf = [
        { id: 'PAGE001', text: 'Initial results', pageIndex: 0 },
        { id: 'PAGE002', text: 'carried over.', pageIndex: 1 },
        { id: 'PAGE003', text: last, pageIndex: 1 },
    ].map((annotation, index) => ({
        ...annotation, source: 'pdf', type: 'highlight', color: '#ffd400',
        pageLabel: String(annotation.pageIndex + 1), sortIndex: String(index),
    }));
    const groups = new PDFAnnotationGroups({ store: groupStore });
    const local = new MarkdownLocalAnnotations({
        store: annotationStore,
        createID: () => 'integration-1',
        createPDFAnnotation: async (_itemID, draft) => {
            assert.deepEqual(draft.pdfTextParts.map(part => part.text), [first, last]);
            return { id: pdf[0].id, annotationIDs: pdf.map(part => part.id),
                createdAnnotationIDs: pdf.map(part => part.id) };
        },
        onPDFAnnotationGroup: (...args) => groups.record(...args),
        onSynchronizationChange: finished,
        onError: error => finished(error),
    });
    await local.create(42, {
        ranges, text: first + ' ' + last,
        pdfTextParts: createPDFAnnotationTextParts(source, ranges),
    });
    assert.equal(await synchronized, 42);

    const reopened = new MarkdownDocumentService({
        extractor: {},
        annotationOverlay: new MarkdownAnnotationOverlay({
            extractor: { extract: async () => pdf },
        }),
        annotationGroups: new PDFAnnotationGroups({ store: groupStore }),
        localAnnotations: new MarkdownLocalAnnotations({ store: annotationStore }),
    });
    const { annotationOverlay } = await reopened.resolveAnnotations(42, source);
    assert.equal(annotationOverlay.matched.length, 1);
    const [annotation] = annotationOverlay.matched;
    assert.equal(annotation.id, 'PAGE001');
    assert.deepEqual(annotation.ranges, [
        { from: 0, to: 'Initial results'.length },
        { from: source.indexOf('carried over.'), to: first.length },
        ranges[1],
    ]);
    assert.deepEqual(projectSourceAnnotationRanges(annotation.ranges, {
        sourceMarkdown: source,
        translatedMarkdown: 'Alpha. Skip. Omega.',
        groupedPDFSelection: true,
        blockRanges: [{
            sourceFrom: 0, sourceTo: source.length, translatedFrom: 0, translatedTo: 19,
            alignmentUnits: [
                { id: 'first', sourceRanges: [ranges[0]], translatedFrom: 0, translatedTo: 6 },
                { id: 'skip', sourceRanges: [{ from: first.length + 1, to: lastStart - 1 }],
                    translatedFrom: 7, translatedTo: 12 },
                { id: 'last', sourceRanges: [ranges[1]], translatedFrom: 13, translatedTo: 19 },
            ],
        }],
    }), [{ from: 0, to: 6 }, { from: 13, to: 19 }]);

    function makeStore() {
        let records = [];
        return {
            get: async () => structuredClone(records),
            put: async (_itemID, value) => { records = structuredClone(value); },
        };
    }
});
