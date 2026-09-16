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
        confirmClearCache: async () => true,
    });

    await controller.init();
    assert.equal(status.textContent, '2 local cache entries, 1.5 KB');
    assert.equal(status.attributes['aria-busy'], 'false');

    const clearing = button.listener();
    await new Promise(resolve => setImmediate(resolve));
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
        confirmClearCache: async () => true,
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
            <select id="mktero-reader-line-height">
                <option value="tight">Tight</option>
                <option value="standard">Standard</option>
                <option value="loose">Loose</option>
            </select>
            <select id="mktero-reader-width">
                <option value="narrow">Narrow</option>
                <option value="standard">Standard</option>
                <option value="wide">Wide</option>
            </select>
            <select id="mktero-reader-alignment">
                <option value="justify">Justified</option>
                <option value="start">Left</option>
            </select>
            <input id="mktero-reader-source-peek" type="checkbox">
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
    assert.equal(input.min, '14');
    assert.equal(input.max, '28');
    assert.equal(font.value, 'system-serif');
    font.value = 'cambria';
    font.dispatchEvent(new dom.window.Event('change'));
    const lineHeight = dom.window.document.getElementById(
        'mktero-reader-line-height'
    );
    assert.equal(lineHeight.value, 'standard');
    lineHeight.value = 'loose';
    lineHeight.dispatchEvent(new dom.window.Event('change'));
    const width = dom.window.document.getElementById('mktero-reader-width');
    assert.equal(width.value, 'standard');
    width.value = 'narrow';
    width.dispatchEvent(new dom.window.Event('change'));
    const alignment = dom.window.document.getElementById(
        'mktero-reader-alignment'
    );
    assert.equal(alignment.value, 'start');
    alignment.value = 'justify';
    alignment.dispatchEvent(new dom.window.Event('change'));
    const sourcePeek = dom.window.document.getElementById(
        'mktero-reader-source-peek'
    );
    assert.equal(sourcePeek.checked, true);
    sourcePeek.checked = false;
    sourcePeek.dispatchEvent(new dom.window.Event('change'));
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
        {
            key: 'extensions.mktero.readerLineHeight',
            value: 'loose',
            global: true,
        },
        {
            key: 'extensions.mktero.readerWidth',
            value: 'narrow',
            global: true,
        },
        {
            key: 'extensions.mktero.readerAlignment',
            value: 'justify',
            global: true,
        },
        {
            key: 'extensions.mktero.readerSourcePeek',
            value: false,
            global: true,
        },
    ]);

    controller.destroy();
    input.value = '21';
    input.dispatchEvent(new dom.window.Event('input'));
    font.value = 'georgia';
    font.dispatchEvent(new dom.window.Event('change'));
    sourcePeek.checked = true;
    sourcePeek.dispatchEvent(new dom.window.Event('change'));
    assert.equal(writes.length, 6);
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
            <select id="mktero-ai-provider">
                <option value="custom">Custom</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-chat-completions">OpenAI Chat Completions</option>
            </select>
            <input id="mktero-ai-api-base" value="https://api.example.com/v1">
            <input id="mktero-ai-api-key" value="private-token">
            <input id="mktero-ai-model" value="example-chat">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
                <option value="high" selected>High</option>
            </select>
            <select id="mktero-ai-target-language">
                <option value="zh-CN">Simplified Chinese</option>
            </select>
            <input id="mktero-ai-request-timeout" value="600">
            <input id="mktero-ai-streaming" type="checkbox" checked>
            <input id="mktero-ai-auto-translate-selection" type="checkbox" checked>
            <button id="mktero-ai-test"></button>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    let testedSettings;
    const alerts = [];
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => (
                    key === 'extensions.mktero.aiReasoning' ? 'high' : undefined
                ),
            },
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
        notifyAITestResult: alert => alerts.push(alert),
    });

    await controller.init();
    dom.window.document.getElementById('mktero-ai-test').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(testedSettings.apiBase, 'https://api.example.com/v1');
    assert.equal(testedSettings.provider, 'custom');
    assert.equal(testedSettings.protocol, 'openai-chat-completions');
    assert.equal(testedSettings.apiKey, 'private-token');
    assert.equal(testedSettings.model, 'example-chat');
    assert.equal(testedSettings.reasoning, 'high');
    assert.equal(testedSettings.requestTimeoutMs, 600_000);
    assert.equal(testedSettings.maxOutputTokens, 0);
    assert.equal(
        dom.window.document.getElementById('mktero-ai-request-timeout').max,
        '3600'
    );
    assert.equal(
        dom.window.document.getElementById('mktero-ai-request-timeout').value,
        '600'
    );
    assert.equal(testedSettings.streaming, true);
    assert.equal(testedSettings.autoTranslateSelection, true);
    assert.equal(
        dom.window.document.getElementById('mktero-ai-test')
            .getAttribute('aria-label'),
        'Test connection'
    );
    assert.equal(
        dom.window.document.getElementById('mktero-ai-test')
            .querySelector('svg[data-lucide="zap"]') instanceof
            dom.window.SVGElement,
        true
    );
    assert.deepEqual(alerts, [{
        title: 'Test connection',
        message: 'Connection successful',
    }]);
    assert.doesNotMatch(JSON.stringify(alerts), /private-token/);
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

