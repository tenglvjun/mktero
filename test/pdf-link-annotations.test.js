import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PDF_LINK_ANNOTATION_LIMITS,
    applyPDFLinkAnnotations,
    normalizePDFLinkAnnotations,
    validatePDFLink,
} from '../src/pdf/pdf-link-annotations.js';
import { renderInlineSpans } from '../src/mineru/document/text.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { prepareMinerUDocument, createMinerUFigureInput } from '../src/mineru/document/prepare.js';
import { createPDFJSTextEngine } from '../src/pdf/pdfjs-text-engine.js';

const IDENTITY_VIEWPORT = {
    transform: [1, 0, 0, -1, 0, 100],
    width: 100,
    height: 100,
};

test('extracts safe Link annotations alongside PDF text', async () => {
    const engine = createPDFJSTextEngine({
        loadDocument() {
            return {
                promise: Promise.resolve({
                    numPages: 1,
                    async getPageLabels() { return ['1']; },
                    async getPage() {
                        return {
                            getViewport() { return IDENTITY_VIEWPORT; },
                            async getTextContent() {
                                return { items: [], styles: {} };
                            },
                            async getAnnotations() {
                                return [{ annotationType: 2, url: 'https://example.org/paper_v2',
                                    rect: [10, 70, 40, 90] }];
                            },
                            cleanup() {},
                        };
                    },
                    async getOutline() { return []; },
                }),
                async destroy() {},
            };
        },
    });
    try {
        const index = await engine.extract(new Uint8Array([1]));
        assert.deepEqual(index.pages[0].links, [{
            url: 'https://example.org/paper_v2',
            rects: [[100, 100, 400, 300]],
        }]);
    }
    finally {
        await engine.dispose();
    }
});
test('does not mark a failed annotation read as an empty cached link list', async () => {
    const engine = createPDFJSTextEngine({
        loadDocument() {
            return {
                promise: Promise.resolve({
                    numPages: 1,
                    async getPageLabels() { return ['1']; },
                    async getPage() {
                        return {
                            getViewport() { return IDENTITY_VIEWPORT; },
                            async getTextContent() { return { items: [], styles: {} }; },
                            async getAnnotations() { throw new Error('annotation parsing failed'); },
                            cleanup() {},
                        };
                    },
                }),
                async destroy() {},
            };
        },
    });
    try {
        const index = await engine.extract(new Uint8Array([1]));
        assert.equal(index.linkAnnotationsComplete, false);
        assert.equal('links' in index.pages[0], false);
    }
    finally {
        await engine.dispose();
    }
});
test('propagates cancellation from PDF link annotation reading', async () => {
    const controller = new AbortController();
    let releaseAnnotations;
    let annotationsStarted;
    const started = new Promise(resolve => { annotationsStarted = resolve; });
    const engine = createPDFJSTextEngine({
        loadDocument() {
            return {
                promise: Promise.resolve({
                    numPages: 1,
                    async getPageLabels() { return ['1']; },
                    async getPage() {
                        return {
                            getViewport() { return IDENTITY_VIEWPORT; },
                            async getTextContent() { return { items: [], styles: {} }; },
                            getAnnotations() {
                                annotationsStarted();
                                return new Promise((_resolve, reject) => { releaseAnnotations = reject; });
                            },
                            cleanup() {},
                        };
                    },
                }),
                async destroy() {},
            };
        },
    });
    try {
        const extraction = engine.extract(new Uint8Array([1]), { signal: controller.signal });
        await started;
        controller.abort();
        releaseAnnotations(new Error('annotation read ended after cancellation'));
        await assert.rejects(extraction, error => error.name === 'AbortError');
    }
    finally {
        await engine.dispose();
    }
});
test('carries a matched native URL through the MinerU IR and Markdown serializer', () => {
    const layout = projectMinerULayout({
        pdf_info: [{
            page_idx: 0,
            page_size: [1000, 1000],
            para_blocks: [{
                type: 'text',
                bbox: [100, 100, 400, 300],
                lines: [{
                    bbox: [100, 100, 400, 300],
                    spans: [{ type: 'text', content: 'paper_v2', bbox: [100, 100, 400, 300] }],
                }],
            }],
            discarded_blocks: [],
        }],
    });
    const prepared = prepareMinerUDocument({ markdown: '', assets: [], layout }, {
        pdfText: {
            pages: [{ pageIndex: 0, links: [link('https://example.org/paper_v2', [100, 100, 400, 300])] }],
        },
    });

    assert.equal(prepared.markdown, '[paper_v2](https://example.org/paper_v2)');
});
test('marks an unavailable PDF index as incomplete in both prepared and figure inputs', () => {
    const layout = projectMinerULayout({
        pdf_info: [{
            page_idx: 0,
            page_size: [1000, 1000],
            para_blocks: [{ type: 'text', bbox: [100, 100, 400, 300], lines: [{
                bbox: [100, 100, 400, 300],
                spans: [{ type: 'text', content: 'paper', bbox: [100, 100, 400, 300] }],
            }] }],
            discarded_blocks: [],
        }],
    });
    const bundle = { markdown: '', assets: [], layout };
    const pdfText = { pages: [], linkAnnotationsComplete: false };

    assert.equal(prepareMinerUDocument(bundle, { pdfText }).pdfLinksIncomplete, true);
    assert.equal(createMinerUFigureInput(bundle, { pdfText }).pdfLinksIncomplete, true);
});
test('retains native links from readable pages when another annotation page fails', () => {
    const first = { type: 'text', content: 'linked', bbox: [100, 100, 400, 300] };
    const second = { type: 'text', content: 'plain', bbox: [100, 100, 400, 300] };
    const document = {
        pages: [{ pageIndex: 0 }, { pageIndex: 1 }],
        blocks: [{ fragments: [
            { pageIndex: 0, lines: [{ bbox: [100, 100, 400, 300], spans: [first] }] },
            { pageIndex: 1, lines: [{ bbox: [100, 100, 400, 300], spans: [second] }] },
        ] }],
        diagnostics: {},
    };

    applyPDFLinkAnnotations(document, {
        linkAnnotationsComplete: false,
        pages: [
            { pageIndex: 0, links: [link('https://example.org/linked', [100, 100, 400, 300])] },
            { pageIndex: 1 },
        ],
    });

    assert.equal(first.nativeLinkURL, 'https://example.org/linked');
    assert.equal(second.nativeLinkURL, undefined);
    assert.equal(document.diagnostics.pdfLinks.incomplete, true);
});

