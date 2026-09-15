import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';

test('owns all panels and internal text while keeping outside prose independent', () => {
    const { input } = makeFigureInput();
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].panelBlockIds.length, 4);
    assert.equal(candidates[0].ownedTextBlockIds.length, 1);
    assert.deepEqual(candidates[0].visualBBox, [98, 98, 902, 852]);
});

test('does not crop missing panel geometry', () => {
    const { input } = makeFigureInput();
    const bound = bindFigureSourceRanges(input);
    delete bound.blocks.find(block => block.role === 'panel').bbox;
    assert.equal(resolveFigureCandidates(bound)[0].decision, 'preserve');
});

test('composes without consuming internal text that is missing from the Markdown', () => {
    const { input } = makeFigureInput();
    const bound = bindFigureSourceRanges(input);
    const text = bound.blocks.find(block => block.role === 'figure-text');
    text.sourceRanges = [];
    const candidate = resolveFigureCandidates(bound)[0];
    assert.equal(candidate.decision, 'compose');
    assert.ok(!candidate.ownedTextBlockIds.includes(text.id));
});

test('preserves groups overlapping a caption, body paragraph, table or unknown long text', () => {
    for (const kind of ['caption', 'body', 'table', 'unknown']) {
        const { input } = makeFigureInput();
        const bound = bindFigureSourceRanges(input);
        const block = kind === 'caption' ? bound.blocks.at(-1)
            : bound.blocks.find(block => block.role === 'body');
        block.bbox = [400, 420, 600, 480];
        if (kind === 'table') block.type = 'table';
        if (kind === 'unknown') {
            block.role = 'unknown';
            block.text = 'An ordinary explanatory sentence that belongs to the main article.';
        }
        assert.equal(resolveFigureCandidates(bound)[0].decision, 'preserve', kind);
    }
});

test('finds independent geometric groups alongside an explicit parent group', () => {
    const { input } = makeFigureInput();
    const extra = makeFigureInput({ parent: false, interleave: false, boxes: [[100, 100, 900, 800]] }).input;
    const offset = input.markdown.length + 2;
    input.markdown += '\n\n' + extra.markdown.replace('Figure 1.', 'Figure 2.');
    input.pages.push({ ...extra.pages[0], pageIndex: 1,
        markdownRange: { from: offset, to: input.markdown.length } });
    for (const block of extra.blocks) {
        input.blocks.push({ ...block, id: block.id + ':page1', pageIndex: 1,
            text: block.text?.replace('Figure 1.', 'Figure 2.') });
    }
    const groups = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(groups.length, 2);
    assert.ok(groups.every(group => group.decision === 'compose'));
    assert.deepEqual(groups.map(group => group.pageIndex), [0, 1]);
});

test('preserves shared legends only when geometry and text shape agree', () => {
    const { input } = makeFigureInput();
    const axis = input.blocks.find(block => block.role === 'figure-text');
    input.markdown = input.markdown.replace(axis.text, 'Control');
    axis.text = 'Control';
    axis.parentId = null;
    axis.role = 'unknown';
    axis.bbox = [460, 410, 530, 440];
    input.pages[0].markdownRange.to = input.markdown.length;
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.deepEqual(candidate.ownedTextBlockIds, [axis.id]);
});

test('retains a deterministic preserved candidate when geometric work exceeds its budget', () => {
    const { input } = makeFigureInput({ parent: false });
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input), {
        limits: { maxComparisons: 0 },
    });
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every(candidate => candidate.decision === 'preserve'));
    assert.ok(candidates.some(candidate => candidate.reason === 'resource-limit'));
});

test('preserves conflicting parent geometry and unknown text without a box', () => {
    for (const change of [
        input => { input.blocks[0].bbox = [100, 100, 200, 200]; },
        input => { const text = input.blocks.find(block => block.role === 'figure-text');
            text.role = 'unknown'; text.bbox = null; },
    ]) {
        const { input } = makeFigureInput();
        change(input);
        assert.equal(resolveFigureCandidates(bindFigureSourceRanges(input))[0].decision, 'preserve');
    }
});

test('keeps the resource-limit summary inside the candidate budget across pages', () => {
    for (const maxFigures of [1, 3, 1000]) {
        const input = { pages: [], blocks: [] };
        for (let pageIndex = 0; pageIndex <= maxFigures; pageIndex++) {
            input.pages.push({ pageIndex, coordinateFrame: 'unknown' });
            input.blocks.push({ id: `p${pageIndex}`, pageIndex, sourceOrdinal: 0,
                type: 'image', role: 'panel', bboxKind: 'unknown', assetPath: 'images/p.png' });
        }
        const candidates = resolveFigureCandidates(input, { limits: { maxFigures } });
        assert.equal(candidates.length, maxFigures);
        assert.equal(candidates.at(-1).reason, 'resource-limit');
    }
});

test('attaches a nearby parentless caption to its parent figure group', () => {
    const { input } = makeFigureInput();
    const caption = input.blocks.find(block => block.role === 'caption');
    caption.parentId = null;
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.deepEqual(candidates[0].captionBlockIds, [caption.id]);
});

