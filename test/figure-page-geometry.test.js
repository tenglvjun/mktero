import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFigureInput } from './helpers/figure-fixtures.js';
import { alignFigureInputToPDF } from '../src/figures/figure-model.js';

function geometry(rotation = 0, userUnit = 1) {
    const transforms = {
        0: [1, 0, 0, -1, -50, 870],
        90: [0, 1, 1, 0, -70, -50],
        180: [-1, 0, 0, 1, 650, -70],
        270: [0, -1, -1, 0, 870, 650],
    };
    return {
        pageIndex: 0, rotation, userUnit, coordinateFrame: 'display-cropbox',
        width: (rotation % 180 ? 800 : 600) * userUnit,
        height: (rotation % 180 ? 600 : 800) * userUnit,
        viewBox: [50, 70, 650, 870], mediaBox: null,
        viewportTransform: transforms[rotation].map(value => value * userUnit),
    };
}

test('aligns unrotated boxes through every PDF rotation and nonzero CropBox', () => {
    const expected = {
        0: [100, 200, 400, 500],
        90: [500, 100, 800, 400],
        180: [600, 500, 900, 800],
        270: [200, 600, 500, 900],
    };
    for (const rotation of [0, 90, 180, 270]) {
        for (const userUnit of [1, 2]) {
            const { input } = makeFigureInput();
            Object.assign(input.pages[0], { width: 600 * userUnit, height: 800 * userUnit,
                coordinateFrame: 'unrotated-cropbox', rotation: 0 });
            input.blocks[1].bbox = [100, 200, 400, 500];
            const before = structuredClone(input);
            const aligned = alignFigureInputToPDF(input, new Map([[0, geometry(rotation, userUnit)]]));
            assert.equal(aligned.pages[0].geometryReason, undefined);
            assert.deepEqual(aligned.blocks[1].bbox, expected[rotation]);
            assert.deepEqual(aligned.blocks[1].sourceBBox, before.blocks[1].bbox);
            assert.equal(aligned.pages[0].rotation, rotation);
            assert.deepEqual(input, before);
        }
    }
});

test('keeps displayed boxes oriented once and converts explicit pixel DPI', () => {
    const { input } = makeFigureInput();
    Object.assign(input.pages[0], { width: 1600, height: 1200, unit: 'px', dpi: 144,
        coordinateFrame: 'display-cropbox', rotation: null });
    const aligned = alignFigureInputToPDF(input, new Map([[0, geometry(90)]]));
    assert.deepEqual(aligned.blocks[1].bbox, input.blocks[1].bbox);
    assert.equal(aligned.pages[0].rotation, 90);
    assert.equal(aligned.pages[0].width, 800);
    assert.equal(aligned.pages[0].unit, 'pt');
});

test('aligns equivalent page units without applying UserUnit twice', () => {
    for (const rotation of [0, 90, 180, 270]) {
        const page = geometry(rotation, 2);
        for (const dimensions of [
            { width: page.width / 2, height: page.height / 2, unit: 'pdf-user-unit', dpi: null },
            { width: page.width, height: page.height, unit: 'pt', dpi: null },
            { width: page.width * 2, height: page.height * 2, unit: 'px', dpi: 144 },
        ]) {
            const { input } = makeFigureInput();
            Object.assign(input.pages[0], dimensions, { rotation: null });
            const result = alignFigureInputToPDF(input, [page]);
            assert.equal(result.pages[0].geometryReason, undefined);
            assert.equal(result.pages[0].width, page.width);
            assert.equal(result.pages[0].height, page.height);
            assert.deepEqual(result.blocks.map(block => block.bbox), input.blocks.map(block => block.bbox));
        }
        const { input } = makeFigureInput();
        Object.assign(input.pages[0], { width: page.width, height: page.height,
            unit: 'pdf-user-unit', rotation: null });
        assert.equal(alignFigureInputToPDF(input, [page]).pages[0].geometryReason, 'coordinate-mismatch');
    }
});

test('refuses unknown frames, mismatched dimensions and unsupported MediaBox data', () => {
    for (const source of [
        { coordinateFrame: 'unknown' },
        { coordinateFrame: 'unrotated-mediabox' },
        { width: 100 },
        { rotation: 180 },
    ]) {
        const { input } = makeFigureInput();
        Object.assign(input.pages[0], { width: 600, height: 800, ...source });
        const result = alignFigureInputToPDF(input, new Map([[0, geometry()]]));
        assert.ok(['missing-geometry', 'coordinate-mismatch'].includes(result.pages[0].geometryReason));
    }
});

test('uses an independently supplied MediaBox and rejects boxes outside the visible page', () => {
    const { input } = makeFigureInput();
    Object.assign(input.pages[0], { width: 700, height: 900, coordinateFrame: 'unrotated-mediabox' });
    input.blocks = [{ ...input.blocks[1], bbox: [100, 200, 400, 500] }];
    input.contentList = [];
    const page = { ...geometry(), mediaBox: [0, 0, 700, 900] };
    const result = alignFigureInputToPDF(input, new Map([[0, page]]));
    assert.equal(result.pages[0].geometryReason, undefined);
    assert.deepEqual(result.blocks[0].bbox.map(Math.round), [33, 188, 383, 525]);
    input.blocks[0].bbox = [0, 0, 100, 100];
    const rejected = alignFigureInputToPDF(input, new Map([[0, page]]));
    assert.equal(rejected.pages[0].geometryReason, 'coordinate-mismatch');
});
