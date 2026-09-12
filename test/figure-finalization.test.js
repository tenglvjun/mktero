import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';
import { sha256Hex } from '../src/core/sha256.js';
import { validateFigureMap } from '../src/figures/figure-model.js';

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

test('binds the final image and caption to the Markdown hash and separate PDF locations', async () => {
    const { input, draft } = fixture();
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
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
    assert.deepEqual(prepareMinerUResult(document), document);
    assert.equal(document.providerState, undefined);
    assert.equal(document.blocks, undefined);
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
        prepare: prepareMinerUResult, signal: controller.signal,
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
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    const figure = document.figureMap.figures[0];
    assert.ok(figure);
    assert.equal(document.assets.at(-1).path, 'generated/figures/restored.png');
    assert.equal(document.assets.at(-1).path, document.assetBasePath + '/' + figure.render.assetPath);
});
