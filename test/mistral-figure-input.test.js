import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { decodeMistralResult, prepareMistralResult } from '../src/mistral/mistral-result.js';
import { MISTRAL_OCR_MODEL_ID } from '../src/mistral/parser-profile.js';

function response() {
    return { pages: [{ index: 0, dimensions: { width: 1000, height: 1000 },
        markdown: '![](img-0.png)\n\nAccuracy\n\nFigure 1. Results.',
        images: [{ id: 'img-0.png', image_base64: 'data:image/png;base64,'
            + Buffer.from(createTestPNG()).toString('base64') }],
        blocks: [
            { type: 'image', image_id: 'img-0.png', bbox: [100, 100, 900, 700] },
            { type: 'text', content: 'Accuracy', bbox: [200, 200, 350, 230] },
            { type: 'caption', content: 'Figure 1. Results.', bbox: [100, 750, 900, 800] },
        ],
    }] };
}

test('keeps image interior OCR evidence until a rendering transaction consumes it', () => {
    const input = decodeMistralResult(response());
    assert.match(input.markdown, /Accuracy/u);
    assert.ok(input.blocks.some(block => block.text === 'Accuracy'));
    assert.equal(input.blocks.find(block => block.type === 'image').bboxKind, 'visual-body');
    assert.ok(prepareMistralResult(input).markdown.includes('Accuracy'));
});

test('uses the current FigureInput Markdown when preparing a restored document', () => {
    const input = decodeMistralResult(response());
    input.markdown = 'Updated text.';
    input.pages[0].markdownRange = { from: 0, to: input.markdown.length };
    input.blocks = [];
    input.contentList = [];
    const prepared = prepareMistralResult(input);
    assert.equal(prepared.markdown, 'Updated text.');
    assert.equal(prepared.providerState, undefined);
    assert.equal(prepared.blocks, undefined);
});

test('does not choose between contradictory image metadata and block boxes', () => {
    const raw = response();
    raw.pages[0].images[0].bbox = [100, 100, 400, 400];
    const image = decodeMistralResult(raw).blocks.find(block => block.type === 'image');
    assert.equal(image.bbox, null);
    assert.equal(image.bboxKind, 'unknown');
});

test('retains text without geometry and keeps original block ordinals', () => {
    const raw = response();
    raw.pages[0].blocks.unshift(null);
    delete raw.pages[0].blocks[2].bbox;
    const input = decodeMistralResult(raw);
    const axis = input.blocks.find(block => block.text === 'Accuracy');
    assert.ok(axis);
    assert.equal(axis.bbox, null);
    assert.equal(axis.sourceOrdinal, 2);
    assert.equal(axis.id, 'mistral:p0:b2');
    assert.match(prepareMistralResult(input).markdown, /Accuracy/u);
});

test('keeps repeated interior text and prose in separate physical page ranges', () => {
    const raw = response();
    raw.pages.push({ ...response().pages[0], index: 1 });
    const input = decodeMistralResult(raw);
    for (const page of input.pages) {
        const source = input.markdown.slice(page.markdownRange.from, page.markdownRange.to);
        assert.match(source, /Accuracy/u);
        assert.ok(input.blocks.some(block => block.pageIndex === page.pageIndex
            && block.text === 'Accuracy'));
    }
    assert.ok(input.assets.some(asset => asset.path === 'pages/1/img-0.png'));
});

test('preserves layout content when a response model is not the configured OCR model', () => {
    const raw = response();
    raw.model = 'unverified-ocr-999';
    const input = decodeMistralResult(raw);
    assert.equal(input.pages[0].coordinateFrame, 'unknown');
    assert.equal(input.pages[0].geometryReason, 'unsupported-layout-schema');
    assert.ok(input.blocks.some(block => block.type === 'image'));
});

test('does not infer displayed CropBox orientation from the model, dimensions or DPI', () => {
    for (const model of [undefined, MISTRAL_OCR_MODEL_ID]) {
        const raw = response();
        raw.model = model;
        raw.pages[0].dimensions.dpi = 72;
        const input = decodeMistralResult(raw);
        assert.equal(input.pages[0].coordinateFrame, 'unknown');
        assert.equal(input.pages[0].geometryReason, 'missing-geometry');
        assert.match(prepareMistralResult(input).markdown, /Accuracy/u);
    }
});