test('switches preference sections with the tab list', async () => {
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <div id="mktero-pref-tablist" role="tablist">
                <button id="mktero-tab-conversion" class="mktero-pref-tab" type="button"
                        role="tab" aria-selected="true"
                        aria-controls="mktero-conversion-section" tabindex="0">PDF</button>
                <button id="mktero-tab-ai" class="mktero-pref-tab" type="button"
                        role="tab" aria-selected="false"
                        aria-controls="mktero-ai-section" tabindex="-1">AI</button>
            </div>
            <div id="mktero-conversion-section" role="tabpanel"></div>
            <div id="mktero-ai-section" role="tabpanel" hidden></div>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const { document } = dom.window;
    const controller = createPreferencesController({
        document,
        zotero: {
            Prefs: { get: () => undefined },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const conversionTab = document.getElementById('mktero-tab-conversion');
    const aiTab = document.getElementById('mktero-tab-ai');
    const conversion = document.getElementById('mktero-conversion-section');
    const ai = document.getElementById('mktero-ai-section');
    assert.equal(document.getElementById('mktero-pref-tablist')
        .getAttribute('aria-label'), 'Settings sections');
    assert.equal(conversion.hidden, false);
    assert.equal(ai.hidden, true);

    aiTab.click();
    assert.equal(aiTab.getAttribute('aria-selected'), 'true');
    assert.equal(conversionTab.getAttribute('aria-selected'), 'false');
    assert.equal(conversion.hidden, true);
    assert.equal(ai.hidden, false);

    conversionTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
    }));
    assert.equal(ai.hidden, false);
    controller.destroy();
});

