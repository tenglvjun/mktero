import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { prepareFigureFixture } from './helpers/figure-preparer.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';

function fixture({ pageIndex = 7, label = 'Fig. 17.', letters = 'ABCDEF', caption = null } = {}) {
    const input = {
        provider: 'mineru', rangesExplicit: true, markdown: '',
        assets: [], assetBasePath: '', contentList: [], providerState: {}, blocks: [],
        pages: [pageIndex, pageIndex + 1].map(index => ({
            pageIndex: index, width: 600, height: 800, unit: 'pt', dpi: null,
            coordinateFrame: 'display-cropbox', rotation: 0, markdownRange: null,
        })),
    };
    const add = (block, markdown = block.text) => {
        const sourceOrdinal = input.blocks.length;
        const ranges = [];
        if (markdown) {
            const from = input.markdown.length;
            input.markdown += `${markdown}\n\n`;
            ranges.push({ from, to: from + markdown.length });
        }
        const value = {
            id: `block-${sourceOrdinal}`, sourceOrdinal, pageIndex,
            text: '', sourceRanges: ranges,
            rangeEvidence: ranges.length ? 'explicit-range' : 'unresolved', ...block,
        };
        input.blocks.push(value);
        return value;
    };
    const panels = [];
    const markers = [];
    for (let index = 0; index < 6; index++) {
        const left = index % 2 ? 520 : 120;
        const top = 60 + Math.floor(index / 2) * 310;
        const bbox = [left, top, left + 360, top + 260];
        const parent = add({ type: 'image', role: 'unknown', bboxKind: 'group', bbox });
        const path = `images/panel-${index}.png`;
        input.assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        panels.push(add({ type: 'image', role: 'panel', bboxKind: 'visual-body',
            bbox, parentId: parent.id, assetPath: path }, `![](${path})`));
        markers.push(add({ type: 'caption', role: 'caption', bboxKind: 'caption',
            bbox: [left - 10, top - 10, left, top + 5], parentId: parent.id,
            text: letters[index] || letters.at(-1) }));
    }
    const heading = add({ type: 'caption', role: 'caption', bboxKind: 'caption',
        parentId: panels[2].parentId, bbox: [250, 345, 750, 365],
        text: 'Experimental activation of the circuit' });
    const legend = add({ pageIndex: pageIndex + 1, type: 'text', role: 'caption',
        bboxKind: 'text', bbox: [80, 50, 920, 240],
        text: caption || `${label} Circuit activity. (A) Setup. (B) Recordings. `
            + '(C) Control. (D) Treatment. (E) Power. (F) Recovery.' });
    const body = add({ pageIndex: pageIndex + 1, type: 'text', role: 'body',
        bboxKind: 'text', bbox: [80, 280, 480, 500],
        text: 'The article continues with independent results and discussion.' });
    return { input, add, pageIndex, panels, markers, heading, legend, body };
}

function first(input) {
    return resolveFigureCandidates(input).find(candidate => candidate.pageIndex === input.pages[0].pageIndex);
}

function assertUnassociated(input) {
    const before = structuredClone(input);
    const candidate = first(input);
    assert.ok(candidate);
    assert.ok(!candidate.evidence.includes('following-page-caption'));
    assert.ok(!candidate.captionBlockIds.some(id => input.blocks.find(block => block.id === id)
        ?.pageIndex !== candidate.pageIndex));
    assert.deepEqual(input, before);
}

test('restores an exclusive full-page figure with a matching next-page caption and no placeholder', () => {
    const { input, panels, markers, heading, legend, body, pageIndex } = fixture();
    const candidate = first(input);
    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.label, 'Fig. 17.');
    assert.equal(candidate.pageIndex, pageIndex);
    assert.deepEqual(new Set(candidate.panelBlockIds), new Set(panels.map(panel => panel.id)));
    assert.deepEqual(candidate.captionBlockIds, [legend.id]);
    assert.deepEqual(new Set(candidate.ownedTextBlockIds),
        new Set([...markers, heading].map(block => block.id)));
    assert.ok(candidate.evidence.includes('following-page-caption'));
    assert.ok(candidate.visualBBox[1] <= 50);
    assert.ok(candidate.visualBBox[3] >= 940);
    assert.ok(!candidate.ownedTextBlockIds.includes(body.id));

    const draft = composeFigureDraft(input, [{ candidate,
        crop: { data: createTestPNG(600, 800), mimeType: 'image/png', width: 600, height: 800 },
        assetPath: 'generated/figures/recovered.png' }]);
    assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
    assert.equal(draft.input.markdown.split(legend.text).length - 1, 1);
    assert.ok(draft.input.markdown.includes(body.text));
    for (const panel of panels) assert.ok(!draft.input.markdown.includes(panel.assetPath));
});

