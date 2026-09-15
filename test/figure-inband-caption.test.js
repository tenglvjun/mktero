import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';

const TITLE = 'Intervention on thinking model\nDeepseek-R1-Distill-Qwen-1.5B';
const CAPTION = 'Fig. 4 Results of Representation Intervention Experiments. (a) Illustration of the representation intervention paradigm.';

function makeInBandFigureInput({ labelBbox = [90, 100, 100, 112], gluedCaption = false,
    titleOwnLine = false, subCaptionText = '(i) Panel route trends.' } = {}) {
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
    const subCaption = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: subCaptionText, bbox: [150, 470, 300, 480], parentId: parentI });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: CAPTION,
        bbox: [100, 520, 900, 620], parentId: parentB });
    const pathB = addPanel('chart', [340, 300, 640, 460], 'b', parentB);
    const subText = subCaptionText;
    const markdown = [
        'a', '', `![](${pathA})`, '',
        titleOwnLine ? `i\n\n${TITLE}` : `i\n${TITLE}`, '', `![](${pathI})`, '', subText, '',
        gluedCaption ? `b\n${CAPTION}` : `b\n\n${CAPTION}`, '',
        `![](${pathB})`,
    ].join('\n');
    return {
        caption, title, labelA, labelB, subCaption,
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

function makeStackedFiguresInput() {
    const blocks = [];
    const assets = [];
    const chunks = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const addFigure = (name, panelBbox, captionText, title) => {
        const parent = add({ type: 'chart', role: 'unknown', bboxKind: 'group', bbox: [...panelBbox] });
        const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: captionText,
            bbox: [20, panelBbox[1] - 5, 200, panelBbox[1] + 85], parentId: parent });
        const heading = add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: title,
            bbox: [400, panelBbox[1] - 5, 600, panelBbox[1] + 5], parentId: parent });
        const path = `images/${name}.png`;
        assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        add({ type: 'chart', role: 'panel', bboxKind: 'visual-body', bbox: [...panelBbox],
            assetPath: path, parentId: parent });
        chunks.push(captionText, title, `![](${path})`);
        return { caption, heading };
    };
    const first = addFigure('window-fixed', [300, 50, 900, 180],
        'Fig. 6 | Representation of Fixed window technique on a 29 days menstrual cycle plot.',
        'Fixed window technique for data segment selection');
    const second = addFigure('window-rolling', [300, 220, 900, 350],
        'Fig. 7 | Representation of Rolling window technique on a 29 days menstrual cycle plot.',
        'Rolling window technique for data segment selection');
    const markdown = chunks.join('\n\n');
    return {
        first, second,
        input: {
            provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: [], providerState: {},
        },
    };
}

test('keeps adjacent figures with different labels as separate candidates', () => {
    const { input, first, second } = makeStackedFiguresInput();
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map(candidate => candidate.decision), ['compose', 'compose']);
    assert.deepEqual(candidates.map(candidate => candidate.label), ['Fig. 6 |', 'Fig. 7 |']);
    assert.deepEqual(candidates[0].captionBlockIds, [first.caption]);
    assert.deepEqual(candidates[1].captionBlockIds, [second.caption]);
    assert.ok(candidates[0].ownedTextBlockIds.includes(first.heading));
    assert.ok(candidates[1].ownedTextBlockIds.includes(second.heading));
});

test('owns panel sub-captions that sit below the panel band', () => {
    const { input, subCaption } = makeInBandFigureInput();
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(subCaption));
    assert.ok(candidate.visualBBox[3] >= 480);
});

test('owns long caption-role panel sub-captions inside the figure band', () => {
    const { input, subCaption } = makeInBandFigureInput({
        subCaptionText: 'Blinded Context Layer A/B Evaluation (n=4 paired cases, one reviewer)',
    });
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(subCaption));
});

function makeSharedLegendFigureInput() {
    const blocks = [];
    const assets = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const addPanel = (bbox, name, parentId) => {
        const path = `images/${name}.png`;
        assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        add({ type: 'chart', role: 'panel', bboxKind: 'visual-body', bbox: [...bbox],
            assetPath: path, parentId });
        return path;
    };
    const first = add({ type: 'chart', role: 'unknown', bboxKind: 'group', bbox: [100, 200, 400, 500] });
    const footnote = add({ type: 'text', role: 'figure-text', bboxKind: 'text', text: 'Claude Opus 4.6',
        bbox: [430, 170, 520, 185], parentId: first });
    const firstPath = addPanel([100, 200, 400, 500], 'legend-a', first);
    const second = add({ type: 'chart', role: 'unknown', bboxKind: 'group', bbox: [450, 200, 700, 500] });
    const secondPath = addPanel([450, 200, 700, 500], 'legend-b', second);
    const legend = add({ type: 'text', role: 'unknown', bboxKind: 'text', text: 'Gemini 3.1 Pro GPT-5.2',
        bbox: [150, 170, 300, 185] });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: 'Fig. 9 | Comparative evaluation of AI systems.',
        bbox: [100, 520, 700, 560], parentId: second });
    const markdown = [
        'Gemini 3.1 Pro GPT-5.2', 'Claude Opus 4.6',
        `![](${firstPath})`, `![](${secondPath})`,
        'Fig. 9 | Comparative evaluation of AI systems.',
    ].join('\n\n');
    return {
        legend, footnote, caption,
        input: {
            provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: [], providerState: {},
        },
    };
}