test('isolates AI connection settings per provider and restores the previous slot', async () => {
    const values = new Map([
        ['extensions.mktero.aiProvider', 'openai'],
        ['extensions.mktero.aiProtocol', 'openai-responses'],
        ['extensions.mktero.aiApiBase', 'https://api.openai.com/v1'],
        ['extensions.mktero.aiApiKey', 'openai-secret'],
        ['extensions.mktero.aiModel', 'gpt-5-pro'],
        ['extensions.mktero.aiReasoning', 'high'],
        ['extensions.mktero.aiRequestTimeoutMs', 45_000],
        ['extensions.mktero.aiStreaming', false],
    ]);
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <div id="mktero-ai-settings">
                <input id="mktero-ai-streaming" type="checkbox">
                <select id="mktero-ai-provider">
                    <option value="openai">OpenAI</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="custom">Custom</option>
                </select>
                <select id="mktero-ai-protocol">
                    <option value="openai-responses">Responses</option>
                    <option value="openai-chat-completions">Chat</option>
                </select>
                <div id="mktero-ai-api-base-row" hidden>
                    <input id="mktero-ai-api-base" value="https://api.openai.com/v1">
                </div>
                <input id="mktero-ai-model" value="gpt-5-pro">
                <input id="mktero-ai-api-key" value="openai-secret">
                <div id="mktero-ai-protocol-row" hidden></div>
                <select id="mktero-ai-reasoning">
                    <option value="none">Off</option>
                    <option value="high">High</option>
                </select>
                <input id="mktero-ai-request-timeout" value="45">
            </div>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => values.get(key),
                set: (key, value) => values.set(key, value),
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const document = dom.window.document;
    const provider = document.getElementById('mktero-ai-provider');
    const apiBase = document.getElementById('mktero-ai-api-base');
    const apiBaseRow = document.getElementById('mktero-ai-api-base-row');
    const protocolRow = document.getElementById('mktero-ai-protocol-row');
    const model = document.getElementById('mktero-ai-model');
    const apiKey = document.getElementById('mktero-ai-api-key');
    const streaming = document.getElementById('mktero-ai-streaming');
    const timeout = document.getElementById('mktero-ai-request-timeout');
    assert.equal(apiBaseRow.hidden, true);
    assert.equal(protocolRow.hidden, true);

    provider.value = 'deepseek';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(model.value, '');
    assert.equal(apiKey.value, '');
    assert.equal(streaming.checked, true);
    assert.equal(timeout.value, '600');
    assert.equal(apiBase.value, 'https://api.deepseek.com');
    assert.equal(apiBaseRow.hidden, true);

    model.value = 'deepseek-v4-pro';
    apiKey.value = 'deepseek-secret';
    streaming.checked = false;
    provider.value = 'openai';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(model.value, 'gpt-5-pro');
    assert.equal(apiKey.value, 'openai-secret');
    assert.equal(streaming.checked, false);
    assert.equal(timeout.value, '45');
    assert.equal(apiBase.value, 'https://api.openai.com/v1');

    provider.value = 'deepseek';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(model.value, 'deepseek-v4-pro');
    assert.equal(apiKey.value, 'deepseek-secret');
    assert.equal(streaming.checked, false);

    provider.value = 'custom';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(apiBaseRow.hidden, false);
    assert.equal(protocolRow.hidden, false);
    assert.equal(apiBase.value, '');
    assert.equal(model.value, '');
    controller.destroy();
});

test('lets Moonshot use the China API endpoint', async () => {
    const values = new Map([
        ['extensions.mktero.aiProvider', 'moonshotai'],
        ['extensions.mktero.aiProtocol', 'openai-chat-completions'],
        ['extensions.mktero.aiApiBase', 'https://api.moonshot.ai/v1'],
        ['extensions.mktero.aiApiKey', 'moonshot-secret'],
        ['extensions.mktero.aiModel', 'kimi-k3'],
    ]);
    const writes = [];
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="openai">OpenAI</option>
                <option value="moonshotai">Moonshot</option>
                <option value="minimax">MiniMax</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-chat-completions">Chat</option>
            </select>
            <div id="mktero-ai-moonshot-endpoint-row" hidden>
                <select id="mktero-ai-moonshot-endpoint">
                    <option value="international">International</option>
                    <option value="china">China</option>
                </select>
            </div>
            <div id="mktero-ai-api-base-row" hidden>
                <input id="mktero-ai-api-base" value="https://api.moonshot.ai/v1">
            </div>
            <div id="mktero-ai-protocol-row" hidden></div>
            <input id="mktero-ai-model" value="kimi-k3">
            <input id="mktero-ai-api-key" value="moonshot-secret">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => values.get(key),
                set: (key, value, global) => {
                    writes.push({ key, value, global });
                    values.set(key, value);
                },
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const document = dom.window.document;
    const row = document.getElementById('mktero-ai-moonshot-endpoint-row');
    const endpoint = document.getElementById('mktero-ai-moonshot-endpoint');
    const provider = document.getElementById('mktero-ai-provider');
    assert.equal(row.hidden, false);
    assert.equal(endpoint.value, 'international');

    endpoint.value = 'china';
    endpoint.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.moonshot.cn/v1'
    );
    assert.equal(
        document.getElementById('mktero-ai-api-base').value,
        'https://api.moonshot.cn/v1'
    );

    provider.value = 'minimax';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(row.hidden, true);
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.minimax.io/anthropic/v1'
    );

    endpoint.value = 'international';
    endpoint.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.minimax.io/anthropic/v1'
    );

    provider.value = 'moonshotai';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(row.hidden, false);
    assert.equal(endpoint.value, 'china');
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.moonshot.cn/v1'
    );

    controller.destroy();
});

