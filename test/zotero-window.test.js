import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createWindowFetch,
    createWindowTimers,
    lifetimeZoteroWindow,
    liveZoteroWindow,
    openWindow,
} from '../src/platform/zotero-window.js';

function notInitialized() {
    const error = new Error('NS_ERROR_NOT_INITIALIZED');
    error.name = 'NS_ERROR_NOT_INITIALIZED';
    return error;
}

// A window whose methods throw once it closes, like a closed Gecko window.
function fakeWindow(name, log) {
    const view = {
        name,
        closed: false,
        fetch(input) {
            if (view.closed) throw notInitialized();
            log.push(`${name}.fetch ${input}`);
            return Promise.resolve({ ok: true, from: name });
        },
        setTimeout(_callback, delay) {
            if (view.closed) throw notInitialized();
            log.push(`${name}.setTimeout ${delay}`);
            return `${name}-timer`;
        },
        clearTimeout(id) {
            if (view.closed) throw notInitialized();
            log.push(`${name}.clearTimeout ${id}`);
        },
    };
    return view;
}

test('skips closed windows and windows whose lookup throws', () => {
    const view = { closed: false };
    assert.equal(openWindow(view), view);
    assert.equal(openWindow(() => view), view);
    assert.equal(openWindow({ closed: true }), null);
    assert.equal(openWindow(() => { throw notInitialized(); }), null);
    assert.equal(openWindow(null), null);
});

test('resolves the live main window before the hidden window', () => {
    const main = { closed: false };
    const hidden = { closed: false };
    const services = { appShell: { hiddenDOMWindow: hidden } };
    assert.equal(liveZoteroWindow({ zotero: { getMainWindow: () => main }, services }), main);
    assert.equal(liveZoteroWindow({ zotero: { getMainWindow: () => null }, services }), hidden);
    assert.equal(liveZoteroWindow({
        zotero: { getMainWindow: () => ({ closed: true }) },
        services,
    }), hidden);
    assert.equal(liveZoteroWindow({
        zotero: { getMainWindow: () => null },
        services: { appShell: { get hiddenDOMWindow() { throw new Error('NS_ERROR_FAILURE'); } } },
    }), null);
});

test('bridges session-long globals from the hidden window before the main window', () => {
    const main = { closed: false };
    const hidden = { closed: false };
    assert.equal(lifetimeZoteroWindow({
        zotero: { getMainWindow: () => main },
        services: { appShell: { hiddenDOMWindow: hidden } },
    }), hidden);
    assert.equal(lifetimeZoteroWindow({
        zotero: { getMainWindow: () => main },
        services: { appShell: { get hiddenDOMWindow() { throw new Error('NS_ERROR_FAILURE'); } } },
    }), main);
});

test('fetches through the window that is open when each request starts', async () => {
    const log = [];
    const first = fakeWindow('first', log);
    const second = fakeWindow('second', log);
    let current = first;
    const windowFetch = createWindowFetch(() => current);

    assert.equal((await windowFetch('https://a.example/')).from, 'first');
    first.closed = true;
    current = second;
    assert.equal((await windowFetch('https://b.example/')).from, 'second');
    assert.deepEqual(log, ['first.fetch https://a.example/', 'second.fetch https://b.example/']);
});

test('uses the fetch fallback only when no window offers fetch', async () => {
    const calls = [];
    const fallback = async input => { calls.push(input); return { from: 'fallback' }; };
    const windowFetch = createWindowFetch(() => null, { fallback });
    assert.equal((await windowFetch('https://a.example/')).from, 'fallback');
    assert.deepEqual(calls, ['https://a.example/']);
    await assert.rejects(createWindowFetch(() => null)('https://a.example/'), TypeError);
});

test('rejects instead of throwing when the window fetch fails synchronously', async () => {
    const view = { fetch() { throw notInitialized(); } };
    const pending = createWindowFetch(() => view)('https://a.example/');
    assert.ok(pending instanceof Promise);
    await assert.rejects(pending, { name: 'NS_ERROR_NOT_INITIALIZED' });
});

test('clears each timer on the window that started it', () => {
    const log = [];
    const first = fakeWindow('first', log);
    const second = fakeWindow('second', log);
    let current = first;
    const timers = createWindowTimers(() => current);

    const firstTimer = timers.setTimer(() => {}, 10);
    current = second;
    const secondTimer = timers.setTimer(() => {}, 20);
    timers.clearTimer(firstTimer);
    timers.clearTimer(secondTimer);
    assert.deepEqual(log, [
        'first.setTimeout 10',
        'second.setTimeout 20',
        'first.clearTimeout first-timer',
        'second.clearTimeout second-timer',
    ]);
});

test('starts no timer without a live window and ignores a closed owner', () => {
    const log = [];
    const view = fakeWindow('only', log);
    const timers = createWindowTimers(() => view);
    const handle = timers.setTimer(() => {}, 10);
    view.closed = true;
    assert.doesNotThrow(() => timers.clearTimer(handle));
    assert.equal(timers.setTimer(() => {}, 10), null);
    assert.doesNotThrow(() => timers.clearTimer(null));
    assert.deepEqual(log, ['only.setTimeout 10']);
});