test('accepts other figure numbers, lowercase panel letters and grouped caption references', () => {
    for (const caption of [
        'Figure S4. Circuit responses. (a to f) Treatment and control recordings.',
        'Figure S4. Circuit responses. (a–c) Setup and control. (d, e and f) Recovery.',
    ]) {
        const { input } = fixture({ pageIndex: 18, label: 'Figure S4.', letters: 'abcdef', caption });
        const candidate = first(input);
        assert.equal(candidate.decision, 'compose');
        assert.equal(candidate.label, 'Figure S4.');
        assert.equal(candidate.pageIndex, 18);
    }
});

test('accepts missing OCR panel letters when the remaining unique letters agree with the legend', () => {
    const { input, markers } = fixture();
    input.blocks = input.blocks.filter(block => block !== markers[3]);
    assert.equal(first(input).decision, 'compose');
});

test('does not compare next-page caption coordinates with this page internal labels or headings', () => {
    const { input, heading } = fixture();
    heading.bbox = [250, 180, 750, 200];
    const candidate = first(input);
    assert.equal(candidate.decision, 'compose');
    assert.ok(candidate.ownedTextBlockIds.includes(heading.id));
});

test('preserves existing same-page caption ownership', () => {
    const { input, add, pageIndex } = fixture();
    const caption = add({ pageIndex, type: 'text', role: 'caption', bboxKind: 'caption',
        bbox: [80, 950, 920, 990], text: 'Fig. 16. A different figure with a same-page caption.' });
    const candidate = first(input);
    assert.ok(!candidate.evidence.includes('following-page-caption'));
    assert.ok(candidate.captionBlockIds.includes(caption.id));
});

test('refuses to infer a cross-page relationship for another provider or non-explicit ranges', () => {
    for (const change of [
        input => { input.provider = 'mistral'; },
        input => { input.rangesExplicit = false; },
    ]) {
        const { input } = fixture();
        change(input);
        assertUnassociated(input);
    }
});

test('refuses incomplete or duplicate panel-letter evidence', () => {
    for (const change of [
        ({ markers }) => { markers[5].text = 'A'; },
        ({ markers }) => { markers[5].text = 'Z'; },
        ({ input, markers }) => { input.blocks = input.blocks.filter(block => !markers.slice(0, 4).includes(block)); },
        ({ markers }) => { markers[0].text = 'G'; },
    ]) {
        const data = fixture();
        change(data);
        assertUnassociated(data.input);
    }
});

test('refuses partial-page figures, separate geometric groups and prose on the figure page', () => {
    for (const change of [
        ({ input, pageIndex }) => {
            for (const block of input.blocks.filter(value => value.pageIndex === pageIndex && value.bbox)) {
                block.bbox = [block.bbox[0], block.bbox[1] / 2, block.bbox[2], block.bbox[3] / 2];
            }
        },
        ({ panels }) => { panels[5].bbox = [950, 970, 990, 995]; },
        ({ add }) => { add({ type: 'text', role: 'body', bboxKind: 'text',
            bbox: [300, 660, 700, 675], text: 'A body paragraph between unrelated figures.' }); },
        ({ add }) => { add({ type: 'text', role: 'body', bboxKind: 'text',
            bbox: [10, 20, 990, 35], text: 'Prose above the figure on a mixed article page.' }); },
        ({ add }) => { add({ type: 'text', role: 'unknown', bboxKind: 'text', bbox: null,
            text: 'Unlocated text cannot establish exclusive figure membership.' }); },
        ({ add }) => { add({ type: 'table', role: 'body', bboxKind: 'text',
            bbox: [200, 650, 800, 675], text: 'Independent table.' }); },
    ]) {
        const data = fixture();
        change(data);
        assertUnassociated(data.input);
    }
});

test('refuses a caption away from the next page top, on a nonadjacent page or following earlier content', () => {
    for (const change of [
        ({ legend }) => { legend.bbox = [80, 320, 920, 510]; },
        ({ legend, input }) => {
            legend.pageIndex += 1;
            input.pages.push({ ...input.pages[1], pageIndex: legend.pageIndex });
        },
        ({ add, pageIndex }) => { add({ pageIndex: pageIndex + 1, type: 'text', role: 'body',
            bboxKind: 'text', bbox: [80, 10, 920, 35], text: 'Article prose before the caption.' }); },
    ]) {
        const data = fixture();
        change(data);
        assertUnassociated(data.input);
    }
});