test('lets MiniMax use the China API endpoint', async () => {
    const values = new Map([
        ['extensions.mktero.aiProvider', 'minimax'],
        ['extensions.mktero.aiProtocol', 'anthropic-messages'],
        ['extensions.mktero.aiApiBase', 'https://api.minimax.io/anthropic/v1'],
        ['extensions.mktero.aiApiKey', 'minimax-secret'],
        ['extensions.mktero.aiModel', 'MiniMax-M3'],
    ]);
    const writes = [];
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="openai">OpenAI</option>
                <option value="moonshotai">Moonshot</option>
                <option value="minimax">MiniMax</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-chat-completions">Chat</option>
                <option value="anthropic-messages">Anthropic</option>
            </select>
            <div id="mktero-ai-moonshot-endpoint-row" hidden>
                <select id="mktero-ai-moonshot-endpoint">
                    <option value="international">International</option>
                    <option value="china">China</option>
                </select>
            </div>
            <div id="mktero-ai-minimax-endpoint-row" hidden>
                <select id="mktero-ai-minimax-endpoint">
                    <option value="international">International</option>
                    <option value="china">China</option>
                </select>
            </div>
            <div id="mktero-ai-api-base-row" hidden>
                <input id="mktero-ai-api-base" value="https://api.minimax.io/anthropic/v1">
            </div>
            <div id="mktero-ai-protocol-row" hidden></div>
            <input id="mktero-ai-model" value="MiniMax-M3">
            <input id="mktero-ai-api-key" value="minimax-secret">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => values.get(key),
                set: (key, value, global) => {
                    writes.push({ key, value, global });
                    values.set(key, value);
                },
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const document = dom.window.document;
    const moonshotRow = document.getElementById('mktero-ai-moonshot-endpoint-row');
    const row = document.getElementById('mktero-ai-minimax-endpoint-row');
    const endpoint = document.getElementById('mktero-ai-minimax-endpoint');
    const provider = document.getElementById('mktero-ai-provider');
    assert.equal(moonshotRow.hidden, true);
    assert.equal(row.hidden, false);
    assert.equal(endpoint.value, 'international');

    endpoint.value = 'china';
    endpoint.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.minimax.cn/anthropic/v1'
    );
    assert.equal(
        document.getElementById('mktero-ai-api-base').value,
        'https://api.minimax.cn/anthropic/v1'
    );

    provider.value = 'openai';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(row.hidden, true);
    assert.equal(moonshotRow.hidden, true);
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.openai.com/v1'
    );

    endpoint.value = 'international';
    endpoint.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.openai.com/v1'
    );

    provider.value = 'minimax';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(row.hidden, false);
    assert.equal(moonshotRow.hidden, true);
    assert.equal(endpoint.value, 'china');
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.minimax.cn/anthropic/v1'
    );

    controller.destroy();
});

