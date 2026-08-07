import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as preferencesUI from '../src/ui/preferences.js';

const {
    createCombinedLocalCache,
    createPreferencesController,
    formatCacheStats,
} = preferencesUI;

test('formats cache statistics for the preferences pane', () => {
    assert.equal(
        formatCacheStats({ entries: 0, sizeBytes: 0 }),
        'No local cache entries'
    );
    assert.equal(
        formatCacheStats({ entries: 2, sizeBytes: 1536 }),
        '2 local cache entries, 1.5 KB'
    );
});

test('combines Markdown and PDF index cache usage and clears both', async () => {
    const cleared = [];
    const cache = createCombinedLocalCache([{
        getStats: async () => ({ entries: 2, sizeBytes: 1536 }),
        clear: async () => { cleared.push('markdown'); },
    }, {
        getStats: async () => ({ entries: 3, sizeBytes: 2560 }),
        clear: async () => { cleared.push('pdf-index'); },
    }]);

    assert.deepEqual(await cache.getStats(), {
        entries: 5,
        sizeBytes: 4096,
    });
    await cache.clear();
    assert.deepEqual(cleared.sort(), ['markdown', 'pdf-index']);
});

test('loads cache usage and clears it from the preferences pane', async () => {
    const status = createControl({ textContent: '' });
    const button = {
        disabled: false,
        addEventListener(_type, listener) {
            this.listener = listener;
        },
    };
    const document = {
        getElementById(id) {
            if (id === 'mktero-cache-status') return status;
            if (id === 'mktero-clear-cache') return button;
        },
    };
    let stats = { entries: 2, sizeBytes: 1536 };
    let clearCalls = 0;
    let finishClear;
    const cache = {
        getStats: async () => stats,
        clear: async () => {
            clearCalls++;
            await new Promise(resolve => {
                finishClear = resolve;
            });
            stats = { entries: 0, sizeBytes: 0 };
        },
    };
    const controller = createPreferencesController({
        document,
        zotero: { logError: assert.fail },
        cache,
    });

    await controller.init();
    assert.equal(status.textContent, '2 local cache entries, 1.5 KB');
    assert.equal(status.attributes['aria-busy'], 'false');

    const clearing = button.listener();
    assert.equal(clearCalls, 1);
    assert.equal(button.disabled, true);
    assert.equal(status.textContent, 'Clearing cache...');
    assert.equal(status.attributes['aria-busy'], 'true');

    finishClear();
    await clearing;
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, 'No local cache entries');
    assert.equal(status.attributes['aria-busy'], 'false');
});

test('restores cache controls when clearing the cache fails', async () => {
    const status = createControl({ textContent: '' });
    const button = createControl();
    const document = {
        getElementById(id) {
            if (id === 'mktero-cache-status') return status;
            if (id === 'mktero-clear-cache') return button;
        },
    };
    const failure = new Error('cache unavailable');
    let loggedError;
    const controller = createPreferencesController({
        document,
        zotero: { logError: error => { loggedError = error; } },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => { throw failure; },
        },
    });

    await controller.init();
    await button.dispatch('click');

    assert.equal(loggedError, failure);
    assert.equal(button.disabled, false);
    assert.equal(status.textContent, 'Cache could not be cleared');
    assert.equal(status.attributes['aria-busy'], 'false');
});

