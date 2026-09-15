import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { sha256Hex } from '../src/core/sha256.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';
import {
    buildProgressiveFigureDocument,
    pendingFigureAssetPaths,
} from '../src/figures/figure-progressive.js';
import { replacePendingFigureImages } from '../src/editor/figure-placeholder.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });

async function planFor(input) {
    const service = new FigureRestorationService({
        hash,
        openPDF: async () => ({
            getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
                rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
                viewBox: [0, 0, 1000, 1000], mediaBox: null, viewportTransform: [1, 0, 0, -1, 0, 1000] }),
            close: async () => {},
        }),
    });
    return service.restore(input, { fileData: Uint8Array.of(1), mode: 'plan' });
}

test('builds an immediately readable document that keeps pending OCR panels', async () => {
    const { input } = makeFigureInput();
    const document = await buildProgressiveFigureDocument(input, [], { prepare: prepareMinerUResult });
    assert.ok(document.markdown.includes('images/panel-0.png'));
    assert.equal(document.figureMap, undefined);
});

test('replaces a completed figure and drops its original OCR panels', async () => {
    const { input } = makeFigureInput();
    const plan = await planFor(input);
    const candidate = plan.candidates.find(value => value.decision === 'compose');
    assert.ok(candidate);
    const entry = { candidate, crop: { data: createTestPNG(800, 750), mimeType: 'image/png', width: 800, height: 750 },
        assetPath: 'generated/figures/fig-p0-b0-abcd.png' };
    const document = await buildProgressiveFigureDocument(plan.input, [entry], { prepare: prepareMinerUResult });
    assert.ok(document.markdown.includes('generated/figures/fig-p0-b0-abcd.png'));
    assert.ok(!document.markdown.includes('images/panel-0.png'));
});

test('maps pending figure panels to their figure id', async () => {
    const { input } = makeFigureInput();
    const plan = await planFor(input);
    const candidate = plan.candidates.find(value => value.decision === 'compose');
    const pending = pendingFigureAssetPaths(plan.input, plan.candidates, []);
    const panel = plan.input.blocks.find(block => block.id === candidate.panelBlockIds[0]);
    assert.equal(pending.get(panel.assetPath), candidate.id);
    const done = pendingFigureAssetPaths(plan.input, plan.candidates, [candidate.id]);
    assert.equal(done.size, 0);
});

test('swaps pending panel images for a single placeholder per figure', () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>');
    const { document } = dom.window;
    const host = document.getElementById('host');
    host.innerHTML = '<p><img data-mktero-asset="images/panel-0.png" alt="a">'
        + '<img data-mktero-asset="images/panel-1.png" alt="b"></p>'
        + '<p><img data-mktero-asset="images/panel-2.png" alt="c"></p>';
    const pending = new Map([
        ['images/panel-0.png', 'fig-1'],
        ['images/panel-1.png', 'fig-1'],
        ['images/panel-2.png', 'fig-2'],
    ]);
    const count = replacePendingFigureImages(host, pending);
    assert.equal(count, 2);
    assert.equal(host.querySelectorAll('img').length, 0);
    const placeholders = host.querySelectorAll('.mktero-figure-placeholder');
    assert.equal(placeholders.length, 2);
    assert.deepEqual([...placeholders].map(node => node.getAttribute('data-figure-id')), ['fig-1', 'fig-2']);
});