test('lets Alibaba use the China API endpoint', async () => {
    const values = new Map([
        ['extensions.mktero.aiProvider', 'alibaba'],
        ['extensions.mktero.aiProtocol', 'openai-chat-completions'],
        ['extensions.mktero.aiApiBase',
            'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
        ['extensions.mktero.aiApiKey', 'alibaba-secret'],
        ['extensions.mktero.aiModel', 'qwen-plus'],
    ]);
    const writes = [];
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="openai">OpenAI</option>
                <option value="alibaba">Alibaba</option>
                <option value="minimax">MiniMax</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-chat-completions">Chat</option>
            </select>
            <div id="mktero-ai-alibaba-endpoint-row" hidden>
                <select id="mktero-ai-alibaba-endpoint">
                    <option value="international">International</option>
                    <option value="china">China</option>
                </select>
            </div>
            <div id="mktero-ai-minimax-endpoint-row" hidden>
                <select id="mktero-ai-minimax-endpoint">
                    <option value="international">International</option>
                    <option value="china">China</option>
                </select>
            </div>
            <div id="mktero-ai-api-base-row" hidden>
                <input id="mktero-ai-api-base" value="https://dashscope-intl.aliyuncs.com/compatible-mode/v1">
            </div>
            <div id="mktero-ai-protocol-row" hidden></div>
            <input id="mktero-ai-model" value="qwen-plus">
            <input id="mktero-ai-api-key" value="alibaba-secret">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => values.get(key),
                set: (key, value, global) => {
                    writes.push({ key, value, global });
                    values.set(key, value);
                },
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const document = dom.window.document;
    const miniMaxRow = document.getElementById('mktero-ai-minimax-endpoint-row');
    const row = document.getElementById('mktero-ai-alibaba-endpoint-row');
    const endpoint = document.getElementById('mktero-ai-alibaba-endpoint');
    const provider = document.getElementById('mktero-ai-provider');
    assert.equal(miniMaxRow.hidden, true);
    assert.equal(row.hidden, false);
    assert.equal(endpoint.value, 'international');

    endpoint.value = 'china';
    endpoint.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://dashscope.aliyuncs.com/compatible-mode/v1'
    );
    assert.equal(
        document.getElementById('mktero-ai-api-base').value,
        'https://dashscope.aliyuncs.com/compatible-mode/v1'
    );

    provider.value = 'openai';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(row.hidden, true);
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.openai.com/v1'
    );

    endpoint.value = 'international';
    endpoint.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.openai.com/v1'
    );

    provider.value = 'alibaba';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(row.hidden, false);
    assert.equal(miniMaxRow.hidden, true);
    assert.equal(endpoint.value, 'china');
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://dashscope.aliyuncs.com/compatible-mode/v1'
    );

    controller.destroy();
});

test('does not copy a regional endpoint into another provider profile', async () => {
    const values = new Map([
        ['extensions.mktero.aiProvider', 'deepseek'],
        ['extensions.mktero.aiProtocol', 'openai-chat-completions'],
        ['extensions.mktero.aiApiBase', 'https://api.deepseek.com'],
        ['extensions.mktero.aiApiKey', 'deepseek-secret'],
        ['extensions.mktero.aiModel', 'deepseek-v4-pro'],
    ]);
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="deepseek">DeepSeek</option>
                <option value="moonshotai">Moonshot</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-chat-completions">Chat</option>
            </select>
            <div id="mktero-ai-moonshot-endpoint-row" hidden>
                <select id="mktero-ai-moonshot-endpoint">
                    <option value="international">International</option>
                    <option value="china">China</option>
                </select>
            </div>
            <div id="mktero-ai-api-base-row" hidden>
                <input id="mktero-ai-api-base" value="https://api.deepseek.com">
            </div>
            <div id="mktero-ai-protocol-row" hidden></div>
            <input id="mktero-ai-model" value="deepseek-v4-pro">
            <input id="mktero-ai-api-key" value="deepseek-secret">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => values.get(key),
                set: (key, value) => values.set(key, value),
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const document = dom.window.document;
    const provider = document.getElementById('mktero-ai-provider');
    const endpoint = document.getElementById('mktero-ai-moonshot-endpoint');
    endpoint.value = 'china';
    provider.value = 'moonshotai';
    provider.dispatchEvent(new dom.window.Event('change'));
    const profiles = JSON.parse(
        values.get('extensions.mktero.aiProviderProfiles') || '{}'
    );
    assert.equal(profiles.deepseek.apiBase, 'https://api.deepseek.com');
    assert.equal(profiles.deepseek.apiKey, 'deepseek-secret');
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.moonshot.ai/v1'
    );

    provider.value = 'deepseek';
    provider.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        values.get('extensions.mktero.aiApiBase'),
        'https://api.deepseek.com'
    );
    assert.equal(
        document.getElementById('mktero-ai-api-key').value,
        'deepseek-secret'
    );

    controller.destroy();
});

