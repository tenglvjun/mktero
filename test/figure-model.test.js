import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import {
    validateFigureInput, validateFigureMap, cloneFigureMap, normalizeFigureAssetPath, validateFigureCrop,
} from '../src/figures/figure-model.js';

test('validates figure inputs without changing their data', () => {
    const { input } = makeFigureInput();
    const before = structuredClone(input);
    assert.equal(validateFigureInput(input), input);
    assert.deepEqual(input, before);
    input.blocks[1].sourceRanges = [{ from: 0, to: input.markdown.length + 1 }];
    assert.throws(() => validateFigureInput(input), { code: 'INVALID_FIGURE_RANGE' });
});

test('rejects unknown page units and invalid pixel densities before restoring figures', () => {
    for (const dimensions of [
        { unit: 'cm' }, { unit: null }, { unit: 'px', dpi: 0 },
        { unit: 'px', dpi: -72 }, { unit: 'px', dpi: Number.NaN },
        { unit: 'px', dpi: Number.POSITIVE_INFINITY }, { unit: 'px', dpi: '144' },
        { unit: 'pt', dpi: 192 }, { unit: 'pdf-user-unit', dpi: 192 },
    ]) {
        const { input } = makeFigureInput();
        Object.assign(input.pages[0], dimensions);
        assert.throws(() => validateFigureInput(input), { code: 'INVALID_FIGURE_GEOMETRY' });
    }
    for (const dimensions of [
        { unit: 'pt', dpi: null }, { unit: 'pdf-user-unit', dpi: null },
        { unit: 'px', dpi: 144 }, { unit: 'px', dpi: null },
        { unit: undefined, dpi: null },
    ]) {
        const { input } = makeFigureInput();
        Object.assign(input.pages[0], dimensions);
        assert.equal(validateFigureInput(input), input);
    }
});

test('rejects truncated and damaged PNGs before original source content can be consumed', () => {
    const data = createTestPNG();
    const crop = { data, width: 8, height: 8, mimeType: 'image/png' };
    assert.equal(validateFigureCrop(crop), crop);
    assert.throws(() => validateFigureCrop({ ...crop, data: data.slice(0, -12) }), { code: 'INVALID_FIGURE_PNG' });
    const corrupt = data.slice();
    corrupt[40] ^= 1;
    assert.throws(() => validateFigureCrop({ ...crop, data: corrupt }), { code: 'INVALID_FIGURE_PNG' });
});

test('resolves relative figure assets without permitting escapes or remote paths', () => {
    assert.equal(normalizeFigureAssetPath('images/a%20b.png', 'result'), 'result/images/a b.png');
    assert.equal(normalizeFigureAssetPath('result/images/a.png', 'result'), 'result/result/images/a.png');
    assert.equal(normalizeFigureAssetPath('result/images/a.png'), 'result/images/a.png');
    for (const path of ['../x.png', '%2e%2e/x.png', '/x.png', 'https://x/a.png',
        'C:\\x.png', 'a\u0000.png', 'a//b.png', 'a/./b.png', '%zz']) {
        assert.throws(() => normalizeFigureAssetPath(path, 'result'));
    }
});

test('binds persisted figure maps to their Markdown and local images', () => {
    const markdown = '![Figure 1. Results.](generated/f.png)';
    const asset = { path: 'generated/f.png', mimeType: 'image/png', data: createTestPNG() };
    const map = {
        version: 1, pipeline: 'figure-region-v1', markdownHash: 'a'.repeat(64),
        figures: [{ id: 'fig-p0-b0', label: 'Figure 1.', pageIndex: 0,
            visualBBox: [100, 100, 900, 800], captionBBox: [100, 850, 900, 900],
            memberBlockIds: ['b1'], panels: [{ blockId: 'b1', label: null,
                bbox: [100, 100, 900, 800], originalAssetPath: 'generated/f.png' }],
            render: { mode: 'pdf-region', assetPath: 'generated/f.png', width: 8, height: 8,
                range: { from: 0, to: markdown.length }, captionRanges: [{ from: 2, to: 20 }] },
            provenance: { coordinateFrame: 'display-cropbox', rotation: 0,
                evidence: ['explicit-parent'], fragments: [{ blockId: 'b1', role: 'panel',
                    bbox: [100, 100, 900, 800], markdown: '![](generated/f.png)' }] },
        }], preserved: [],
    };
    const document = { markdown, assets: [asset], persisted: true, markdownHash: 'a'.repeat(64) };
    assert.equal(validateFigureMap(map, document), map);
    const cloned = cloneFigureMap(map);
    cloned.figures[0].visualBBox[0] = 0;
    assert.equal(map.figures[0].visualBBox[0], 100);
    assert.throws(() => validateFigureMap(map, { ...document, markdownHash: 'b'.repeat(64) }));
    assert.throws(() => validateFigureMap(map, { ...document, assets: [] }));
    assert.throws(() => validateFigureMap({ ...map, version: 2 }, document));
    assert.throws(() => validateFigureMap({ ...map, figures: [map.figures[0], map.figures[0]] }, document));
});