test('owns a shared legend attached to another panel instead of preserving', () => {
    const { input, legend, footnote } = makeSharedLegendFigureInput();
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(footnote));
    assert.ok(candidate.ownedTextBlockIds.includes(legend));
    assert.ok(candidate.visualBBox[1] <= 170);
});

function makeDuplicateLabelInput() {
    const blocks = [];
    const assets = [];
    const chunks = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const addGroup = (bbox, captionText, name) => {
        const parent = add({ type: 'chart', role: 'unknown', bboxKind: 'group', bbox: [...bbox] });
        add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: captionText,
            bbox: [bbox[0], bbox[1] - 18, bbox[2], bbox[1] - 6], parentId: parent });
        const path = `images/${name}.png`;
        assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        add({ type: 'chart', role: 'panel', bboxKind: 'visual-body', bbox: [...bbox],
            assetPath: path, parentId: parent });
        chunks.push(captionText, `![](${path})`);
    };
    addGroup([100, 100, 400, 300], 'Fig. 5 | First half of a split caption.', 'dup-a');
    addGroup([100, 320, 400, 520], 'Fig. 5 | Second half of a split caption.', 'dup-b');
    const markdown = chunks.join('\n\n');
    return {
        input: { provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: [], providerState: {} },
    };
}

test('preserves adjacent groups that repeat the same academic label', () => {
    const { input } = makeDuplicateLabelInput();
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'preserve');
    assert.equal(candidates[0].reason, 'ambiguous-caption');
});

function makeGeometricTwoCaptionInput() {
    const blocks = [];
    const assets = [];
    const chunks = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const addPanel = (bbox, name) => {
        const path = `images/${name}.png`;
        assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        add({ type: 'chart', role: 'panel', bboxKind: 'visual-body', bbox: [...bbox],
            assetPath: path });
        chunks.push(`![](${path})`);
    };
    addPanel([100, 100, 300, 300], 'geo-a');
    addPanel([100, 320, 300, 520], 'geo-b');
    add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: 'Fig. 1 | First geometric figure.', bbox: [320, 100, 600, 140] });
    add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: 'Fig. 2 | Second geometric figure.', bbox: [320, 320, 600, 360] });
    chunks.push('Fig. 1 | First geometric figure.', 'Fig. 2 | Second geometric figure.');
    const markdown = chunks.join('\n\n');
    return {
        input: { provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: [], providerState: {} },
    };
}

test('preserves geometric groups that claim two different academic labels', () => {
    const { input } = makeGeometricTwoCaptionInput();
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'preserve');
    assert.equal(candidates[0].reason, 'ambiguous-caption');
});

function makeMultiLineLegendInput() {
    const blocks = [];
    const assets = [];
    const chunks = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const parent = add({ type: 'chart', role: 'unknown', bboxKind: 'group', bbox: [100, 200, 400, 500] });
    const footnote = add({ type: 'text', role: 'figure-text', bboxKind: 'text',
        text: 'OpenEvidence\nUpToDate Expert AI', bbox: [150, 180, 320, 195], parentId: parent });
    const legend = add({ type: 'text', role: 'unknown', bboxKind: 'text',
        text: 'GPT-5.2\nGemini 3.1 Pro', bbox: [150, 168, 300, 183] });
    const path = 'images/legend-panel.png';
    assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    add({ type: 'chart', role: 'panel', bboxKind: 'visual-body', bbox: [100, 200, 400, 500],
        assetPath: path, parentId: parent });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: 'Fig. 8 | Comparative evaluation across models.',
        bbox: [100, 520, 600, 560], parentId: parent });
    const markdown = [
        'GPT-5.2\nGemini 3.1 Pro', 'OpenEvidence\nUpToDate Expert AI',
        `![](${path})`, 'Fig. 8 | Comparative evaluation across models.',
    ].join('\n\n');
    return {
        legend, footnote, caption,
        input: { provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: [], providerState: {} },
    };
}

test('owns multi-line legend rows next to the figure band', () => {
    const { input, legend, footnote } = makeMultiLineLegendInput();
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(footnote));
    assert.ok(candidate.ownedTextBlockIds.includes(legend));
});