test('does not clear the cache when confirmation is cancelled', async () => {
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
    let clearCalls = 0;
    const controller = createPreferencesController({
        document,
        zotero: { logError: assert.fail },
        cache: {
            getStats: async () => ({ entries: 2, sizeBytes: 1536 }),
            clear: async () => { clearCalls++; },
        },
        confirmClearCache: async () => false,
    });

    await controller.init();
    await button.listener();
    assert.equal(clearCalls, 0);
    assert.equal(status.textContent, '2 local cache entries, 1.5 KB');
});

test('adapts the reasoning menu to the selected model', async () => {
    const writes = [];
    const values = new Map([
        ['extensions.mktero.aiProvider', 'openai'],
        ['extensions.mktero.aiModel', 'gpt-5-pro'],
        ['extensions.mktero.aiReasoning', 'none'],
    ]);
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="openai">OpenAI</option>
                <option value="custom">Custom</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-responses">OpenAI Responses</option>
            </select>
            <input id="mktero-ai-api-base" value="https://api.openai.com/v1">
            <input id="mktero-ai-model" value="gpt-5-pro">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => values.get(key),
                set: (key, value, global) => {
                    writes.push({ key, value, global });
                    values.set(key, value);
                },
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
        reasoningCatalog: {
            labProviders: ['openai'],
            hosts: { 'api.openai.com': 'openai' },
            providers: {
                openai: {
                    'gpt-5-pro': {
                        reasoning: true,
                        options: [{ type: 'effort', values: ['high'] }],
                    },
                    'gpt-4o': { reasoning: false },
                },
            },
        },
    });

    await controller.init();
    const select = dom.window.document.getElementById('mktero-ai-reasoning');
    const model = dom.window.document.getElementById('mktero-ai-model');
    assert.deepEqual([...select.options].map(option => option.value), ['high']);
    assert.equal(select.value, 'high');
    assert.equal(
        writes.some(write => (
            write.key === 'extensions.mktero.aiReasoning'
            && write.value === 'high'
        )),
        true
    );

    model.value = 'gpt-4o';
    model.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual([...select.options].map(option => option.value), ['none']);
    assert.equal(select.value, 'none');

    model.value = 'unknown-chat';
    model.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(
        [...select.options].map(option => option.value),
        ['none', 'low', 'medium', 'high', 'xhigh']
    );
    controller.destroy();
});

test('keeps a stored reasoning level when the unbound menu still shows off', async () => {
    const writes = [];
    const values = new Map([
        ['extensions.mktero.aiProvider', 'custom'],
        ['extensions.mktero.aiProtocol', 'openai-responses'],
        ['extensions.mktero.aiApiBase', 'https://gateway.example.com/v1'],
        ['extensions.mktero.aiModel', 'grok-4.6'],
        ['extensions.mktero.aiReasoning', 'low'],
    ]);
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="custom">Custom</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-responses">OpenAI Responses</option>
            </select>
            <input id="mktero-ai-api-base" value="https://gateway.example.com/v1">
            <input id="mktero-ai-model" value="grok-4.6">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Prefs: {
                get: key => values.get(key),
                set: (key, value, global) => {
                    writes.push({ key, value, global });
                    values.set(key, value);
                },
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
        reasoningCatalog: {
            labProviders: ['openai'],
            hosts: {},
            providers: {
                xai: {
                    'grok-4.6': {
                        reasoning: true,
                        options: [{
                            type: 'effort',
                            values: ['low', 'medium', 'high', 'xhigh'],
                        }],
                    },
                },
            },
        },
    });

    await controller.init();
    const select = dom.window.document.getElementById('mktero-ai-reasoning');
    assert.deepEqual(
        [...select.options].map(option => option.value),
        ['low', 'medium', 'high', 'xhigh']
    );
    assert.equal(select.value, 'low');
    assert.equal(values.get('extensions.mktero.aiReasoning'), 'low');
    assert.equal(
        writes.some(write => (
            write.key === 'extensions.mktero.aiReasoning'
            && write.value === 'medium'
        )),
        false
    );
    controller.destroy();
});

