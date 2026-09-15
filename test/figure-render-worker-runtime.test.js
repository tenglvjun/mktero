import test from 'node:test';
import assert from 'node:assert/strict';
import { createFigureRenderWorkerRuntime } from '../src/figures/figure-render-worker-runtime.js';

function fakeRenderer(options = {}) {
    const calls = { opened: 0, disposed: 0, closed: 0, geometries: 0 };
    const session = {
        async getPageGeometry(pageIndex, { signal } = {}) {
            calls.geometries++;
            if (signal?.aborted) throw abortError();
            return { pageIndex, width: 100, height: 100, rotation: 0 };
        },
        async renderRegion(request, { signal } = {}) {
            if (options.pendingRegion) {
                await new Promise((resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(signal.reason || abortError()), { once: true });
                });
            }
            return { mimeType: 'image/png', data: new Uint8Array([1, 2, 3]), width: 1, height: 1, request };
        },
        async renderPageCrops(request) {
            return { dpi: request.dpi, crops: [{ id: 'a', crop: { mimeType: 'image/png', data: new Uint8Array([1]), width: 1, height: 1 } }] };
        },
        async recoverImageGroup(request) { return { recovered: request }; },
        async verifyFigureOrder(request) { return { ordered: request }; },
        async close() { calls.closed++; },
    };
    return {
        calls,
        factory: () => ({
            open: async fileData => { calls.opened++; calls.fileData = fileData; return session; },
            disposeAll: async () => { calls.disposed++; },
        }),
    };
}

test('dispatches figure render operations against a session', async () => {
    const { calls, factory } = fakeRenderer();
    const runtime = createFigureRenderWorkerRuntime({ createRenderer: factory });
    await runtime.handle({ id: 1, op: 'open', sessionId: 's1', payload: { fileData: new Uint8Array([9, 9]).buffer } });
    assert.equal(calls.opened, 1);
    assert.deepEqual([...calls.fileData], [9, 9]);
    const geometry = await runtime.handle({ id: 2, op: 'getPageGeometry', sessionId: 's1', payload: { pageIndex: 3 } });
    assert.equal(geometry.pageIndex, 3);
    const crop = await runtime.handle({ id: 3, op: 'renderRegion', sessionId: 's1', payload: { request: { pageIndex: 0 } } });
    assert.equal(crop.request.pageIndex, 0);
    const pageCrops = await runtime.handle({ id: 4, op: 'renderPageCrops', sessionId: 's1', payload: { request: { dpi: 192 } } });
    assert.equal(pageCrops.crops.length, 1);
    const recovered = await runtime.handle({ id: 5, op: 'recoverImageGroup', sessionId: 's1', payload: { request: { a: 1 } } });
    assert.deepEqual(recovered.recovered, { a: 1 });
    const ordered = await runtime.handle({ id: 6, op: 'verifyFigureOrder', sessionId: 's1', payload: { request: { b: 2 } } });
    assert.deepEqual(ordered.ordered, { b: 2 });
    await runtime.handle({ id: 7, op: 'close', sessionId: 's1' });
    assert.equal(calls.closed, 1);
});

test('rejects operations for unknown sessions', async () => {
    const runtime = createFigureRenderWorkerRuntime({ createRenderer: fakeRenderer().factory });
    await assert.rejects(
        runtime.handle({ id: 1, op: 'renderRegion', sessionId: 'missing', payload: { request: {} } }),
        /session is unknown/u
    );
});

test('cancels an in-flight operation through a cancel message', async () => {
    const { factory } = fakeRenderer({ pendingRegion: true });
    const runtime = createFigureRenderWorkerRuntime({ createRenderer: factory });
    await runtime.handle({ id: 1, op: 'open', sessionId: 's1', payload: { fileData: new ArrayBuffer(1) } });
    const inFlight = runtime.handle({ id: 2, op: 'renderRegion', sessionId: 's1', payload: { request: {} } });
    await runtime.handle({ id: 3, op: 'cancel', sessionId: 's1', payload: { targetId: 2 } });
    await assert.rejects(inFlight, { name: 'AbortError' });
});

test('reuses PDF asset bytes for every session renderer', async () => {
    const seen = [];
    const runtime = createFigureRenderWorkerRuntime({ createRenderer: options => {
        seen.push(options);
        return {
            open: async () => ({ close: async () => {} }),
            disposeAll: async () => {},
        };
    } });
    const assets = { 'standardFontDataUrl:LiberationSans-Regular.ttf': new Uint8Array([1, 2, 3]) };
    await runtime.handle({ id: 1, op: 'open', sessionId: 's1',
        payload: { fileData: new ArrayBuffer(1), options: { assets } } });
    await runtime.handle({ id: 2, op: 'open', sessionId: 's2',
        payload: { fileData: new ArrayBuffer(1), options: {} } });
    assert.deepEqual(seen[0].assets, assets);
    assert.deepEqual(seen[1].assets, assets, 'later sessions must keep the loaded fonts');
});

test('keeps the PDF session scope alive across operations and aborts it on close', async () => {
    let openSignal = null;
    const session = {
        async getPageGeometry() {
            if (openSignal?.aborted) throw abortError();
            return { pageIndex: 0 };
        },
        async close() {},
    };
    const runtime = createFigureRenderWorkerRuntime({ createRenderer: () => ({
        open: async (fileData, { signal } = {}) => { openSignal = signal; return session; },
        disposeAll: async () => {},
    }) });
    await runtime.handle({ id: 1, op: 'open', sessionId: 's1', payload: { fileData: new ArrayBuffer(1) } });
    assert.equal(openSignal.aborted, false);
    await runtime.handle({ id: 2, op: 'getPageGeometry', sessionId: 's1', payload: { pageIndex: 0 } });
    await runtime.handle({ id: 3, op: 'close', sessionId: 's1' });
    assert.equal(openSignal.aborted, true);
});

test('disposes every renderer and closes sessions', async () => {
    const { calls, factory } = fakeRenderer();
    const runtime = createFigureRenderWorkerRuntime({ createRenderer: factory });
    await runtime.handle({ id: 1, op: 'open', sessionId: 's1', payload: { fileData: new ArrayBuffer(1) } });
    await runtime.disposeAll();
    assert.equal(calls.disposed, 1);
    assert.equal(calls.closed, 1);
    await assert.rejects(runtime.handle({ id: 2, op: 'open', sessionId: 's2', payload: {} }), /closed/u);
});

function abortError() {
    const error = new Error('aborted');
    error.name = 'AbortError';
    return error;
}