test('refuses ambiguous, unresolved or already attached next-page captions', () => {
    for (const change of [
        ({ add, pageIndex }) => { add({ pageIndex: pageIndex + 1, type: 'text', role: 'caption',
            bboxKind: 'text', bbox: [80, 50, 920, 240],
            text: 'Fig. 18. Another possible caption. (A to F) Other panels.' }); },
        ({ legend }) => { legend.sourceRanges = []; legend.rangeEvidence = 'unresolved'; },
        ({ legend }) => { legend.bbox = null; },
        ({ legend }) => { legend.text += 'x'.repeat(8_192); },
        ({ input }) => { input.pages[1].coordinateFrame = 'unknown'; },
        ({ input }) => { input.pages[1].geometryReason = 'coordinate-mismatch'; },
        ({ legend }) => { legend.parentId = 'next-page-image'; },
        ({ add, pageIndex, legend }) => {
            const parent = add({ pageIndex: pageIndex + 1, type: 'image', role: 'unknown',
                bboxKind: 'group', bbox: [80, 30, 920, 700] });
            add({ pageIndex: pageIndex + 1, type: 'image', role: 'panel', bboxKind: 'visual-body',
                bbox: [80, 250, 920, 700], parentId: parent.id, assetPath: 'images/local.png' }, '![](images/local.png)');
            legend.parentId = parent.id;
        },
    ]) {
        const data = fixture();
        change(data);
        assertUnassociated(data.input);
    }
});

test('refuses a distant next-page figure even when article prose separates it from the caption', () => {
    const { input, add, pageIndex, legend, body } = fixture();
    const path = 'images/distant-next-page.png';
    input.assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    add({ pageIndex: pageIndex + 1, type: 'image', role: 'panel', bboxKind: 'visual-body',
        bbox: [100, 650, 900, 900], assetPath: path }, `![](${path})`);
    assert.ok(legend.bbox[3] < body.bbox[1] && body.bbox[3] < 650);
    const candidates = resolveFigureCandidates(input);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(candidate => candidate.decision === 'preserve'));
    assert.ok(candidates.every(candidate => !candidate.evidence.includes('following-page-caption')));
    const draft = composeFigureDraft(input, candidates.map((candidate, index) => ({ candidate,
        crop: { data: createTestPNG(), mimeType: 'image/png', width: 8, height: 8 },
        assetPath: `generated/figures/distant-${index}.png` })));
    assert.equal(draft.blueprints.length, 0);
    assert.equal(draft.input.markdown, input.markdown);
});

test('refuses next-page image groups even when no individual panel was located', () => {
    const { input, add, pageIndex } = fixture();
    add({ pageIndex: pageIndex + 1, type: 'image', role: 'unknown', bboxKind: 'group',
        bbox: [100, 650, 900, 900] });
    assertUnassociated(input);
});

test('handles spanning and irregular panel arrangements without a paper-specific grid', () => {
    const { input, panels, markers } = fixture();
    const boxes = [
        [100, 60, 900, 260],
        [100, 320, 420, 580], [480, 320, 900, 580],
        [100, 640, 350, 940], [380, 640, 630, 940], [660, 640, 900, 940],
    ];
    for (const [index, panel] of panels.entries()) {
        panel.bbox = boxes[index];
        input.blocks.find(block => block.id === panel.parentId).bbox = [...panel.bbox];
        const [left, top] = panel.bbox;
        markers[index].bbox = [left - 10, top - 10, left, top + 5];
    }
    const candidate = first(input);
    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.panelBlockIds.length, boxes.length);
    assert.ok(candidate.visualBBox[0] <= 90);
    assert.ok(candidate.visualBBox[2] >= 900);
});

test('does not consume this page gap text using the next page caption coordinates', () => {
    const { input, add, panels, pageIndex, legend } = fixture();
    add({ pageIndex, type: 'caption', role: 'caption', bboxKind: 'caption',
        parentId: panels[0].parentId, bbox: [100, 950, 900, 970],
        text: 'Fig. 17. See next page for caption.' });
    legend.bbox = [80, 975, 920, 995];
    const text = add({ type: 'text', role: 'unknown', bboxKind: 'text',
        bbox: [100, 945, 900, 965], text: 'Independent lower page text' });
    const candidate = first(input);
    assert.equal(candidate.decision, 'compose');
    assert.ok(!candidate.ownedTextBlockIds.includes(text.id));
    assert.ok(candidate.visualBBox[3] < text.bbox[1]);
});

