import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';

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

test('binds a unique interior text block outside its image anchor window', () => {
    const { input } = makeFigureInput();
    const axis = input.blocks.find(block => block.role === 'figure-text');
    input.markdown = input.markdown.replace(axis.text, '') + '\n\n' + axis.text;
    input.pages[0].markdownRange = null;
    const bound = bindFigureSourceRanges(input);
    const range = bound.blocks.find(block => block.id === axis.id).sourceRanges[0];
    assert.equal(input.markdown.slice(range.from, range.to), axis.text);
});

test('leaves duplicate provider blocks unresolved instead of consuming one image twice', () => {
    const { input } = makeFigureInput();
    const panel = input.blocks.find(block => block.role === 'panel');
    input.blocks.push({ ...panel, id: panel.id + '-duplicate', sourceOrdinal: 100 });
    const bound = bindFigureSourceRanges(input);
    assert.ok(bound.blocks.filter(block => block.assetPath === panel.assetPath)
        .every(block => block.sourceRanges.length === 0));
});

test('binds unique interior text whose only paragraph follows a later-page heading', () => {
    const { input } = makeFigureInput({ boxes: [[100, 100, 900, 800]] });
    const axis = input.blocks.find(block => block.role === 'figure-text');
    axis.text = 'Accuracy';
    input.markdown = '![](images/panel-0.png)\n\n# Page 2\n\nAccuracy';
    input.pages[0].markdownRange = null;
    input.pages.push({ pageIndex: 1, coordinateFrame: 'unknown', markdownRange: null });
    const bound = bindFigureSourceRanges(input);
    const range = bound.blocks.find(block => block.id === axis.id).sourceRanges[0];
    assert.equal(input.markdown.slice(range.from, range.to), 'Accuracy');
    assert.equal(bound.markdown, input.markdown);
});

test('binds a unique caption contained in its figure group without a page boundary', () => {
    const { input } = makeFigureInput({ boxes: [[100, 100, 900, 800]], interleave: false });
    const caption = input.blocks.find(block => block.role === 'caption');
    input.pages[0].markdownRange = null;
    input.markdown += '\n\n# Results';
    input.blocks.push({ id: 'heading', sourceOrdinal: 10, pageIndex: 0,
        type: 'heading', role: 'body', text: 'Results', sourceRanges: [] });
    const bound = bindFigureSourceRanges(input);
    const range = bound.blocks.find(block => block.id === caption.id).sourceRanges[0];
    assert.equal(input.markdown.slice(range.from, range.to), caption.text);
    assert.deepEqual(bound.blocks.find(block => block.id === 'heading').sourceRanges, []);
    input.blocks.at(-1).pageIndex = 1;
    const moved = bindFigureSourceRanges(input);
    const movedRange = moved.blocks.find(block => block.id === caption.id).sourceRanges[0];
    assert.equal(input.markdown.slice(movedRange.from, movedRange.to), caption.text);
});

test('binds figure text contained in one image group when Markdown interleaves it', () => {
    const markdown = [
        'Figure 1. Study flowchart.',
        '',
        '68 women assessed for eligibility',
        '',
        '![](images/flowchart.png)',
        '',
        '66 women enrolled',
        '',
        'Body text outside the figure.',
    ].join('\n');
    const block = (sourceOrdinal, value) => ({
        id: `mineru:p0:b${sourceOrdinal}`, sourceOrdinal, pageIndex: 0,
        text: '', sourceRanges: [], rangeEvidence: 'unresolved', ...value,
    });
    const input = {
        provider: 'mineru', markdown, assetBasePath: '',
        assets: [{ path: 'images/flowchart.png', mimeType: 'image/png', data: createTestPNG() }],
        blocks: [
            block(0, { type: 'image', role: 'unknown', bboxKind: 'group',
                bbox: [100, 100, 900, 900] }),
            block(1, { type: 'caption', role: 'caption', bboxKind: 'caption',
                bbox: [150, 100, 850, 150], parentId: 'mineru:p0:b0',
                text: 'Figure 1. Study flowchart.' }),
            block(2, { type: 'text', role: 'figure-text', bboxKind: 'text',
                bbox: [200, 250, 800, 320], parentId: 'mineru:p0:b0',
                text: '68 women assessed for eligibility' }),
            block(3, { type: 'image', role: 'panel', bboxKind: 'visual-body',
                bbox: [100, 200, 900, 800], parentId: 'mineru:p0:b0',
                assetPath: 'images/flowchart.png' }),
            block(4, { type: 'text', role: 'figure-text', bboxKind: 'text',
                bbox: [300, 700, 700, 760], parentId: 'mineru:p0:b0',
                text: '66 women enrolled' }),
            block(5, { type: 'text', role: 'body', bboxKind: 'text',
                bbox: [100, 930, 900, 970], text: 'Body text outside the figure.' }),
        ],
        pages: [{ pageIndex: 0, width: 600, height: 800, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0, markdownRange: null }],
        contentList: [], providerState: {},
    };
    const bound = bindFigureSourceRanges(input);
    const byId = new Map(bound.blocks.map(entry => [entry.id, entry]));
    for (const id of ['mineru:p0:b1', 'mineru:p0:b2', 'mineru:p0:b4']) {
        assert.equal(byId.get(id).rangeEvidence, 'unique-text', id);
        const range = byId.get(id).sourceRanges[0];
        assert.equal(markdown.slice(range.from, range.to), byId.get(id).text);
    }
    assert.deepEqual(byId.get('mineru:p0:b5').sourceRanges, []);
    const candidates = resolveFigureCandidates(bound);
    assert.equal(candidates[0].decision, 'compose');
    assert.deepEqual(candidates[0].ownedTextBlockIds, ['mineru:p0:b2', 'mineru:p0:b4']);
    assert.deepEqual(candidates[0].captionBlockIds, ['mineru:p0:b1']);
});

