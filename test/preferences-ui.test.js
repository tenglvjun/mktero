import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as preferencesUI from '../src/ui/preferences.js';
import {
    withSuccessfulClearNotification,
} from '../src/cache/cache-events.js';

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

test('combines every local cache usage and clears every store', async () => {
    const cleared = [];
    const cache = createCombinedLocalCache([{
        getStats: async () => ({ entries: 2, sizeBytes: 1536 }),
        clear: async () => { cleared.push('markdown'); },
    }, {
        getStats: async () => ({ entries: 3, sizeBytes: 2560 }),
        clear: async () => { cleared.push('pdf-index'); },
    }, {
        getStats: async () => ({ entries: 4, sizeBytes: 4096 }),
        clear: async () => { cleared.push('translations'); },
    }, {
        getStats: async () => ({ entries: 5, sizeBytes: 1024 }),
        clear: async () => { cleared.push('citations'); },
    }]);

    assert.deepEqual(await cache.getStats(), {
        entries: 14,
        sizeBytes: 9216,
    });
    await cache.clear();
    assert.deepEqual(cleared.sort(), [
        'citations',
        'markdown',
        'pdf-index',
        'translations',
    ]);
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

test('notifies after Markdown cache deletion when another cache fails', async () => {
    const notifications = [];
    const cache = createCombinedLocalCache([
        withSuccessfulClearNotification({
            getStats: async () => ({ entries: 1, sizeBytes: 10 }),
            clear: async () => {},
        }, () => notifications.push('markdown-cleared')),
        {
            getStats: async () => ({ entries: 1, sizeBytes: 10 }),
            clear: async () => { throw new Error('PDF index unavailable'); },
        },
    ]);

    await assert.rejects(() => cache.clear(), /PDF index unavailable/);
    assert.deepEqual(notifications, ['markdown-cleared']);
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

test('switches one conversion API key field with the selected provider', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-conversion-provider">
                <option value="mineru">MinerU</option>
                <option value="mistral">Mistral OCR 4.1</option>
            </select>
            <input id="mktero-api-key">
            <a id="mktero-api-key-manage"></a>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const values = new Map([
        ['extensions.mktero.conversionProvider', 'mistral'],
        ['extensions.mktero.mineruApiKey', 'mineru-secret'],
        ['extensions.mktero.mistralApiKey', 'mistral-secret'],
    ]);
    const writes = [];
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => values.get(key),
                set: (key, value, global) => writes.push({ key, value, global }),
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    assert.equal(
        dom.window.document.getElementById('mktero-conversion-provider').value,
        'mistral'
    );
    assert.equal(
        dom.window.document.getElementById('mktero-api-key').value,
        'mistral-secret'
    );
    assert.equal(
        dom.window.document.getElementById('mktero-api-key-manage').href,
        'https://console.mistral.ai/api-keys/'
    );

    const provider = dom.window.document.getElementById(
        'mktero-conversion-provider'
    );
    provider.value = 'mineru';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        dom.window.document.getElementById('mktero-api-key').value,
        'mineru-secret'
    );
    assert.equal(
        dom.window.document.getElementById('mktero-api-key-manage').href,
        'https://mineru.net/apiManage/token'
    );

    const apiKey = dom.window.document.getElementById('mktero-api-key');
    apiKey.value = 'updated-mineru-secret';
    apiKey.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(writes, [{
        key: 'extensions.mktero.mineruApiKey',
        value: 'updated-mineru-secret',
        global: true,
    }]);

    controller.destroy();
    provider.value = 'mistral';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(apiKey.value, 'updated-mineru-secret');
});

test('tests the current AI SDK settings without exposing the key', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <input id="mktero-ai-enabled" type="checkbox" checked>
            <select id="mktero-ai-provider">
                <option value="custom">Custom</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-chat-completions">OpenAI Chat Completions</option>
            </select>
            <input id="mktero-ai-api-base" value="https://api.example.com/v1">
            <input id="mktero-ai-api-key" value="private-token">
            <input id="mktero-ai-model" value="example-chat">
            <select id="mktero-ai-target-language">
                <option value="zh-CN">Simplified Chinese</option>
            </select>
            <input id="mktero-ai-request-timeout" value="600000">
            <input id="mktero-ai-max-output-tokens" value="0">
            <input id="mktero-ai-streaming" type="checkbox" checked>
            <input id="mktero-ai-auto-translate-selection" type="checkbox" checked>
            <button id="mktero-ai-test"></button>
            <span id="mktero-ai-test-status"></span>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    let testedSettings;
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: { get: () => null },
            logError: () => {},
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
        testAIConnection: async settings => {
            testedSettings = settings;
            return { text: 'OK' };
        },
    });

    await controller.init();
    dom.window.document.getElementById('mktero-ai-test').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(testedSettings.apiBase, 'https://api.example.com/v1');
    assert.equal(testedSettings.provider, 'custom');
    assert.equal(testedSettings.protocol, 'openai-chat-completions');
    assert.equal(testedSettings.apiKey, 'private-token');
    assert.equal(testedSettings.model, 'example-chat');
    assert.equal(testedSettings.reasoning, 'none');
    assert.equal(testedSettings.requestTimeoutMs, '600000');
    assert.equal(testedSettings.maxOutputTokens, '0');
    assert.equal(
        dom.window.document.getElementById('mktero-ai-request-timeout').max,
        '3600000'
    );
    assert.equal(
        dom.window.document.getElementById('mktero-ai-max-output-tokens').max,
        '262144'
    );
    assert.equal(testedSettings.streaming, true);
    assert.equal(testedSettings.autoTranslateSelection, true);
    assert.equal(
        dom.window.document.getElementById('mktero-ai-test-status').textContent,
        'Connection successful'
    );
    assert.doesNotMatch(
        dom.window.document.getElementById('mktero-ai-test-status').textContent,
        /private-token/
    );
    controller.destroy();
});

test('shows legacy OpenAI-compatible settings as custom Chat Completions', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="openai">OpenAI</option>
                <option value="custom">Custom</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-responses">OpenAI Responses</option>
                <option value="openai-chat-completions">Chat Completions</option>
                <option value="open-responses">Open Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
                <option value="google-generative-ai">Google</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const values = new Map([
        ['extensions.mktero.aiProvider', 'openai-compatible'],
        ['extensions.mktero.aiProtocol', 'openai-responses'],
    ]);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: { get: key => values.get(key) },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();

    assert.equal(
        dom.window.document.getElementById('mktero-ai-provider').value,
        'custom'
    );
    assert.equal(
        dom.window.document.getElementById('mktero-ai-protocol').value,
        'openai-chat-completions'
    );
    controller.destroy();
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