test('preserves both figures when a next-page caption is also claimed by a local figure', () => {
    const { input, add, panels, pageIndex, legend } = fixture();
    add({ pageIndex, type: 'caption', role: 'caption', bboxKind: 'caption',
        parentId: panels[0].parentId, bbox: [100, 950, 900, 970],
        text: 'Fig. 17. See next page for caption.' });
    const parent = add({ pageIndex: pageIndex + 1, type: 'image', role: 'unknown',
        bboxKind: 'group', bbox: [80, 280, 920, 750] });
    const path = 'images/local.png';
    input.assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    add({ pageIndex: pageIndex + 1, type: 'image', role: 'panel', bboxKind: 'visual-body',
        bbox: [80, 280, 920, 750], parentId: parent.id, assetPath: path }, `![](${path})`);
    legend.parentId = parent.id;
    input.blocks = input.blocks.filter(block => block.role !== 'body');
    const candidates = resolveFigureCandidates(input);
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(candidate => candidate.decision === 'preserve'));
    assert.ok(candidates.every(candidate => candidate.reason === 'ambiguous-membership'));
    const draft = composeFigureDraft(input, candidates.map((candidate, index) => ({ candidate,
        crop: { data: createTestPNG(), mimeType: 'image/png', width: 8, height: 8 },
        assetPath: `generated/figures/ambiguous-${index}.png` })));
    assert.equal(draft.blueprints.length, 0);
    assert.equal(draft.input.markdown, input.markdown);
});

test('verifies both PDF pages before rendering and keeps the caption source on its own page', async () => {
    const { input, pageIndex } = fixture();
    for (const page of input.pages) {
        page.geometryVerification = 'pending';
        page.rotation = null;
    }
    const before = structuredClone(input);
    const verified = [];
    const rendered = [];
    let closed = 0;
    const hash = data => createHash('sha256').update(data).digest('hex');
    const service = new FigureRestorationService({ hash, openPDF: async () => ({
        getPageGeometry: async index => {
            verified.push(index);
            return { pageIndex: index, width: 600, height: 800, rotation: 0, userUnit: 1,
                coordinateFrame: 'display-cropbox', viewBox: [0, 0, 600, 800], mediaBox: null,
                viewportTransform: [1, 0, 0, -1, 0, 800] };
        },
        renderRegion: async request => {
            rendered.push(request.pageIndex);
            return { data: createTestPNG(600, 800), mimeType: 'image/png', width: 600, height: 800 };
        },
        close: async () => { closed++; },
    }) });
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    assert.deepEqual(verified, [pageIndex, pageIndex + 1]);
    assert.deepEqual(rendered, [pageIndex]);
    assert.equal(closed, 1);
    assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareFigureFixture, hash });
    assert.equal(document.figureMap.figures.length, 1);
    const restored = document.figureMap.figures[0];
    const source = document.sourceMap.find(entry => entry.markdownFrom === restored.render.range.from);
    assert.equal(source.locations[0].pageIndex, pageIndex);
    assert.equal(source.locationRanges[0].location.pageIndex, pageIndex + 1);
    assert.deepEqual(input, before);
});

test('preserves original fragments when the caption PDF page cannot verify its layout coordinates', async () => {
    for (const failure of ['missing', 'size-mismatch']) {
        const { input, pageIndex } = fixture();
        for (const page of input.pages) page.geometryVerification = 'pending';
        let rendered = 0;
        const service = new FigureRestorationService({ hash: () => 'a'.repeat(64), openPDF: async () => ({
            getPageGeometry: async index => {
                if (index === pageIndex + 1 && failure === 'missing') throw new Error('unavailable');
                return { pageIndex: index, width: index === pageIndex + 1 ? 900 : 600, height: 800,
                    rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
                    viewBox: [0, 0, 600, 800], mediaBox: null, viewportTransform: [1, 0, 0, -1, 0, 800] };
            },
            renderRegion: async () => { rendered++; throw new Error('must not crop'); },
            close: async () => {},
        }) });
        const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.blueprints.length, 0);
        assert.equal(rendered, 0);
        assert.equal(draft.input.markdown, input.markdown);
    }
});

test('refuses unverified geometry or incomplete source ranges and respects comparison budgets', () => {
    for (const change of [
        ({ panels }) => { panels[0].bbox = null; },
        ({ panels }) => { panels[0].sourceRanges = []; panels[0].rangeEvidence = 'unresolved'; },
        ({ input }) => { input.pages[0].coordinateFrame = 'unknown'; },
    ]) {
        const data = fixture();
        change(data);
        assert.equal(first(data.input).decision, 'preserve');
    }
    const { input } = fixture();
    const candidates = resolveFigureCandidates(input, { limits: { maxComparisons: 1 } });
    assert.ok(candidates.every(candidate => candidate.decision === 'preserve'));
    assert.ok(candidates.some(candidate => candidate.reason === 'resource-limit'));
});