function link(url, rect) {
    return { url, rects: [rect] };
}

function documentWithSpans(spans, lineBBox = [0, 0, 1000, 1000]) {
    return {
        pages: [{ pageIndex: 0 }],
        blocks: [{
            fragments: [{
                pageIndex: 0,
                lines: [{ bbox: lineBBox, spans }],
            }],
        }],
        diagnostics: {},
    };
}

test('normalizes safe PDF link annotations into the document coordinate frame', () => {
    const links = normalizePDFLinkAnnotations([
        { annotationType: 2, url: 'https://example.org/UIST_Demo', rect: [10, 70, 40, 90] },
        { annotationType: 2, url: 'javascript:alert(1)', rect: [10, 70, 40, 90] },
        { annotationType: 2, url: '#internal', rect: [10, 70, 40, 90] },
        { annotationType: 1, url: 'https://example.org/not-a-link', rect: [10, 70, 40, 90] },
    ], IDENTITY_VIEWPORT);

    assert.deepEqual(links, [{
        url: 'https://example.org/UIST_Demo',
        rects: [[100, 100, 400, 300]],
    }]);
    assert.equal(validatePDFLink(links[0]), true);
});

test('handles rotated PDF viewports and quad points', () => {
    const rotated = normalizePDFLinkAnnotations([
        { annotationType: 2, url: 'https://example.org/rotated', rect: [10, 20, 30, 40] },
    ], {
        transform: [0, 1, 1, 0, 0, 0],
        width: 200,
        height: 100,
    });
    const quad = normalizePDFLinkAnnotations([
        { annotationType: 2, url: 'https://example.org/quad',
            rect: [0, 0, 100, 100], quadPoints: [10, 90, 40, 90, 10, 70, 40, 70] },
    ], IDENTITY_VIEWPORT);

    assert.deepEqual(rotated[0].rects, [[100, 100, 200, 300]]);
    assert.deepEqual(quad[0].rects, [[100, 100, 400, 300]]);
});

test('skips native links when the known PDF and MinerU page shapes disagree', () => {
    const span = {
        type: 'text', content: 'paper', linkURL: 'https://mineru.example/original',
        bbox: [100, 100, 400, 300],
    };
    const document = documentWithSpans([span]);
    document.pages[0] = { pageIndex: 0, width: 1000, height: 1000, pageSizeKnown: true };

    applyPDFLinkAnnotations(document, {
        pages: [{
            pageIndex: 0,
            viewport: { width: 200, height: 100 },
            links: [link('https://example.org/wrong-page', [100, 100, 400, 300])],
        }],
    });

    assert.equal(span.nativeLinkURL, undefined);
    assert.equal(span.linkURL, 'https://mineru.example/original');
    assert.equal(document.diagnostics.pdfLinks.skipped, 1);
});

