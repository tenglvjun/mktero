import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFigureInput } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';

test('binds duplicate axes to their own image windows and leaves prose independent', () => {
    const { input, label, bodyText } = makeFigureInput({ repeated: true });
    const before = structuredClone(input);
    const bound = bindFigureSourceRanges(input);
    const axes = bound.blocks.filter(block => block.role === 'figure-text');
    assert.equal(axes.length, 2);
    for (const axis of axes) {
        assert.equal(axis.sourceRanges.length, 1);
        const range = axis.sourceRanges[0];
        assert.equal(bound.markdown.slice(range.from, range.to), label);
    }
    assert.notDeepEqual(axes[0].sourceRanges, axes[1].sourceRanges);
    const body = bound.blocks.find(block => block.role === 'body');
    assert.equal(bound.markdown.slice(body.sourceRanges[0].from, body.sourceRanges[0].to), bodyText);
    assert.deepEqual(input, before);
});

test('refuses code images, partial paragraphs and ambiguous repeated paths', () => {
    const { input } = makeFigureInput();
    input.markdown = '```md\n![](images/panel-0.png)\n```\n\n'
        + 'A paragraph contains Time since treatment (days) and more prose.\n\n'
        + '![](images/panel-1.png)\n\n![](images/panel-1.png)';
    input.pages[0].markdownRange = { from: 0, to: input.markdown.length };
    const bound = bindFigureSourceRanges(input);
    assert.deepEqual(bound.blocks.find(block => block.assetPath === 'images/panel-0.png').sourceRanges, []);
    assert.deepEqual(bound.blocks.find(block => block.assetPath === 'images/panel-1.png').sourceRanges, []);
    assert.deepEqual(bound.blocks.find(block => block.role === 'figure-text').sourceRanges, []);
});

test('binds normalized line breaks and Unicode while preserving original UTF-16 ranges', () => {
    const { input } = makeFigureInput();
    const axis = input.blocks.find(block => block.role === 'figure-text');
    input.markdown = input.markdown.replace(axis.text, 'Ａxis **label**\r\nvalues 🧪');
    axis.text = 'Axis label values 🧪';
    input.pages[0].markdownRange.to = input.markdown.length;
    const bound = bindFigureSourceRanges(input);
    const range = bound.blocks.find(block => block.id === axis.id).sourceRanges[0];
    assert.equal(input.markdown.slice(range.from, range.to), 'Ａxis **label**\r\nvalues 🧪');
});

test('does not trust a provider range that points to different text', () => {
    const { input } = makeFigureInput();
    const axis = input.blocks.find(block => block.role === 'figure-text');
    axis.sourceRanges = [{ from: 0, to: 20 }];
    axis.rangeEvidence = 'explicit-range';
    const bound = bindFigureSourceRanges(input);
    const range = bound.blocks.find(block => block.id === axis.id).sourceRanges[0];
    assert.equal(input.markdown.slice(range.from, range.to), axis.text);
});

test('preserves unbound text when source matching work is exhausted', () => {
    const { input } = makeFigureInput();
    const bound = bindFigureSourceRanges(input, { limits: { maxComparisons: 0 } });
    assert.ok(bound.blocks.every(block => block.sourceRanges.length === 0));
    assert.equal(bound.markdown, input.markdown);
});

test('does not consume a unique paragraph outside its image anchor window', () => {
    const { input } = makeFigureInput();
    const axis = input.blocks.find(block => block.role === 'figure-text');
    input.markdown = input.markdown.replace(axis.text, '') + '\n\n' + axis.text;
    input.pages[0].markdownRange = null;
    const bound = bindFigureSourceRanges(input);
    assert.deepEqual(bound.blocks.find(block => block.id === axis.id).sourceRanges, []);
});

test('leaves duplicate provider blocks unresolved instead of consuming one image twice', () => {
    const { input } = makeFigureInput();
    const panel = input.blocks.find(block => block.role === 'panel');
    input.blocks.push({ ...panel, id: panel.id + '-duplicate', sourceOrdinal: 100 });
    const bound = bindFigureSourceRanges(input);
    assert.ok(bound.blocks.filter(block => block.assetPath === panel.assetPath)
        .every(block => block.sourceRanges.length === 0));
});

test('does not bind missing figure text to a later page when only one image bounds it', () => {
    const { input } = makeFigureInput({ boxes: [[100, 100, 900, 800]] });
    const axis = input.blocks.find(block => block.role === 'figure-text');
    axis.text = 'Accuracy';
    input.markdown = '![](images/panel-0.png)\n\n# Page 2\n\nAccuracy';
    input.pages[0].markdownRange = null;
    input.pages.push({ pageIndex: 1, coordinateFrame: 'unknown', markdownRange: null });
    const bound = bindFigureSourceRanges(input);
    assert.deepEqual(bound.blocks.find(block => block.id === axis.id).sourceRanges, []);
    assert.equal(bound.markdown, input.markdown);
});

test('uses a heading as a page boundary only when its source range is explicit', () => {
    const { input } = makeFigureInput({ boxes: [[100, 100, 900, 800]], interleave: false });
    const caption = input.blocks.find(block => block.role === 'caption');
    input.pages[0].markdownRange = null;
    input.markdown += '\n\n# Results';
    input.blocks.push({ id: 'heading', sourceOrdinal: 10, pageIndex: 0,
        type: 'heading', role: 'body', text: 'Results', sourceRanges: [] });
    assert.deepEqual(bindFigureSourceRanges(input).blocks.find(block => block.id === caption.id).sourceRanges, []);
    input.blocks.at(-1).sourceRanges = [{ from: input.markdown.indexOf('# Results'), to: input.markdown.length }];
    const bound = bindFigureSourceRanges(input);
    const range = bound.blocks.find(block => block.id === caption.id).sourceRanges[0];
    assert.equal(input.markdown.slice(range.from, range.to), caption.text);
    input.blocks.at(-1).pageIndex = 1;
    assert.deepEqual(bindFigureSourceRanges(input).blocks.find(block => block.id === caption.id).sourceRanges, []);
});

test('never uses a globally unique heading to bind later-page prose to missing figure text', () => {
    const { input } = makeFigureInput({ boxes: [[100, 100, 900, 800]] });
    const axis = input.blocks.find(block => block.role === 'figure-text');
    axis.text = 'Accuracy';
    input.markdown = '![](images/panel-0.png)\n\nAccuracy\n\n# Results';
    input.pages[0].markdownRange = null;
    input.pages.push({ pageIndex: 1, coordinateFrame: 'unknown', markdownRange: null });
    input.blocks.push({ id: 'heading', sourceOrdinal: 10, pageIndex: 0,
        type: 'heading', role: 'body', text: 'Results', sourceRanges: [] });
    const bound = bindFigureSourceRanges(input);
    assert.deepEqual(bound.blocks.find(block => block.id === axis.id).sourceRanges, []);
    assert.deepEqual(bound.blocks.find(block => block.id === 'heading').sourceRanges, []);
});
