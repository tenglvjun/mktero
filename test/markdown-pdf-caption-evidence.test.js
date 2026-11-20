import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPDFCaptionEvidence } from '../src/core/pdf-caption-evidence.js';
import { escapeImageDescription } from '../src/markdown/markdown-figures.js';

function captionDocument(caption = 'Figure 4 | Complete **caption** with $w_{1}, \\ldots, w_{k}$.') {
    const alt = escapeImageDescription(caption);
    const image = `![${alt}](generated/figure.png)`;
    const markdown = `Body before.\n\n${image}\n\nBody after.`;
    const from = markdown.indexOf(image);
    const captionBBox = [100, 350, 900, 460];
    const panelBBox = [140, 100, 850, 330];
    return {
        markdown,
        sourceHash: 'a'.repeat(64),
        figureMap: {
            version: 1,
            markdownHash: createHash('sha256').update(markdown).digest('hex'),
            figures: [{
                id: 'fig-p6-b64',
                pageIndex: 6,
                visualBBox: [135, 95, 860, 335],
                captionBBox,
                memberBlockIds: ['panel', 'caption'],
                panels: [{ blockId: 'panel', bbox: panelBBox, originalAssetPath: 'images/panel.png' }],
                provenance: {
                    coordinateFrame: 'display-cropbox',
                    rotation: 0,
                    fragments: [
                        { blockId: 'panel', role: 'panel', bbox: panelBBox, markdown: '![Panel](images/panel.png)' },
                        { blockId: 'caption', role: 'caption', bbox: captionBBox, markdown: caption },
                    ],
                    pdfGeometry: {
                        width: 595.276, height: 841.89, rotation: 0, userUnit: 1,
                        viewBox: [0, 0, 595.276, 841.89], mediaBox: null,
                        viewportTransform: [1, 0, 0, -1, 0, 841.89],
                    },
                },
                render: {
                    mode: 'pdf-region', assetPath: 'generated/figure.png',
                    range: { from, to: from + image.length },
                    captionRanges: [{ from: from + 2, to: from + 2 + alt.length }],
                },
            }],
        },
    };
}

test('binds complete visible caption text and independent geometry to exact PDF and Markdown hashes', async () => {
    const document = captionDocument();
    const before = structuredClone(document);
    const evidence = await createPDFCaptionEvidence(document);

    assert.deepEqual(evidence, {
        sourceHash: document.sourceHash,
        markdownHash: document.figureMap.markdownHash,
        captions: [{
            text: 'Figure 4 | Complete caption with w_{1}, \\ldots, w_{k}.',
            pageIndex: 6,
            captionBBox: [100, 350, 900, 460],
            visualBBox: [135, 95, 860, 335],
            coordinateFrame: 'display-cropbox',
            rotation: 0,
            pdfGeometry: document.figureMap.figures[0].provenance.pdfGeometry,
        }],
    });
    assert.deepEqual(document, before);
    assert.notEqual(evidence.captions[0].captionBBox, document.figureMap.figures[0].captionBBox);
    assert.ok(Object.isFrozen(evidence.captions[0].pdfGeometry.viewBox));
});

test('accepts contiguous caption ranges only when they cover the complete caption fragment', async () => {
    const document = captionDocument();
    const figure = document.figureMap.figures[0];
    const { from, to } = figure.render.captionRanges[0];
    figure.render.captionRanges = [{ from, to: from + 8 }, { from: from + 8, to }];
    assert.ok(await createPDFCaptionEvidence(document));
    figure.render.captionRanges[0].to--;
    assert.equal(await createPDFCaptionEvidence(document), null);
});

test('rejects absent, stale, and malformed identity without treating labels as proof', async () => {
    for (const mutate of [
        document => { document.sourceHash = ''; },
        document => { document.sourceHash = 'z'.repeat(64); },
        document => { document.figureMap.markdownHash = null; },
        document => { document.figureMap.markdownHash = 'b'.repeat(64); },
        document => { document.markdown += '\nRevised'; },
        document => { document.figureMap = null; },
        document => { document.figureMap.version = 2; },
    ]) {
        const document = captionDocument();
        mutate(document);
        assert.equal(await createPDFCaptionEvidence(document), null);
    }
});

test('requires an actual image anchor, full caption fragment, independent panel, and matching geometry', async () => {
    for (const mutate of [
        figure => { figure.provenance.fragments = []; },
        figure => { figure.provenance.fragments[1].role = 'body'; },
        figure => { figure.provenance.fragments[1].markdown = 'Figure 4 |'; },
        figure => { figure.provenance.fragments[1].markdown += ' omitted body'; },
        figure => { figure.provenance.fragments[1].bbox = [100, 351, 900, 460]; },
        figure => { figure.provenance.fragments[0].role = 'unknown'; },
        figure => { figure.panels = []; },
        figure => { figure.panels[0].blockId = 'missing'; },
        figure => { figure.provenance.fragments[0].markdown = 'ordinary body text'; },
        figure => { figure.provenance.fragments[0].markdown = '![Panel](images/wrong.png)'; },
        figure => { figure.provenance.fragments[1].blockId = null; figure.memberBlockIds[1] = null; },
        figure => { figure.provenance.fragments.push({ blockId: 'body', role: 'body', bbox: [...figure.captionBBox], markdown: 'Body.' }); },
        figure => { figure.visualBBox = [...figure.captionBBox]; },
        figure => { figure.render.range.from = 0; },
        figure => { figure.render.assetPath = 'images/other.png'; },
        figure => { figure.render.captionRanges[0].from++; },
        figure => { figure.render.captionRanges[0].to--; },
        figure => { figure.provenance.coordinateFrame = 'unknown'; },
        figure => { figure.provenance.rotation = 90; },
        figure => { figure.provenance.pdfGeometry.width = NaN; },
        figure => { figure.provenance.pdfGeometry.width++; },
        figure => { figure.provenance.pdfGeometry.viewportTransform[5]++; },
        figure => { figure.provenance.pdfGeometry.viewBox = [0, 0, 0, 10]; },
        figure => { figure.captionPageIndex = 7; },
        figure => { figure.captionPageIndex = '6'; },
    ]) {
        const document = captionDocument();
        const figure = document.figureMap.figures[0];
        figure.label = 'Figure 4 | trusted';
        figure.provenance.evidence = ['exact-source-ranges', 'verified-panel-pixels'];
        mutate(figure);
        assert.equal(await createPDFCaptionEvidence(document), null, mutate.toString());
    }
});