test('allows coordinate matching when a Middle JSON page size was unavailable', () => {
    const span = { type: 'text', content: 'paper', bbox: [100, 100, 400, 300] };
    const document = documentWithSpans([span]);
    document.pages[0] = { pageIndex: 0, width: 1000, height: 1000, pageSizeKnown: false };

    applyPDFLinkAnnotations(document, {
        pages: [{
            pageIndex: 0,
            viewport: { width: 200, height: 100 },
            links: [link('https://example.org/paper', [100, 100, 400, 300])],
        }],
    });

    assert.equal(span.nativeLinkURL, 'https://example.org/paper');
});
test('matches a native link to a uniquely covered span and gives it priority', () => {
    const span = {
        type: 'text',
        content: 'UIST_Demo',
        linkURL: 'https://mineru.example/wrong',
        bbox: [100, 100, 400, 300],
    };
    const document = documentWithSpans([span]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [link('https://example.org/UIST_Demo', [100, 100, 400, 300])] }],
    });

    assert.equal(span.linkURL, 'https://mineru.example/wrong');
    assert.equal(span.nativeLinkURL, 'https://example.org/UIST_Demo');
    assert.equal(renderInlineSpans([span]), '[UIST_Demo](https://example.org/UIST_Demo)');
    assert.deepEqual(document.diagnostics.pdfLinks, {
        pages: 1, annotations: 1, matched: 1, ambiguous: 0, skipped: 0,
    });
});

test('matches all covered spans of one link while leaving unrelated spans alone', () => {
    const linked = [
        { type: 'text', content: 'paper', bbox: [100, 100, 300, 300] },
        { type: 'text', content: '_v2', bbox: [300, 100, 500, 300] },
    ];
    const unrelated = { type: 'text', content: 'tail', bbox: [600, 100, 800, 300] };
    const document = documentWithSpans([...linked, unrelated]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [link('https://example.org/paper_v2', [100, 100, 500, 300])] }],
    });

    assert.equal(linked[0].nativeLinkURL, 'https://example.org/paper_v2');
    assert.equal(linked[1].nativeLinkURL, 'https://example.org/paper_v2');
    assert.equal(unrelated.nativeLinkURL, undefined);
    assert.equal(renderInlineSpans([...linked, unrelated]),
        '[paper_v2](https://example.org/paper_v2) tail');
});

test('matches a span covered by the union of multiple PDF quads', () => {
    const span = { type: 'text', content: 'paper_v2', bbox: [100, 100, 500, 300] };
    const document = documentWithSpans([span]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [{
            url: 'https://example.org/paper_v2',
            rects: [[100, 100, 300, 300], [300, 100, 500, 300]],
        }] }],
    });

    assert.equal(span.nativeLinkURL, 'https://example.org/paper_v2');
});
test('does not map a page-sized link to a small text span', () => {
    const span = { type: 'text', content: 'paper', bbox: [100, 100, 250, 150] };
    const document = documentWithSpans([span]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [link('https://example.org/page', [0, 0, 1000, 1000])] }],
    });

    assert.equal(span.nativeLinkURL, undefined);
    assert.equal(document.diagnostics.pdfLinks.skipped, 1);
});

test('matches a short text span inside a wider link annotation', () => {
    const span = { type: 'text', content: 'https://doi.org/10.1', bbox: [100, 100, 160, 140] };
    const document = documentWithSpans([span]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [link('https://doi.org/10.1000/paper', [100, 100, 900, 140])] }],
    });

    assert.equal(span.nativeLinkURL, 'https://doi.org/10.1000/paper');
});
test('does not expand a native link to a larger span with only partial overlap', () => {
    const span = { type: 'text', content: 'a long OCR span containing unrelated words', bbox: [100, 100, 900, 300] };
    const document = documentWithSpans([span]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [link('https://example.org/part', [100, 100, 580, 300])] }],
    });

    assert.equal(span.nativeLinkURL, undefined);
    assert.equal(document.diagnostics.pdfLinks.skipped, 1);
});

