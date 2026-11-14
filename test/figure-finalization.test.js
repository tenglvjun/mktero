import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';
import { finalizeRestoredDocument, finalizeFigureMap } from '../src/figures/figure-finalization.js';
import { prepareFigureFixture } from './helpers/figure-preparer.js';
import { sha256Hex } from '../src/core/sha256.js';
import { validateFigureMap } from '../src/figures/figure-model.js';
import { parseFigureMapJSON, serializeFigureMap } from '../src/figures/figure-map-serialization.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });

function fixture() {
    const { input: source } = makeFigureInput();
    const input = bindFigureSourceRanges(source);
    const candidate = resolveFigureCandidates(input).find(value => value.decision === 'compose');
    const draft = composeFigureDraft(input, [{ candidate,
        crop: { data: createTestPNG(800, 750), mimeType: 'image/png', width: 800, height: 750 },
        assetPath: 'generated/figures/restored.png' }]);
    return { input, draft };
}

// A full-page six-panel figure whose legend is printed at the top of the
// following page, the shape the resolver accepts as a following-page caption.
function crossPageFixture({ pageIndex = 7, label = 'Fig. 17.', letters = 'ABCDEF' } = {}) {
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
            id: `block-${sourceOrdinal}`, sourceOrdinal, pageIndex, text: '', sourceRanges: ranges,
            rangeEvidence: ranges.length ? 'explicit-range' : 'unresolved', ...block,
        };
        input.blocks.push(value);
        return value;
    };
    const panels = [];
    for (let index = 0; index < 6; index++) {
        const left = index % 2 ? 520 : 120;
        const top = 60 + Math.floor(index / 2) * 310;
        const bbox = [left, top, left + 360, top + 260];
        const parent = add({ type: 'image', role: 'unknown', bboxKind: 'group', bbox });
        const path = `images/panel-${index}.png`;
        input.assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
        panels.push(add({ type: 'image', role: 'panel', bboxKind: 'visual-body',
            bbox, parentId: parent.id, assetPath: path }, `![](${path})`));
        add({ type: 'caption', role: 'caption', bboxKind: 'caption', parentId: parent.id,
            bbox: [left - 10, top - 10, left, top + 5], text: letters[index] || letters.at(-1) });
    }
    add({ type: 'caption', role: 'caption', bboxKind: 'caption', parentId: panels[2].parentId,
        bbox: [250, 345, 750, 365], text: 'Experimental activation of the circuit' });
    add({ pageIndex: pageIndex + 1, type: 'text', role: 'caption', bboxKind: 'text',
        bbox: [80, 50, 920, 240],
        text: `${label} Circuit activity. (A) Setup. (B) Recordings. (C) Control. `
            + '(D) Treatment. (E) Power. (F) Recovery.' });
    add({ pageIndex: pageIndex + 1, type: 'text', role: 'body', bboxKind: 'text',
        bbox: [80, 280, 480, 500],
        text: 'The article continues with independent results and discussion.' });
    const candidate = resolveFigureCandidates(input)
        .find(value => value.pageIndex === pageIndex);
    assert.equal(candidate.decision, 'compose');
    const draft = composeFigureDraft(input, [{ candidate,
        crop: { data: createTestPNG(600, 800), mimeType: 'image/png', width: 600, height: 800 },
        assetPath: 'generated/figures/recovered.png' }]);
    assert.equal(draft.blueprints.length, 1);
    return { input, draft, pageIndex };
}

test('binds the final image and caption to the Markdown hash and separate PDF locations', async () => {
    const { input, draft } = fixture();
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareFigureFixture, hash });
    assert.equal(document.figureMap.figures.length, 1);
    const figure = document.figureMap.figures[0];
    assert.ok(document.markdown.slice(figure.render.range.from, figure.render.range.to)
        .includes('(generated/figures/restored.png)'));
    assert.equal(figure.render.captionRanges.length, 1);
    const source = document.sourceMap.find(entry => entry.markdownFrom <= figure.render.range.from
        && entry.markdownTo >= figure.render.range.to);
    assert.deepEqual(source.locations[0].bbox, figure.visualBBox);
    assert.deepEqual(source.locationRanges[0].location.bbox, figure.captionBBox);
    assert.doesNotThrow(() => validateFigureMap(document.figureMap, {
        ...document, persisted: true, markdownHash: document.figureMap.markdownHash,
    }));
    assert.deepEqual(prepareFigureFixture(document), document);
    assert.equal(document.providerState, undefined);
    assert.equal(document.blocks, undefined);
});

