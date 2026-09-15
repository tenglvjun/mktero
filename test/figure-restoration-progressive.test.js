import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { sha256Hex } from '../src/core/sha256.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });
const crop = () => ({ data: createTestPNG(800, 750), mimeType: 'image/png', width: 800, height: 750 });

function service({ withPageCrops = true } = {}) {
    const pageCropCalls = [];
    const regionCalls = [];
    let closed = 0;
    const session = {
        getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
            rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
            viewBox: [0, 0, 1000, 1000], mediaBox: null, viewportTransform: [1, 0, 0, -1, 0, 1000] }),
        renderRegion: async () => { regionCalls.push(1); return crop(); },
        close: async () => { closed++; },
    };
    if (withPageCrops) {
        session.renderPageCrops = async request => {
            pageCropCalls.push(request);
            return { dpi: request.dpi, crops: request.regions.map(region => ({ id: region.id, crop: crop() })) };
        };
    }
    const restoration = new FigureRestorationService({ hash, openPDF: async () => session });
    return { restoration, pageCropCalls, regionCalls, closed: () => closed };
}

test('renders each page once and reports every figure through onFigure', async () => {
    const { input } = makeFigureInput();
    const { restoration, pageCropCalls, regionCalls, closed } = service();
    const events = [];
    const draft = await restoration.restore(input, {
        fileData: Uint8Array.of(1), onFigure: event => events.push(event),
    });
    assert.equal(pageCropCalls.length, 1);
    assert.equal(regionCalls.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'composed');
    assert.equal(events[0].id, draft.blueprints[0].id);
    assert.equal(typeof events[0].replacement, 'string');
    assert.ok(events[0].asset.data.byteLength > 0);
    assert.equal(draft.blueprints.length, 1);
    assert.equal(closed(), 1);
});

test('plan mode returns placeholders without rendering', async () => {
    const { input } = makeFigureInput();
    const { restoration, pageCropCalls, regionCalls, closed } = service();
    const plan = await restoration.restore(input, { fileData: Uint8Array.of(1), mode: 'plan' });
    assert.equal(pageCropCalls.length, 0);
    assert.equal(regionCalls.length, 0);
    assert.equal(plan.placeholders.length, 1);
    assert.ok(plan.placeholders[0].ranges.length >= 1);
    assert.equal(plan.placeholders[0].id, plan.candidates.find(candidate => candidate.decision === 'compose').id);
    assert.equal(closed(), 1);
});

test('falls back to per-candidate rendering when page crops are unavailable', async () => {
    const { input } = makeFigureInput();
    const { restoration, regionCalls } = service({ withPageCrops: false });
    const draft = await restoration.restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(regionCalls.length, 1);
    assert.equal(draft.blueprints.length, 1);
});