test('omits ineligible figures while preserving independently verified captions', async () => {
    const document = captionDocument();
    const bad = structuredClone(document.figureMap.figures[0]);
    bad.id = 'fig-p7-b65';
    bad.provenance.fragments[1].role = 'body';
    document.figureMap.figures.unshift(bad);
    const evidence = await createPDFCaptionEvidence(document);
    assert.equal(evidence.captions.length, 1);
});

test('rejects resource budgets before hashing or parsing large documents', async () => {
    let hashes = 0;
    const hash = async bytes => {
        hashes++;
        return createHash('sha256').update(bytes).digest('hex');
    };
    const oversized = captionDocument();
    oversized.markdown = 'x'.repeat(8 * 1024 * 1024 + 1);
    assert.equal(await createPDFCaptionEvidence(oversized, { hash }), null);
    const unicode = captionDocument();
    unicode.markdown = '图'.repeat(3 * 1024 * 1024);
    assert.equal(await createPDFCaptionEvidence(unicode, { hash }), null);
    const figures = captionDocument();
    figures.figureMap.figures = Array(257).fill(figures.figureMap.figures[0]);
    assert.equal(await createPDFCaptionEvidence(figures, { hash }), null);
    const text = captionDocument('Figure 1 | ' + 'x'.repeat(200_001));
    assert.equal(await createPDFCaptionEvidence(text, { hash }), null);
    const fragments = captionDocument();
    fragments.figureMap.figures[0].provenance.fragments = Array(513).fill({});
    assert.equal(await createPDFCaptionEvidence(fragments, { hash }), null);
    assert.equal(hashes, 0);
});

test('matches the PDF evidence limits at 64 captions, 8192 characters each, and 65536 total', async () => {
    function collection(count, length) {
        const document = captionDocument('Figure 1 | ' + 'x'.repeat(length - 'Figure 1 | '.length));
        const source = document.figureMap.figures[0];
        const image = document.markdown.slice(source.render.range.from, source.render.range.to);
        const figures = [];
        let markdown = '';
        for (let index = 0; index < count; index++) {
            const figure = structuredClone(source);
            const delta = markdown.length - figure.render.range.from;
            figure.render.range.from += delta;
            figure.render.range.to += delta;
            for (const range of figure.render.captionRanges) {
                range.from += delta;
                range.to += delta;
            }
            figures.push(figure);
            markdown += image + '\n\n';
        }
        return {
            ...document, markdown,
            figureMap: { ...document.figureMap, figures, markdownHash: createHash('sha256').update(markdown).digest('hex') },
        };
    }
    assert.equal((await createPDFCaptionEvidence(collection(64, 32))).captions.length, 64);
    assert.equal(await createPDFCaptionEvidence(collection(65, 32)), null);
    assert.equal((await createPDFCaptionEvidence(collection(1, 8192))).captions[0].text.length, 8192);
    assert.equal(await createPDFCaptionEvidence(collection(1, 8193)), null);
    assert.equal((await createPDFCaptionEvidence(collection(8, 8192))).captions.length, 8);
    assert.equal(await createPDFCaptionEvidence(collection(9, 8192)), null);
});

test('reuses validation only for the same map, Markdown, PDF identity, and unchanged proof', async () => {
    let hashes = 0;
    const hash = async bytes => {
        hashes++;
        return createHash('sha256').update(bytes).digest('hex');
    };
    const document = captionDocument();
    const first = await createPDFCaptionEvidence(document, { hash });
    assert.equal(await createPDFCaptionEvidence(document, { hash }), first);
    assert.equal(hashes, 1);
    document.sourceHash = 'b'.repeat(64);
    const second = await createPDFCaptionEvidence(document, { hash });
    assert.notEqual(second, first);
    assert.equal(second.sourceHash, document.sourceHash);
    assert.equal(hashes, 2);
    document.figureMap.figures[0].render.captionRanges[0].to--;
    assert.equal(await createPDFCaptionEvidence(document, { hash }), null);
    document.markdown += ' new';
    assert.equal(await createPDFCaptionEvidence(document, { hash }), null);
});

test('fails closed when SHA-256 is unavailable', async () => {
    assert.equal(await createPDFCaptionEvidence(captionDocument(), {
        hash: async () => { throw new Error('unavailable'); },
    }), null);
});
