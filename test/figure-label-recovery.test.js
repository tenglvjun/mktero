import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../src/core/sha256.js';
import { collectFigureLabelGroups, FigureLabelRecoveryService } from '../src/figures/figure-label-recovery.js';
import { validateFigureMap } from '../src/figures/figure-model.js';
import { mapFigureMapThroughEdits } from '../src/figures/figure-map-transforms.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

function fixture(count = 2, fullwidth = false, { sameParagraph = false, figureNumber = 7, pageIndex = 3 } = {}) {
    let markdown = 'See Fig. 7(A).\n\n';
    const assets = [];
    const sourceMap = [];
    for (let index = 0; index < count; index++) {
        const letter = String.fromCharCode(65 + index);
        const label = fullwidth ? `\uFF08${letter}\uFF09` : `(${letter})`;
        const path = `images/figure-${figureNumber}-panel-${index}.png`;
        const from = markdown.length;
        const ending = sameParagraph && index < count - 1 ? '\n' : '\n\n';
        markdown += `${label}   \n![${index === count - 1 ? `Fig. ${figureNumber} Response (a) first, (b) second.` : ''}](${path})${ending}`;
        const column = index % 4;
        const row = Math.floor(index / 4);
        sourceMap.push({ type: 'image', markdownFrom: from, markdownTo: markdown.length - ending.length,
            locations: [{ pageIndex, bbox: [100 + column * 200, 100 + row * 150,
                250 + column * 200, 200 + row * 150] }] });
        assets.push({ path, mimeType: 'image/png', data: createTestPNG() });
    }
    const from = markdown.length;
    markdown += 'Body (A) and (B) must remain.\n';
    sourceMap.push({ type: 'text', markdownFrom: from, markdownTo: markdown.length - 1,
        locations: [{ pageIndex, bbox: [100, 900, 900, 950] }] });
    return { markdown, assets, sourceMap, assetBasePath: '', chromeRanges: [],
        figureMap: { version: 1, pipeline: 'figure-region-v1', markdownHash: null,
            figures: [], preserved: [{ id: 'fig-p3-b1', pageIndex: 3, reason: 'missing-geometry' }] } };
}

function harness(options = {}) {
    let opens = 0;
    let closes = 0;
    const calls = [];
    const service = new FigureLabelRecoveryService({ hash: sha256Hex,
        openPDF: async () => {
            opens++;
            return {
                recoverImageGroup: async request => {
                    calls.push(request);
                    return { bbox: [80, 50, 920, 850], captionBBox: [80, 855, 920, 890], rotation: 0,
                        crop: { mimeType: 'image/png', data: createTestPNG(80, 80), width: 80, height: 80 } };
                },
                close: async () => { closes++; },
                ...options.session,
            };
        }, ...options });
    return { service, calls, counts: () => ({ opens, closes }) };
}

for (const count of [2, 4, 16]) {
    test(`recovers ${count} labeled panels atomically and keeps caption and body references`, async () => {
        const original = fixture(count, count === 4);
        const h = harness();
        const result = await h.service.recover(original, { fileData: Uint8Array.of(1) });
        assert.notEqual(result.markdown, original.markdown);
        assert.doesNotMatch(result.markdown, /^\s*[\uFF08(][A-Z][\uFF09)]\s*$/mu);
        assert.match(result.markdown, /See Fig\. 7\(A\)/);
        assert.match(result.markdown, /Response \(a\) first, \(b\) second/);
        assert.match(result.markdown, /Body \(A\) and \(B\) must remain/);
        assert.equal(result.figureMap.figures.length, 1);
        assert.equal(result.figureMap.figures[0].panels.length, count);
        assert.equal(result.figureMap.figures[0].panels[0].label, 'a');
        assert.equal(result.assets.length, original.assets.length + 1);
        assert.match(result.figureMap.figures[0].provenance.fragments[0].markdown,
            /images\/figure-7-panel-0/);
        assert.equal(result.markdown.slice(result.sourceMap.at(-1).markdownFrom,
            result.sourceMap.at(-1).markdownTo), 'Body (A) and (B) must remain.');
        validateFigureMap(result.figureMap, result);
        assert.deepEqual(h.counts(), { opens: 1, closes: 1 });
        assert.equal(await h.service.recover(result, { fileData: Uint8Array.of(1) }), result);
        assert.deepEqual(h.counts(), { opens: 1, closes: 1 });
    });
}

test('recognizes irregular panel positions without deriving a rectangular grid', () => {
    const document = fixture(4);
    document.sourceMap[1].locations[0].bbox = [600, 120, 900, 250];
    document.sourceMap[2].locations[0].bbox = [120, 350, 480, 700];
    document.sourceMap[3].locations[0].bbox = [550, 500, 800, 750];
    assert.equal(collectFigureLabelGroups(document).length, 1);
});