test('locates a next-page legend on its own page and keeps a same-page legend unchanged', async () => {
    const same = fixture();
    const samePage = await finalizeRestoredDocument(same.input, same.draft,
        { prepare: prepareFigureFixture, hash });
    const sameFigure = samePage.figureMap.figures[0];
    assert.ok(!('captionPageIndex' in sameFigure));
    const sameEntry = samePage.sourceMap.find(entry => entry.markdownFrom <= sameFigure.render.range.from
        && entry.markdownTo >= sameFigure.render.range.to);
    assert.deepEqual(sameEntry.locationRanges.map(range => range.location.pageIndex),
        sameEntry.locationRanges.map(() => sameFigure.pageIndex));

    const crossPage = crossPageFixture();
    const document = await finalizeRestoredDocument(crossPage.input, crossPage.draft,
        { prepare: prepareFigureFixture, hash });
    const figure = document.figureMap.figures[0];
    assert.equal(figure.pageIndex, 7);
    assert.equal(figure.captionPageIndex, 8);
    const entry = document.sourceMap.find(value => value.markdownFrom <= figure.render.range.from
        && value.markdownTo >= figure.render.range.to);
    assert.deepEqual(entry.locations, [{ pageIndex: 7, bbox: figure.visualBBox }]);
    assert.deepEqual(entry.locationRanges.map(range => range.location.pageIndex), [8]);
    assert.deepEqual(entry.locationRanges[0].location.bbox, figure.captionBBox);
});

test('keeps a caption page through a persisted figure map round trip', async () => {
    const { input, draft } = crossPageFixture();
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareFigureFixture, hash });
    const serialized = await serializeFigureMap(document.figureMap, document, { hash });
    const restored = await parseFigureMapJSON(serialized.json, document, { hash });
    assert.equal(restored.figures[0].captionPageIndex, 8);
    assert.deepEqual(restored, JSON.parse(JSON.stringify(document.figureMap)));
});

test('locates a persisted caption on the figure page when the map predates the field', async () => {
    const { input, draft } = crossPageFixture();
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareFigureFixture, hash });
    // A producer that never sets the field keeps the historical figure page.
    const legacyBlueprints = draft.blueprints.map(({ captionPageIndex, ...blueprint }) => blueprint);
    const legacyDocument = await finalizeFigureMap(
        prepareFigureFixture(draft.input), legacyBlueprints, { hash });
    const legacyFigure = legacyDocument.figureMap.figures[0];
    assert.ok(!('captionPageIndex' in legacyFigure));
    const entry = legacyDocument.sourceMap.find(value => (
        value.markdownFrom <= legacyFigure.render.range.from
        && value.markdownTo >= legacyFigure.render.range.to));
    assert.deepEqual(entry.locationRanges.map(range => range.location.pageIndex),
        [legacyFigure.pageIndex]);
    // A stored map written before the field existed still validates.
    const legacyMap = JSON.parse(JSON.stringify(document.figureMap));
    delete legacyMap.figures[0].captionPageIndex;
    const serialized = await serializeFigureMap(legacyMap, document, { hash });
    assert.ok(!('captionPageIndex' in serialized.map.figures[0]));
    assert.doesNotThrow(() => validateFigureMap(serialized.map, {
        ...document, persisted: true, markdownHash: serialized.map.markdownHash,
    }));
    assert.equal((await parseFigureMapJSON(serialized.json, document, { hash }))
        .figures[0].captionPageIndex, undefined);
});

test('rolls back the whole draft when final normalization loses a unique image anchor', async () => {
    const { input, draft } = fixture();
    const document = await finalizeRestoredDocument(input, draft, {
        hash,
        prepare: value => ({ ...value, markdown: value.markdown.replace('generated/figures/restored.png', 'lost.png') }),
    });
    assert.equal(document.markdown, input.markdown);
    assert.deepEqual(document.assets, input.assets);
    assert.equal(document.figureMap.figures.length, 0);
    assert.equal(document.figureMap.preserved[0].reason, 'ambiguous-source-range');
});

test('does not publish a restored document after cancellation during final hashing', async () => {
    const { input, draft } = fixture();
    const controller = new AbortController();
    await assert.rejects(finalizeRestoredDocument(input, draft, {
        prepare: prepareFigureFixture, signal: controller.signal,
        hash: async data => { controller.abort(); return hash(data); },
    }), { name: 'AbortError' });
});

test('keeps readable OCR when optional metadata rejects a legacy local asset path', async () => {
    const { input } = makeFigureInput();
    input.assets[0].path = './' + input.assets[0].path;
    const document = await finalizeRestoredDocument(input, { input, blueprints: [], preserved: [] }, {
        prepare: value => value, hash,
    });
    assert.equal(document.markdown, input.markdown);
    assert.deepEqual(document.assets, input.assets);
    assert.equal(document.figureMap, null);
});

test('keeps generated image destinations relative even when the archive root is named generated', async () => {
    const { input: source } = makeFigureInput();
    source.assetBasePath = 'generated';
    source.assets = source.assets.map(asset => ({ ...asset, path: 'generated/' + asset.path }));
    const input = bindFigureSourceRanges(source);
    const candidate = resolveFigureCandidates(input).find(value => value.decision === 'compose');
    const draft = composeFigureDraft(input, [{ candidate, assetPath: 'generated/figures/restored.png',
        crop: { data: createTestPNG(), mimeType: 'image/png', width: 8, height: 8 } }]);
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareFigureFixture, hash });
    const figure = document.figureMap.figures[0];
    assert.ok(figure);
    assert.equal(document.assets.at(-1).path, 'generated/figures/restored.png');
    assert.equal(document.assets.at(-1).path, document.assetBasePath + '/' + figure.render.assetPath);
});
