import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerFigureRegionRenderer } from '../src/figures/figure-render-worker-client.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

function validCrop(width = 8, height = 8) {
    return { mimeType: 'image/png', data: createTestPNG(width, height), width, height };
}

class FakeWorker {
    constructor(handler) {
        this.handler = handler;
        this.listeners = new Map();
        this.terminated = false;
        this.messages = [];
    }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }
    dispatch(type, event) {
        for (const listener of this.listeners.get(type) || []) listener(event);
    }
    postMessage(message) {
        this.messages.push(message);
        Promise.resolve().then(async () => {
            if (message.op === 'cancel') return;
            const reply = await this.handler(message);
            if (reply === undefined) return;
            if (reply instanceof Error) this.dispatch('error', { message: reply.message });
            else this.dispatch('message', { data: reply });
        });
    }
    terminate() { this.terminated = true; }
}

function harness(handler) {
    const worker = new FakeWorker(handler);
    const renderer = createWorkerFigureRegionRenderer({
        workerSource: 'self.onmessage = () => {};',
        createWorker: () => worker,
        createObjectURL: () => 'blob:fake',
        revokeObjectURL: () => {},
        requestTimeoutMs: 5000,
    });
    return { worker, renderer };
}

test('round-trips open, geometry, region, page crops and close', async () => {
    const calls = [];
    const { renderer, worker } = harness(message => {
        calls.push(message.op);
        switch (message.op) {
            case 'open': return { id: message.id, ok: true, value: null };
            case 'getPageGeometry': return { id: message.id, ok: true, value: { pageIndex: message.payload.pageIndex } };
            case 'renderRegion': return { id: message.id, ok: true, value: validCrop() };
            case 'renderPageCrops':
                return { id: message.id, ok: true, value: { dpi: 192, crops: [{ id: 'a', crop: validCrop(4, 4) }] } };
            case 'close': return { id: message.id, ok: true, value: null };
            default: return { id: message.id, ok: true, value: null };
        }
    });
    const session = await renderer.open(Uint8Array.of(1, 2, 3));
    assert.deepEqual(await session.getPageGeometry(2), { pageIndex: 2 });
    const crop = await session.renderRegion({ pageIndex: 0, bbox: [0, 0, 10, 10] });
    assert.equal(crop.width, 8);
    const pageCrops = await session.renderPageCrops({ pageIndex: 0, dpi: 192, regions: [] });
    assert.equal(pageCrops.crops[0].crop.width, 4);
    await session.close();
    assert.deepEqual(calls, ['open', 'getPageGeometry', 'renderRegion', 'renderPageCrops', 'close']);
    await renderer.disposeAll();
    assert.ok(worker.terminated);
});

test('rejects a malformed PNG response', async () => {
    const { renderer } = harness(message => {
        if (message.op === 'renderRegion') {
            return { id: message.id, ok: true, value: { mimeType: 'image/png', data: new Uint8Array(10), width: 1, height: 1 } };
        }
        return { id: message.id, ok: true, value: null };
    });
    const session = await renderer.open(Uint8Array.of(1));
    await assert.rejects(session.renderRegion({}), { code: 'INVALID_FIGURE_PNG' });
    await renderer.disposeAll();
});

test('aborting a request sends a cancel message and rejects', async () => {
    const { renderer, worker } = harness(message => (message.op === 'open'
        ? { id: message.id, ok: true, value: null } : undefined));
    const session = await renderer.open(Uint8Array.of(1));
    const controller = new AbortController();
    const pending = session.renderRegion({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(worker.messages.some(message => message.op === 'cancel'), 'cancel message expected');
    await renderer.disposeAll();
});

test('rejects when the worker does not answer in time', async () => {
    const { renderer } = harness(message => (message.op === 'open'
        ? { id: message.id, ok: true, value: null } : undefined));
    const session = await renderer.open(Uint8Array.of(1));
    const fast = createWorkerFigureRegionRenderer({
        workerSource: 'x', createWorker: () => new FakeWorker(message => (message.op === 'open'
            ? { id: message.id, ok: true, value: null } : undefined)),
        createObjectURL: () => 'blob:fake', revokeObjectURL: () => {}, requestTimeoutMs: 10,
    });
    const fastSession = await fast.open(Uint8Array.of(1));
    await assert.rejects(fastSession.renderRegion({}), { name: 'TimeoutError' });
    await renderer.disposeAll();
    await fast.disposeAll();
});

test('falls back to the main-thread renderer after a worker error', async () => {
    let opened = 0;
    const fallback = {
        open: async () => { opened++; return { close: async () => {} }; },
    };
    const worker = new FakeWorker(message => (message.op === 'open'
        ? { id: message.id, ok: true, value: null } : undefined));
    const renderer = createWorkerFigureRegionRenderer({
        workerSource: 'x', createWorker: () => worker,
        createObjectURL: () => 'blob:fake', revokeObjectURL: () => {}, fallback,
    });
    const first = await renderer.open(Uint8Array.of(1));
    assert.ok(first);
    worker.dispatch('error', { message: 'boom' });
    await new Promise(resolve => setImmediate(resolve));
    await renderer.open(Uint8Array.of(1));
    assert.equal(opened, 1);
    await renderer.disposeAll();
});
