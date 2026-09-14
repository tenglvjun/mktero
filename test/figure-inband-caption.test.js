import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';

const TITLE = 'Intervention on thinking model\nDeepseek-R1-Distill-Qwen-1.5B';
const CAPTION = 'Fig. 4 Results of Representation Intervention Experiments. (a) Illustration of the representation intervention paradigm.';

function makeInBandFigureInput({ labelBbox = [90, 100, 100, 112], gluedCaption = false,
    titleOwnLine = false } = {}) {
    const blocks = [];
    const assets = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const addPanel = (type, bbox, name, parentId) => {
        const path = `images/${name}.png`;
        assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        add({ type, role: 'panel', bboxKind: 'visual-body', bbox: [...bbox],
            assetPath: path, parentId });
        return path;
    };
    const parentA = add({ type: 'image', role: 'unknown', bboxKind: 'group', bbox: [100, 100, 300, 240] });
    const labelA = add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: 'a',
        bbox: [...labelBbox], parentId: parentA });
    const pathA = addPanel('image', [100, 100, 300, 240], 'a', parentA);
    const parentI = add({ type: 'image', role: 'unknown', bboxKind: 'group', bbox: [100, 300, 300, 460] });
    add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: 'i',
        bbox: [90, 300, 100, 312], parentId: parentI });
    const title = add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: TITLE,
        bbox: [140, 320, 280, 340], parentId: parentI });
    const pathI = addPanel('image', [100, 300, 300, 460], 'i', parentI);
    const parentB = add({ type: 'chart', role: 'unknown', bboxKind: 'group', bbox: [340, 300, 640, 460] });
    const labelB = add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: 'b',
        bbox: [330, 300, 340, 312], parentId: parentB });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: CAPTION,
        bbox: [100, 520, 900, 620], parentId: parentB });
    const pathB = addPanel('chart', [340, 300, 640, 460], 'b', parentB);
    const markdown = [
        'a', '', `![](${pathA})`, '',
        titleOwnLine ? `i\n\n${TITLE}` : `i\n${TITLE}`, '', `![](${pathI})`, '',
        gluedCaption ? `b\n${CAPTION}` : `b\n\n${CAPTION}`, '',
        `![](${pathB})`,
    ].join('\n');
    return {
        caption, title, labelA, labelB,
        input: {
            provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: [], providerState: {},
        },
    };
}

test('owns an in-band panel title instead of treating it as a foreign caption', () => {
    const { input, caption, title, labelA, labelB } = makeInBandFigureInput();
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.deepEqual(candidate.captionBlockIds, [caption]);
    assert.ok(!candidate.captionBlockIds.includes(title));
    assert.ok(candidate.ownedTextBlockIds.includes(labelA));
    assert.ok(candidate.ownedTextBlockIds.includes(labelB));
});

test('consumes an in-band panel title that has its own Markdown line', () => {
    const { input, title } = makeInBandFigureInput({ titleOwnLine: true });
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(title));
});

test('owns panel labels that sit just outside the tight panel union', () => {
    const { input, labelA } = makeInBandFigureInput({ labelBbox: [92, 94, 102, 106] });
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(labelA));
});

test('binds a caption whose label is glued to it without a blank line', () => {
    const { input, caption, labelB } = makeInBandFigureInput({ gluedCaption: true });
    const bound = bindFigureSourceRanges(input);
    const boundCaption = bound.blocks.find(block => block.id === caption);
    assert.equal(boundCaption.rangeEvidence, 'unique-text');
    const range = boundCaption.sourceRanges[0];
    assert.equal(bound.markdown.slice(range.from, range.to), CAPTION);
    const boundLabel = bound.blocks.find(block => block.id === labelB);
    assert.equal(bound.markdown.slice(boundLabel.sourceRanges[0].from,
        boundLabel.sourceRanges[0].to), 'b');
    const candidate = resolveFigureCandidates(bound)[0];
    assert.equal(candidate.decision, 'compose');
    assert.deepEqual(candidate.captionBlockIds, [caption]);
});