for (const mode of ['unverified', 'render-failed', 'invalid-crop']) {
    test(`preserves the original document when recovery is ${mode}`, async () => {
        const original = fixture();
        const h = harness({ session: { recoverImageGroup: async () => {
            if (mode === 'unverified') return null;
            if (mode === 'render-failed') throw new Error('Canvas unavailable');
            return { bbox: [0, 0, 1000, 1000], rotation: 0, crop: { data: Uint8Array.of(1) } };
        } } });
        assert.equal(await h.service.recover(original, { fileData: Uint8Array.of(1) }), original);
        assert.deepEqual(h.counts(), { opens: 1, closes: 1 });
    });
}

test('does not rewrite edited content, lists, code, repeated labels, or unmapped images', async () => {
    for (const mutate of [
        document => { document.userEdited = true; },
        document => { document.markdown = '```\n' + document.markdown + '\n```'; },
        document => { document.markdown = document.markdown.replace('(B)', '(A)'); },
        document => { document.sourceMap = []; },
        document => { document.sourceMap[1].locations[0].pageIndex = 4; },
        document => { document.markdown = document.markdown.replace('(A)   ', '1. (A)'); },
        document => { document.assets = []; },
        document => { document.markdown += '\n![](images/figure-7-panel-0.png)'; },
        document => { document.markdown += '\n![](images/figure-7-%70anel-0.png)'; },
        document => { document.assets.push({ ...document.assets[0] }); },
        document => { document.markdown += '\n![](https://example.test/image.png)'; document.assets = []; },
        document => { document.sourceMap.push(null); },
    ]) {
        const document = fixture();
        mutate(document);
        const h = harness();
        assert.equal(await h.service.recover(document, { fileData: Uint8Array.of(1) }), document);
        assert.equal(h.counts().opens, 0);
    }
});

test('recovers label and image rows joined by hard breaks in a single paragraph', async () => {
    const original = fixture(2, false, { sameParagraph: true });
    const result = await harness().service.recover(original);
    assert.equal(result.figureMap.figures.length, 1);
    assert.doesNotMatch(result.markdown, /^\([AB]\)\s*$/mu);
    assert.match(result.markdown, /Body \(A\) and \(B\) must remain/);
});

test('resolves nested asset roots and preserves existing generated assets on a path collision', async () => {
    const original = fixture();
    original.assetBasePath = 'result/paper';
    original.assets = original.assets.map(asset => ({ ...asset, path: 'result/paper/' + asset.path }));
    const h = harness();
    const result = await h.service.recover(original);
    assert.equal(result.figureMap.figures.length, 1);
    assert.equal(result.assets.at(-1).path, 'result/paper/' + result.figureMap.figures[0].render.assetPath);
    validateFigureMap(result.figureMap, result);
    original.assets.push(result.assets.at(-1));
    assert.equal(await h.service.recover(original), original);
});

test('remaps source details, hidden ranges, and an existing restored figure after recovery', async () => {
    const h = harness();
    const existing = await h.service.recover(fixture());
    const pending = fixture(2, false, { figureNumber: 8, pageIndex: 4 });
    const body = pending.sourceMap.at(-1);
    body.locationRanges = [{ markdownFrom: body.markdownFrom, markdownTo: body.markdownTo,
        location: body.locations[0] }];
    const shift = pending.markdown.length + 1;
    const markdown = pending.markdown + '\n' + existing.markdown;
    const figureMap = mapFigureMapThroughEdits(existing.figureMap,
        [{ from: 0, to: 0, replacementLength: shift }], markdown);
    const original = { ...pending, markdown, figureMap,
        assets: [...pending.assets, ...existing.assets],
        chromeRanges: [{ from: body.markdownFrom, to: body.markdownTo }],
        sourceMap: [...pending.sourceMap, ...existing.sourceMap.map(entry => ({
            ...entry, markdownFrom: entry.markdownFrom + shift, markdownTo: entry.markdownTo + shift,
            ...(entry.locationRanges ? { locationRanges: entry.locationRanges.map(range => ({
                ...range, markdownFrom: range.markdownFrom + shift, markdownTo: range.markdownTo + shift,
            })) } : {}),
        }))],
    };
    const result = await h.service.recover(original);
    assert.deepEqual(result.figureMap.figures.map(figure => figure.label), ['Fig. 8', 'Fig. 7']);
    assert.deepEqual(result.figureMap.figures[1].provenance, existing.figureMap.figures[0].provenance);
    const text = result.sourceMap.find(entry => entry.type === 'text' && entry.locations[0].pageIndex === 4);
    assert.equal(result.markdown.slice(text.locationRanges[0].markdownFrom, text.locationRanges[0].markdownTo),
        'Body (A) and (B) must remain.');
    assert.deepEqual(result.chromeRanges, [{ from: text.markdownFrom, to: text.markdownTo }]);
    validateFigureMap(result.figureMap, result);
});

test('cancels recovery without applying a completed crop and closes the PDF', async () => {
    const controller = new AbortController();
    const h = harness({ session: { recoverImageGroup: async () => {
        controller.abort();
        return null;
    } } });
    await assert.rejects(h.service.recover(fixture(), { fileData: Uint8Array.of(1), signal: controller.signal }),
        { name: 'AbortError' });
    assert.deepEqual(h.counts(), { opens: 1, closes: 1 });
});