test('filters reasoning options from saved settings before the model field is bound', async () => {
    const values = new Map([
        ['extensions.mktero.aiProvider', 'deepseek'],
        ['extensions.mktero.aiModel', 'deepseek-v4-pro'],
        ['extensions.mktero.aiReasoning', 'none'],
    ]);
    const catalog = {
        labProviders: ['deepseek'],
        hosts: {},
        providers: {
            deepseek: {
                'deepseek-v4-pro': {
                    reasoning: true,
                    options: [
                        { type: 'toggle' },
                        { type: 'effort', values: ['high', 'max'] },
                    ],
                },
            },
        },
    };
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="deepseek">DeepSeek</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-chat-completions">Chat</option>
            </select>
            <input id="mktero-ai-model">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Mktero: {
                getAIReasoningCatalog: () => catalog,
                subscribeAIReasoningCatalog: listener => {
                    listener(catalog);
                    return () => {};
                },
            },
            Prefs: {
                get: key => values.get(key),
                set: (key, value) => values.set(key, value),
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const select = dom.window.document.getElementById('mktero-ai-reasoning');
    assert.deepEqual(
        [...select.options].map(option => option.value),
        ['none', 'high', 'max']
    );
    controller.destroy();
});

test('refreshes reasoning options when the in-memory catalog arrives', async () => {
    const listeners = new Set();
    let catalog = null;
    const values = new Map([
        ['extensions.mktero.aiProvider', 'openai'],
        ['extensions.mktero.aiModel', 'gpt-5-pro'],
        ['extensions.mktero.aiReasoning', 'none'],
    ]);
    const dom = new JSDOM(`<!doctype html><body>
        <section id="mktero-preferences-pane">
            <select id="mktero-ai-provider">
                <option value="openai">OpenAI</option>
            </select>
            <select id="mktero-ai-protocol">
                <option value="openai-responses">OpenAI Responses</option>
            </select>
            <input id="mktero-ai-model" value="gpt-5-pro">
            <select id="mktero-ai-reasoning">
                <option value="none">Off</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
            </select>
            <span id="mktero-cache-status"></span>
            <button id="mktero-clear-cache"></button>
        </section>
    </body>`);
    const controller = createPreferencesController({
        document: dom.window.document,
        zotero: {
            Mktero: {
                getAIReasoningCatalog: () => catalog,
                subscribeAIReasoningCatalog: listener => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
            Prefs: {
                get: key => values.get(key),
                set: (key, value) => values.set(key, value),
            },
            logError: assert.fail,
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });

    await controller.init();
    const select = dom.window.document.getElementById('mktero-ai-reasoning');
    assert.deepEqual(
        [...select.options].map(option => option.value),
        ['none', 'low', 'medium', 'high', 'xhigh']
    );

    catalog = {
        labProviders: ['openai'],
        hosts: {},
        providers: {
            openai: {
                'gpt-5-pro': {
                    reasoning: true,
                    options: [{ type: 'effort', values: ['high'] }],
                },
            },
        },
    };
    for (const listener of listeners) listener(catalog);
    assert.deepEqual([...select.options].map(option => option.value), ['high']);
    assert.equal(select.value, 'high');
    controller.destroy();
    assert.equal(listeners.size, 0);
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
