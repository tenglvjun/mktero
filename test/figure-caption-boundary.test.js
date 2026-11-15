import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';

// Two rows of panels on one page, each row its own printed legend, and every
// panel carrying an explicit parent group the way MinerU reports them. A legend
// printed between the rows closes the figure above and opens the figure below,
// so geometry alone must not join them: the row gap stays inside the panel gap
// budget on purpose.
const FIRST_CAPTION = 'Figure 1. Upper row of panels comparing intervention accuracy.';
const SECOND_CAPTION = 'Figure 2. Lower row of panels comparing baseline accuracy.';

function stackedRowsFixture({
    rowCount = 3,
    rowTop = 100,
    rowHeight = 150,
    secondTop = 320,
    secondCount = 4,
    captionAbove = false,
    secondRow = true,
    secondCaption = true,
    firstCaptionTop = null,
    extraLegends = 0,
} = {}) {
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
    const addRow = (count, top, { captionText = null, captionTop = null, sharedParent = null } = {}) => {
        const width = Math.floor((800 - (count - 1) * 10) / count);
        let lastParent = sharedParent;
        for (let index = 0; index < count; index++) {
            const left = 100 + index * (width + 10);
            const path = `images/row-${assets.length}.png`;
            assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
            // Every panel gets its own parent group, as MinerU reports a row of
            // separately detected sub-figures. A composite figure shares one.
            const parent = sharedParent ?? add({ type: 'chart', role: 'unknown', bboxKind: 'group',
                bbox: [left, top, left + width, top + rowHeight] });
            add({ type: 'chart', role: 'panel', bboxKind: 'visual-body',
                bbox: [left, top, left + width, top + rowHeight], assetPath: path, parentId: parent });
            chunks.push(`![](${path})`);
            lastParent = parent;
        }
        if (!captionText) return;
        // The legend hangs off the row's parent group, which is how a MinerU
        // caption block is attached to the figure it describes.
        const boxTop = captionTop ?? (captionAbove ? top - 38 : top + rowHeight + 8);
        add({ type: 'caption', role: 'caption', bboxKind: 'caption',
            bbox: [100, boxTop, 900, boxTop + 30], text: captionText,
            parentId: lastParent });
        chunks.push(captionText);
    };
    // One figure printed in two rows has a single parent group spanning both.
    const sharedParent = secondRow && !secondCaption
        ? add({ type: 'chart', role: 'unknown', bboxKind: 'group',
            bbox: [100, rowTop, 900, secondTop + rowHeight] })
        : null;
    addRow(rowCount, rowTop, { captionText: FIRST_CAPTION,
        captionTop: firstCaptionTop, sharedParent });
    if (secondRow) {
        addRow(secondCount, secondTop, {
            captionText: secondCaption ? SECOND_CAPTION : null,
            sharedParent,
        });
    }
    // Printed legends further down the page belong to neither row, but scanning
    // them still costs the comparison budget.
    for (let index = 0; index < extraLegends; index++) {
        const top = 800 + index * 35;
        const text = `Figure ${20 + index}. Unrelated printed legend ${index}.`;
        add({ type: 'caption', role: 'caption', bboxKind: 'caption',
            bbox: [100, top, 900, top + 28], text });
        chunks.push(text);
    }
    const markdown = chunks.join('\n\n');
    return {
        provider: 'mineru', markdown, assets, assetBasePath: '',
        blocks, contentList: [], providerState: {},
        pages: [{ pageIndex: 0, width: 1000, height: 1000, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0,
            markdownRange: { from: 0, to: markdown.length } }],
    };
}

function figureCandidates(input, options) {
    return resolveFigureCandidates(bindFigureSourceRanges(input), options);
}

function rowPanelIds(input, rowTop) {
    return input.blocks
        .filter(block => block.role === 'panel' && block.bbox[1] === rowTop)
        .map(block => block.id);
}

test('keeps two stacked figures apart when a printed legend lies between them', () => {
    const input = stackedRowsFixture();
    const upper = rowPanelIds(input, 100);
    const lower = rowPanelIds(input, 320);
    // The row gap (70) is inside panelGapBudget(150) = 90, so the rows are
    // geometrically adjacent and only the printed legend separates them.
    const candidates = figureCandidates(input);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(candidate => candidate.decision === 'compose'),
        JSON.stringify(candidates.map(candidate => candidate.reason)));
    assert.deepEqual(candidates.map(candidate => candidate.label), ['Figure 1.', 'Figure 2.']);
    assert.deepEqual(candidates.map(candidate => candidate.panelBlockIds), [upper, lower]);
    assert.ok(candidates.every(candidate => candidate.evidence.includes('explicit-parent')));
});