test('does not use a globally unique heading to bind figure text or headings without page bounds', () => {
    const { input } = makeFigureInput({ boxes: [[100, 100, 900, 800]] });
    const axis = input.blocks.find(block => block.role === 'figure-text');
    axis.text = 'Accuracy';
    input.markdown = '![](images/panel-0.png)\n\nAccuracy\n\n# Results';
    input.pages[0].markdownRange = null;
    input.pages.push({ pageIndex: 1, coordinateFrame: 'unknown', markdownRange: null });
    input.blocks.push({ id: 'heading', sourceOrdinal: 10, pageIndex: 0,
        type: 'heading', role: 'body', text: 'Results', sourceRanges: [] });
    const bound = bindFigureSourceRanges(input);
    const range = bound.blocks.find(block => block.id === axis.id).sourceRanges[0];
    assert.equal(input.markdown.slice(range.from, range.to), 'Accuracy');
    assert.deepEqual(bound.blocks.find(block => block.id === 'heading').sourceRanges, []);
});

test('binds a repeated panel label to the paragraph adjacent to its own panel', () => {
    const markdown = [
        'A',
        '',
        '![](images/a.png)',
        '',
        'Body text between figures.',
        '',
        'A',
        '',
        '![](images/b.png)',
    ].join('\n');
    const block = (id, sourceOrdinal, value) => ({
        id, sourceOrdinal, pageIndex: 0,
        text: '', sourceRanges: [], rangeEvidence: 'unresolved', ...value,
    });
    const input = {
        provider: 'mineru', markdown, assetBasePath: '',
        assets: [
            { path: 'images/a.png', mimeType: 'image/png', data: createTestPNG() },
            { path: 'images/b.png', mimeType: 'image/png', data: createTestPNG() },
        ],
        blocks: [
            block('p0', 0, { type: 'image', role: 'unknown', bboxKind: 'group',
                bbox: [100, 100, 400, 300] }),
            block('label0', 1, { type: 'caption', role: 'caption', bboxKind: 'caption',
                bbox: [110, 80, 130, 95], parentId: 'p0', text: 'A' }),
            block('panel0', 2, { type: 'image', role: 'panel', bboxKind: 'visual-body',
                bbox: [100, 100, 400, 300], assetPath: 'images/a.png', parentId: 'p0' }),
            block('p1', 3, { type: 'image', role: 'unknown', bboxKind: 'group',
                bbox: [100, 500, 400, 700] }),
            block('label1', 4, { type: 'caption', role: 'caption', bboxKind: 'caption',
                bbox: [110, 480, 130, 495], parentId: 'p1', text: 'A' }),
            block('panel1', 5, { type: 'image', role: 'panel', bboxKind: 'visual-body',
                bbox: [100, 500, 400, 700], assetPath: 'images/b.png', parentId: 'p1' }),
        ],
        pages: [{ pageIndex: 0, width: 600, height: 800, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0, markdownRange: null }],
        contentList: [], providerState: {},
    };
    const bound = bindFigureSourceRanges(input);
    const first = bound.blocks.find(entry => entry.id === 'label0');
    const second = bound.blocks.find(entry => entry.id === 'label1');
    assert.equal(first.rangeEvidence, 'anchored-sequence');
    assert.equal(markdown.slice(first.sourceRanges[0].from, first.sourceRanges[0].to), 'A');
    assert.equal(markdown.slice(second.sourceRanges[0].from, second.sourceRanges[0].to), 'A');
    assert.ok(first.sourceRanges[0].to < second.sourceRanges[0].from);
});

test('binds a caption merged into the tail of a body paragraph without changing the Markdown', () => {
    const caption = 'Figure 2: Construction of a reusable task and its data-bound '
        + 'instances across heterogeneous recordings.';
    const markdown = [
        '![](images/panel.png)',
        '',
        'A task is converted into executable evaluation examples by binding its specification '
            + 'to a concrete data context. Each resulting instance identifies the dataset ' + caption,
        '',
        'and recording to be analyzed, together with the applicable time window.',
    ].join('\n');
    const input = {
        provider: 'mineru', markdown,
        assets: [{ path: 'images/panel.png', mimeType: 'image/png', data: createTestPNG() }],
        assetBasePath: '', contentList: [], providerState: {},
        blocks: [
            { id: 'mineru:p0:b0', sourceOrdinal: 0, pageIndex: 0, type: 'image',
                role: 'unknown', bboxKind: 'group', bbox: [100, 100, 900, 950], text: '' },
            { id: 'mineru:p0:b1', sourceOrdinal: 1, pageIndex: 0, type: 'image',
                role: 'panel', bboxKind: 'visual-body', bbox: [100, 100, 500, 400],
                assetPath: 'images/panel.png', parentId: 'mineru:p0:b0', text: '' },
            { id: 'mineru:p0:b2', sourceOrdinal: 2, pageIndex: 0, type: 'text',
                role: 'caption', bboxKind: 'text', bbox: [100, 420, 500, 450],
                embeddedCaption: true, text: caption },
        ],
        pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0,
            geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
    };
    const bound = bindFigureSourceRanges(input);
    const range = bound.blocks.find(block => block.id === 'mineru:p0:b2').sourceRanges[0];
    assert.equal(markdown.slice(range.from, range.to), caption);
    assert.equal(bound.markdown, markdown);
    const candidates = resolveFigureCandidates(bound);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].label, 'Figure 2:');
});