test('preserves a shared caption claimed by two nearby groups', () => {
    const markdown = [
        '![](images/a.png)',
        '',
        '![](images/b.png)',
        '',
        'Figure 1. Shared caption.',
    ].join('\n');
    const block = (id, value) => ({
        id, sourceOrdinal: Number(id.slice(1)), pageIndex: 0,
        text: '', sourceRanges: [], rangeEvidence: 'unresolved', ...value,
    });
    const input = {
        provider: 'mineru', markdown, assetBasePath: '',
        assets: [
            { path: 'images/a.png', mimeType: 'image/png', data: createTestPNG() },
            { path: 'images/b.png', mimeType: 'image/png', data: createTestPNG() },
        ],
        blocks: [
            block('b0', { type: 'image', role: 'panel', bboxKind: 'visual-body',
                bbox: [100, 100, 300, 300], assetPath: 'images/a.png' }),
            block('b1', { type: 'caption', role: 'caption', bboxKind: 'caption',
                bbox: [100, 330, 300, 440], text: 'Figure 1. Shared caption.' }),
            block('b2', { type: 'image', role: 'panel', bboxKind: 'visual-body',
                bbox: [100, 470, 300, 670], assetPath: 'images/b.png' }),
        ],
        pages: [{ pageIndex: 0, width: 600, height: 800, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0, markdownRange: null }],
        contentList: [], providerState: {},
    };
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(candidate => candidate.decision === 'preserve'));
    assert.ok(candidates.every(candidate => candidate.reason === 'ambiguous-caption'));
});

test('prefers a sibling academic caption over an explicit panel label', () => {
    const caption = 'Figure A6: Open-loop rollouts on Wall and Maze tasks.';
    const markdown = [
        '![](images/panel.png)',
        '',
        caption,
    ].join('\n');
    const input = {
        provider: 'mineru', markdown,
        assets: [{ path: 'images/panel.png', mimeType: 'image/png', data: createTestPNG() }],
        assetBasePath: '', contentList: [], providerState: {},
        blocks: [
            { id: 'mineru:p0:b0', sourceOrdinal: 0, pageIndex: 0, type: 'image',
                role: 'unknown', bboxKind: 'group', bbox: [100, 100, 900, 950], text: '' },
            { id: 'mineru:p0:b1', sourceOrdinal: 1, pageIndex: 0, type: 'image',
                role: 'panel', bboxKind: 'visual-body', bbox: [100, 100, 500, 300],
                assetPath: 'images/panel.png', parentId: 'mineru:p0:b0', text: '' },
            { id: 'mineru:p0:b2', sourceOrdinal: 2, pageIndex: 0, type: 'text',
                role: 'caption', bboxKind: 'text', bbox: [110, 306, 200, 318],
                parentId: 'mineru:p0:b0', text: '(a) Wall' },
            { id: 'mineru:p0:b3', sourceOrdinal: 3, pageIndex: 0, type: 'text',
                role: 'caption', bboxKind: 'text', bbox: [100, 560, 500, 580], text: caption },
        ],
        pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0,
            geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
    };
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].label, 'Figure A6:');
    assert.deepEqual(candidates[0].captionBlockIds, ['mineru:p0:b3']);
});

function makeGapFixture(middleLine) {
    const caption = 'Figure A6: Open-loop rollouts on Wall and Maze tasks for offline model comparison.';
    const markdown = [
        '![](images/panel.png)',
        '',
        '(a) Wall',
        '',
        middleLine,
        '',
        '(b) Maze',
        '',
        caption,
    ].join('\n');
    const input = {
        provider: 'mineru', markdown,
        assets: [{ path: 'images/panel.png', mimeType: 'image/png', data: createTestPNG() }],
        assetBasePath: '', contentList: [], providerState: {},
        blocks: [
            { id: 'mineru:p0:b0', sourceOrdinal: 0, pageIndex: 0, type: 'image',
                role: 'unknown', bboxKind: 'group', bbox: [100, 100, 900, 950], text: '' },
            { id: 'mineru:p0:b1', sourceOrdinal: 1, pageIndex: 0, type: 'image',
                role: 'panel', bboxKind: 'visual-body', bbox: [100, 100, 500, 300],
                assetPath: 'images/panel.png', parentId: 'mineru:p0:b0', text: '' },
            { id: 'mineru:p0:b2', sourceOrdinal: 2, pageIndex: 0, type: 'text',
                role: 'caption', bboxKind: 'text', bbox: [110, 306, 200, 318],
                parentId: 'mineru:p0:b0', text: '(a) Wall' },
            { id: 'mineru:p0:b3', sourceOrdinal: 3, pageIndex: 0, type: 'text',
                role: 'unknown', bboxKind: 'text', bbox: [110, 400, 490, 430],
                text: middleLine },
            { id: 'mineru:p0:b4', sourceOrdinal: 4, pageIndex: 0, type: 'text',
                role: 'unknown', bboxKind: 'text', bbox: [110, 500, 200, 512],
                text: '(b) Maze' },
            { id: 'mineru:p0:b5', sourceOrdinal: 5, pageIndex: 0, type: 'text',
                role: 'caption', bboxKind: 'text', bbox: [100, 600, 500, 620], text: caption },
        ],
        pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0,
            geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
    };
    return { input, markdown };
}

test('owns legend rows between the panels and a lower caption', () => {
    const { input } = makeGapFixture('TD-MPC2\nDreamerV3');
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].label, 'Figure A6:');
    assert.deepEqual(candidates[0].ownedTextBlockIds,
        ['mineru:p0:b2', 'mineru:p0:b3', 'mineru:p0:b4']);
    assert.ok(candidates[0].visualBBox[3] >= 510,
        JSON.stringify(candidates[0].visualBBox));
});

test('keeps prose between a figure and its caption out of the crop', () => {
    const { input } = makeGapFixture('The model predicts the next frame accurately.');
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.deepEqual(candidates[0].ownedTextBlockIds, ['mineru:p0:b2']);
    assert.ok(candidates[0].visualBBox[3] < 400,
        JSON.stringify(candidates[0].visualBBox));
});