test('still joins every panel of one row, however many there are', () => {
    for (const count of [2, 3, 4, 5]) {
        const input = stackedRowsFixture({ rowCount: count, secondRow: false });
        const candidates = figureCandidates(input);
        assert.equal(candidates.length, 1, `row of ${count}`);
        assert.equal(candidates[0].decision, 'compose', `row of ${count}`);
        assert.equal(candidates[0].panelBlockIds.length, count, `row of ${count}`);
        assert.equal(candidates[0].label, 'Figure 1.', `row of ${count}`);
    }
});

test('keeps the rows apart when each legend is printed above its panels', () => {
    const input = stackedRowsFixture({
        captionAbove: true, rowTop: 160, secondTop: 380,
    });
    const candidates = figureCandidates(input);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(candidate => candidate.decision === 'compose'),
        JSON.stringify(candidates.map(candidate => candidate.reason)));
    assert.deepEqual(candidates.map(candidate => candidate.panelBlockIds),
        [rowPanelIds(input, 160), rowPanelIds(input, 380)]);
});

test('still joins one figure whose panels are printed in two rows', () => {
    // A single figure printed in two rows keeps one legend under both rows, so
    // nothing separates them and the geometry still joins all four panels.
    const input = stackedRowsFixture({
        rowCount: 2, secondCount: 2, secondTop: 320, secondCaption: false,
        firstCaptionTop: 320 + 150 + 8,
    });
    const candidates = figureCandidates(input);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose',
        JSON.stringify(candidates[0].reason));
    assert.equal(candidates[0].panelBlockIds.length, 4);
    assert.equal(candidates[0].label, 'Figure 1.');
});

test('never merges across a printed legend when the comparison budget runs out', () => {
    const input = stackedRowsFixture();
    const upper = new Set(rowPanelIds(input, 100));
    const lower = new Set(rowPanelIds(input, 320));
    let sawResourceLimit = false;
    for (let maxComparisons = 1; maxComparisons <= 40; maxComparisons++) {
        const candidates = figureCandidates(input, { limits: { maxComparisons } });
        assert.ok(candidates.length > 0, `budget ${maxComparisons}`);
        for (const candidate of candidates) {
            const fromUpper = candidate.panelBlockIds.some(id => upper.has(id));
            const fromLower = candidate.panelBlockIds.some(id => lower.has(id));
            assert.ok(!(fromUpper && fromLower),
                `budget ${maxComparisons} merged both rows: ${candidate.panelBlockIds}`);
            if (candidate.decision !== 'compose') continue;
            // A composed figure is still one row and still carries its own legend.
            assert.ok(candidate.evidence.includes('explicit-parent'));
        }
        if (candidates.some(candidate => candidate.decision === 'preserve'
            && candidate.reason === 'resource-limit')) sawResourceLimit = true;
    }
    assert.ok(sawResourceLimit, 'a small budget must preserve instead of merging');
});

test('charges the comparison budget for every printed legend it scans', () => {
    const spend = extraLegends => {
        const input = stackedRowsFixture({ extraLegends });
        const budget = { remaining: 1_000_000 };
        const candidates = figureCandidates(input, { budget });
        assert.deepEqual(candidates.map(candidate => candidate.decision),
            ['compose', 'compose'], `extra legends ${extraLegends}`);
        return 1_000_000 - budget.remaining;
    };
    const none = spend(0);
    // Ten extra legends cost strictly more comparisons, so the scan is charged
    // item by item instead of being free or charged once per pair.
    assert.ok(spend(10) > none, 'extra legends must cost comparisons');
    // A budget just under that cost preserves both rows; one above composes them.
    const extra = stackedRowsFixture({ extraLegends: 10 });
    const tight = figureCandidates(extra, { limits: { maxComparisons: spend(10) - 1 } });
    assert.deepEqual(tight.map(candidate => candidate.decision),
        ['preserve', 'preserve']);
    assert.ok(tight.every(candidate => candidate.reason === 'resource-limit'));
    assert.deepEqual(tight.map(candidate => candidate.panelBlockIds.length), [3, 4]);
    const enough = figureCandidates(extra, { limits: { maxComparisons: spend(10) } });
    assert.deepEqual(enough.map(candidate => candidate.decision), ['compose', 'compose']);
});