function makeAboveBandRowInput({ rowText = 'github.com/google-research/envharness' } = {}) {
    const captionText = 'Figure 1 | Overall performance of the system.';
    const blocks = [];
    const assets = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const parent = add({ type: 'chart', role: 'unknown', bboxKind: 'group', bbox: [100, 130, 500, 400] });
    const row = add({ type: 'caption', role: 'caption', bboxKind: 'caption', text: rowText,
        bbox: [200, 104, 420, 120], parentId: parent });
    const path = 'images/above-row.png';
    assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    add({ type: 'chart', role: 'panel', bboxKind: 'visual-body', bbox: [100, 130, 500, 400],
        assetPath: path, parentId: parent });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: captionText, bbox: [100, 430, 500, 470], parentId: parent });
    const markdown = [rowText, `![](${path})`, captionText].join('\n\n');
    return {
        row, caption,
        input: { provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
            contentList: [], providerState: {} },
    };
}

test('leaves a source-URL row above a chart as page text', () => {
    const { input, row, caption } = makeAboveBandRowInput();
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.deepEqual(candidate.captionBlockIds, [caption]);
    assert.ok(!candidate.ownedTextBlockIds.includes(row));
    assert.ok(candidate.visualBBox[1] > 120);
});

test('owns a label row above a chart when it is not a link', () => {
    const { input, row } = makeAboveBandRowInput({ rowText: 'Externalized State: Memory' });
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(row));
    assert.ok(candidate.visualBBox[1] <= 104);
});

test('keeps the labelled caption ahead of a side-column note', () => {
    const captionText = 'Extended Data Fig. 5 | Odor-odor correlation at different level processing.';
    const noteText = 'Data were acquired from 12 odors presented at two concentrations.';
    const blocks = [];
    const assets = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const parent = add({ type: 'chart', role: 'unknown', bboxKind: 'group', bbox: [100, 130, 700, 400] });
    const path = 'images/side-note.png';
    assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    add({ type: 'chart', role: 'panel', bboxKind: 'visual-body', bbox: [100, 130, 700, 350],
        assetPath: path, parentId: parent });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: captionText, bbox: [100, 420, 400, 470], parentId: parent });
    const note = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: noteText, bbox: [410, 419, 700, 460], parentId: parent });
    const markdown = [`![](${path})`, '', captionText, '', noteText].join('\n');

    const candidate = resolveFigureCandidates(bindFigureSourceRanges({
        provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
        pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0,
            geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
        contentList: [], providerState: {},
    }))[0];

    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.label, 'Extended Data Fig. 5 |');
    assert.equal(candidate.captionBlockIds[0], caption);
    assert.equal(candidate.captionBlockIds[1], note);
});

test('joins a nearby caption with its below-panel continuation text', () => {
    const captionText = 'Extended Data Fig. 6 | M72 glomerulus response to different odorants. '
        + 'A. Temporal profiles. (Top row) Latency maps showing';
    const continuationText = 'response latencies (ms) for lower BENZ, low BENZ, and high BENZ '
        + 'conditions. (Bottom row) Amplitude maps showing response amplitudes.';
    const blocks = [];
    const assets = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const parent = add({ type: 'image', role: 'unknown', bboxKind: 'group', bbox: [100, 130, 700, 400] });
    const path = 'images/composite.png';
    assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    add({ type: 'image', role: 'panel', bboxKind: 'visual-body', bbox: [100, 130, 700, 350],
        assetPath: path, parentId: parent });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: captionText, bbox: [100, 356, 400, 406] });
    const continuation = add({ type: 'text', role: 'figure-text', bboxKind: 'text',
        text: continuationText, bbox: [410, 355, 700, 400], parentId: parent });
    const markdown = [`![](${path})`, '', captionText, '', continuationText].join('\n');

    const candidate = resolveFigureCandidates(bindFigureSourceRanges({
        provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
        pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0,
            geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
        contentList: [], providerState: {},
    }))[0];

    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.label, 'Extended Data Fig. 6 |');
    assert.deepEqual(candidate.captionBlockIds, [caption, continuation]);
});

test('captures a panel whose letter sits above the detected panels', () => {
    const captionText = 'Extended Data Fig. 8 | Tufted vs mitral cells. A. Cumulative distribution.';
    const blocks = [];
    const assets = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const parent = add({ type: 'image', role: 'unknown', bboxKind: 'group', bbox: [100, 60, 700, 500] });
    const label = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: 'A', bbox: [100, 64, 118, 80], parentId: parent });
    add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: 'Bi', bbox: [102, 356, 126, 374], parentId: parent });
    const path = 'images/panel.png';
    assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    add({ type: 'image', role: 'panel', bboxKind: 'visual-body', bbox: [110, 360, 500, 500],
        assetPath: path, parentId: parent });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: captionText, bbox: [100, 510, 500, 560] });
    const markdown = ['A', 'Bi', '', `![](${path})`, '', captionText].join('\n');

    const candidate = resolveFigureCandidates(bindFigureSourceRanges({
        provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
        pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0,
            geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
        contentList: [], providerState: {},
    }))[0];

    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(label));
    assert.ok(candidate.visualBBox[1] <= 64);
});