test('configures the Markdown reader font size from preferences', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <input id="mktero-reader-font-size" type="range" min="16" max="22">
            <output id="mktero-reader-font-size-value"></output>
            <select id="mktero-reader-font-family">
                <option value="system-serif">System serif</option>
                <option value="georgia">Georgia</option>
                <option value="cambria">Cambria</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const writes = [];
    const zotero = {
        Prefs: {
            get: key => key === 'extensions.mktero.readerFontSize' ? 20 : null,
            set: (key, value, global) => writes.push({ key, value, global }),
        },
        logError: assert.fail,
    };
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero,
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const input = dom.window.document.getElementById('mktero-reader-font-size');
    const value = dom.window.document.getElementById(
        'mktero-reader-font-size-value'
    );
    assert.equal(input.value, '20');
    assert.equal(value.textContent, '20 px');

    input.value = '22';
    input.dispatchEvent(new dom.window.Event('input'));
    assert.deepEqual(writes, [{
        key: 'extensions.mktero.readerFontSize',
        value: 22,
        global: true,
    }]);
    assert.equal(value.textContent, '22 px');

    const font = dom.window.document.getElementById('mktero-reader-font-family');
    assert.equal(font.value, 'system-serif');
    font.value = 'cambria';
    font.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(writes, [
        {
            key: 'extensions.mktero.readerFontSize',
            value: 22,
            global: true,
        },
        {
            key: 'extensions.mktero.readerFont',
            value: 'cambria',
            global: true,
        },
    ]);

    controller.destroy();
    input.value = '21';
    input.dispatchEvent(new dom.window.Event('input'));
    font.value = 'georgia';
    font.dispatchEvent(new dom.window.Event('change'));
    assert.equal(writes.length, 2);
});

test('localizes preferences from Zotero without storing a language choice', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <h2 data-i18n="preferences.conversion.title"></h2>
            <strong data-i18n="preferences.cache.usageLabel"></strong>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache" data-i18n="preferences.cache.clear"></button>
        </section>
    </body>`);
    const { document } = dom.window;
    const zotero = {
        locale: 'zh-CN',
        Prefs: {
            set: assert.fail,
        },
        logError: assert.fail,
    };
    const controller = createPreferencesController({
        document,
        zotero,
        cache: {
            getStats: async () => ({ entries: 2, sizeBytes: 1536 }),
            clear: async () => {},
        },
    });

    await controller.init();
    assert.equal(document.querySelector('h2').textContent, 'PDF 转换');
    assert.equal(
        document.getElementById('mktero-cache-status').textContent,
        '2 个本地缓存条目，1.5 KB'
    );

    controller.destroy();
});

test('initializes an imported preferences fragment from Zotero capture-phase load', async () => {
    assert.equal(typeof preferencesUI.registerPreferencesPaneLoader, 'function');
    const dom = new JSDOM('<!doctype html><div id="mktero-preferences-pane"></div>');
    const pane = dom.window.document.getElementById('mktero-preferences-pane');
    let initializeCalls = 0;
    let cleanupCalls = 0;
    const dispose = preferencesUI.registerPreferencesPaneLoader({
        document: dom.window.document,
        initialize: async () => {
            initializeCalls++;
            return () => { cleanupCalls++; };
        },
    });

    let initialization;
    const load = new dom.window.Event('load');
    load.waitUntil = promise => { initialization = promise; };
    pane.dispatchEvent(load);
    await initialization;

    pane.dispatchEvent(new dom.window.Event('load'));
    assert.equal(initializeCalls, 1);
    pane.dispatchEvent(new dom.window.Event('unload'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cleanupCalls, 1);

    const reload = new dom.window.Event('load');
    reload.waitUntil = promise => { initialization = promise; };
    pane.dispatchEvent(reload);
    await initialization;
    assert.equal(initializeCalls, 2);
    dispose();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cleanupCalls, 2);

    const replacementPane = dom.window.document.createElement('div');
    replacementPane.id = 'mktero-preferences-pane';
    dom.window.document.body.append(replacementPane);
    replacementPane.dispatchEvent(new dom.window.Event('load'));
    assert.equal(initializeCalls, 2);
});

function createControl(properties = {}) {
    const listeners = new Map();
    return {
        disabled: false,
        ...properties,
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        removeEventListener(type, listener) {
            if (listeners.get(type) === listener) listeners.delete(type);
        },
        attributes: {},
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        dispatch(type) {
            return listeners.get(type)?.();
        },
    };
}