test('keeps scanning past unsafe annotations until the safe-link limit is reached', () => {
    const annotations = Array.from({ length: PDF_LINK_ANNOTATION_LIMITS.maxLinksPerPage }, () => ({
        annotationType: 2,
        url: 'javascript:alert(1)',
        rect: [10, 70, 40, 90],
    }));
    annotations.push({ annotationType: 2, url: 'https://example.org/valid', rect: [10, 70, 40, 90] });

    assert.deepEqual(normalizePDFLinkAnnotations(annotations, IDENTITY_VIEWPORT), [{
        url: 'https://example.org/valid',
        rects: [[100, 100, 400, 300]],
    }]);
});

test('does not use a line fallback for an edge-only overlap', () => {
    const span = { type: 'text', content: 'paper' };
    const document = documentWithSpans([span], [100, 100, 500, 300]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [link('https://example.org/edge', [480, 100, 500, 300])] }],
    });

    assert.equal(span.nativeLinkURL, undefined);
    assert.equal(document.diagnostics.pdfLinks.skipped, 1);
});

test('keeps unique line fallbacks when another line is ambiguous', () => {
    const first = { type: 'text', content: 'first' };
    const second = { type: 'text', content: 'second' };
    const third = { type: 'text', content: 'third' };
    const lineOne = { bbox: [100, 100, 500, 300], spans: [first] };
    const lineTwo = { bbox: [100, 400, 500, 600], spans: [second, third] };
    const document = {
        pages: [{ pageIndex: 0 }],
        blocks: [{ fragments: [{ pageIndex: 0, lines: [lineOne, lineTwo] }] }],
        diagnostics: {},
    };

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [link('https://example.org/multi-line', [100, 100, 500, 600])] }],
    });

    assert.equal(first.nativeLinkURL, 'https://example.org/multi-line');
    assert.equal(second.nativeLinkURL, undefined);
    assert.equal(third.nativeLinkURL, undefined);
});
test('does not guess when a line-level link could cover multiple spans', () => {
    const spans = [
        { type: 'text', content: 'first' },
        { type: 'text', content: 'second' },
    ];
    const document = documentWithSpans(spans, [100, 100, 500, 300]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [link('https://example.org/ambiguous', [100, 100, 500, 300])] }],
    });

    assert.equal(spans[0].nativeLinkURL, undefined);
    assert.equal(spans[1].nativeLinkURL, undefined);
    assert.equal(document.diagnostics.pdfLinks.skipped, 1);
});

test('does not apply conflicting native targets to the same span', () => {
    const span = { type: 'text', content: 'paper', bbox: [100, 100, 400, 300] };
    const document = documentWithSpans([span]);

    applyPDFLinkAnnotations(document, {
        pages: [{ pageIndex: 0, links: [
            link('https://example.org/one', [100, 100, 400, 300]),
            link('https://example.org/two', [100, 100, 400, 300]),
        ] }],
    });

    assert.equal(span.nativeLinkURL, undefined);
    assert.equal(document.diagnostics.pdfLinks.ambiguous, 1);
});

test('escapes a link label when its target is not a safe HTTP URL', () => {
    assert.equal(renderInlineSpans([{
        type: 'text', content: '](https://evil.example)', linkURL: '#internal',
    }]), '\\](https://evil.example)');
});
test('escapes every merged link-label span so OCR cannot replace the destination', () => {
    const url = 'https://doi.org/10.1000/good';
    const markdown = renderInlineSpans([
        { type: 'text', content: 'doi', linkURL: url },
        { type: 'text', content: '](https://evil.example)', linkURL: url, nativeLinkURL: url },
    ]);

    assert.equal(markdown, '[doi\\](https://evil.example)](https://doi.org/10.1000/good)');
});
test('keeps linked math inert instead of producing a malformed Markdown link', () => {
    assert.equal(renderInlineSpans([{
        type: 'math', content: 'x^2]', linkURL: 'https://example.org/math',
    }]), '$x^2]$');
});

test('rejects malformed, oversized, and unsafe cached link records', () => {
    assert.equal(validatePDFLink({ url: 'javascript:alert(1)', rects: [[0, 0, 100, 100]] }), false);
    assert.equal(validatePDFLink({ url: 'https://example.org', rects: [[0, 0, 1001, 100]] }), false);
    assert.equal(validatePDFLink({ url: 'https://example.org', rects: [] }), false);
    assert.equal(validatePDFLink({ url: 'https://example.org', rects: [[0, 0, 100, 100]], extra: true }), true);
    assert.equal(validatePDFLink({ url: ' https://example.org', rects: [[0, 0, 100, 100]] }), false);
    assert.equal(validatePDFLink({ url: new String('https://example.org'), rects: [[0, 0, 100, 100]] }), false);
});