test('does not extend the crop across prose above the panels', () => {
    const captionText = 'Extended Data Fig. 8 | Tufted vs mitral cells. A. Cumulative distribution.';
    const blocks = [];
    const assets = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p0:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, pageIndex: 0, sourceRanges: [],
            rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const parent = add({ type: 'image', role: 'unknown', bboxKind: 'group', bbox: [100, 60, 700, 500] });
    const label = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: 'A', bbox: [100, 64, 118, 80], parentId: parent });
    add({ type: 'text', role: 'body', bboxKind: 'text',
        text: 'Prose that sits in the band above the panel.', bbox: [100, 200, 400, 240] });
    const path = 'images/panel.png';
    assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    add({ type: 'image', role: 'panel', bboxKind: 'visual-body', bbox: [110, 360, 500, 500],
        assetPath: path, parentId: parent });
    const caption = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        text: captionText, bbox: [100, 510, 500, 560] });
    const markdown = [
        'A', '',
        'Prose that sits in the band above the panel.', '',
        `![](${path})`, '', captionText,
    ].join('\n');

    const candidate = resolveFigureCandidates(bindFigureSourceRanges({
        provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
        pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0,
            geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length } }],
        contentList: [], providerState: {},
    }))[0];

    assert.equal(candidate.decision, 'compose');
    assert.ok(!candidate.ownedTextBlockIds.includes(label));
    assert.ok(candidate.visualBBox[1] >= 350);
});

function makeNextPageCaptionInput() {
    const placeholder = 'Extended Data Fig. 9 | See next page for caption.';
    const caption = 'Extended Data Fig. 9 | Odor delivery system and experimental timing. '
        + 'A. Odors were delivered using a multi-cassette air dilution olfactometer.';
    const continuation = 'further dilution of the odor concentration up to 20-fold. '
        + 'The airflow from the FV was directed to the odor port.';
    const blocks = [];
    const assets = [];
    const add = block => {
        const sourceOrdinal = blocks.length;
        const id = `mineru:p${block.pageIndex}:b${sourceOrdinal}`;
        blocks.push({ id, sourceOrdinal, sourceRanges: [], rangeEvidence: 'unresolved', ...block });
        return id;
    };
    const path = 'images/ed9.png';
    assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    const parent = add({ pageIndex: 0, type: 'image', role: 'unknown',
        bboxKind: 'group', bbox: [100, 60, 900, 700] });
    add({ pageIndex: 0, type: 'image', role: 'panel', bboxKind: 'visual-body',
        bbox: [110, 68, 880, 663], assetPath: path, parentId: parent });
    const placeholderID = add({ pageIndex: 0, type: 'caption', role: 'caption',
        bboxKind: 'caption', text: placeholder, bbox: [62, 676, 329, 690], parentId: parent });
    const leadID = add({ pageIndex: 1, type: 'text', role: 'caption',
        bboxKind: 'text', text: caption, bbox: [61, 58, 494, 238] });
    const continuationID = add({ pageIndex: 1, type: 'text', role: 'unknown',
        bboxKind: 'text', text: continuation, bbox: [509, 58, 943, 238] });
    const markdown = [
        `![](${path})`, '', placeholder, '', caption, '', continuation,
    ].join('\n');
    return {
        placeholderID, leadID, continuationID,
        input: {
            provider: 'mineru', markdown, assets, assetBasePath: '', blocks,
            contentList: [], providerState: {},
            pages: [0, 1].map(pageIndex => ({
                pageIndex, width: 1000, height: 1000, unit: 'pt', dpi: null,
                coordinateFrame: 'display-cropbox', rotation: 0,
                geometryEvidence: 'fixture', markdownRange: { from: 0, to: markdown.length },
            })),
        },
    };
}

test('replaces a see-next-page caption with the following page legend', () => {
    const { input, placeholderID, leadID, continuationID } = makeNextPageCaptionInput();
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));

    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.label, 'Extended Data Fig. 9 |');
    assert.deepEqual(candidate.captionBlockIds, [leadID, continuationID, placeholderID]);
    assert.ok(candidate.visualBBox[1] <= 68);
    assert.ok(candidate.visualBBox[1] >= 60);
});

test('keeps the placeholder legend when the next page has no matching caption', () => {
    const { input, placeholderID } = makeNextPageCaptionInput();
    input.blocks = input.blocks.filter(block => block.pageIndex === 0);
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];

    assert.equal(candidate.decision, 'compose');
    assert.deepEqual(candidate.captionBlockIds, [placeholderID]);
});
