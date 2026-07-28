import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getMkteroLanguagePreference,
    getMinerUCacheEnabled,
    getMinerUApiKey,
    getZoteroLocale,
    MKTERO_LANGUAGE_PREF,
    MINERU_API_KEY_PREF,
    MINERU_CACHE_ENABLED_PREF,
    MINERU_PREFERENCE_PANE_ID,
    openMinerUPreferences,
    observeMkteroLanguagePreference,
    registerMinerUPreferencesPane,
    setMkteroLanguagePreference,
} from '../src/config/mineru-preferences.js';

test('reads and trims the configured MinerU API token', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ key, global });
                return '  token-value  ';
            },
        },
    };

    assert.equal(getMinerUApiKey(zotero), 'token-value');
    assert.deepEqual(calls, [{ key: MINERU_API_KEY_PREF, global: true }]);
});

test('reads whether the local MinerU cache is enabled', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ key, global });
                return false;
            },
        },
    };

    assert.equal(getMinerUCacheEnabled(zotero), false);
    assert.deepEqual(calls, [{ key: MINERU_CACHE_ENABLED_PREF, global: true }]);
});

test('reads and persists the Mktero language preference', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ action: 'get', key, global });
                return 'zh-CN';
            },
            set(key, value, global) {
                calls.push({ action: 'set', key, value, global });
            },
        },
    };

    assert.equal(getMkteroLanguagePreference(zotero), 'zh-CN');
    assert.equal(setMkteroLanguagePreference(zotero, 'en-US'), 'en-US');
    assert.deepEqual(calls, [
        { action: 'get', key: MKTERO_LANGUAGE_PREF, global: true },
        {
            action: 'set',
            key: MKTERO_LANGUAGE_PREF,
            value: 'en-US',
            global: true,
        },
    ]);
});

test('uses system mode for invalid language preferences', () => {
    const values = [];
    const zotero = {
        Prefs: {
            get: () => 'de-DE',
            set(_key, value) {
                values.push(value);
            },
        },
    };

    assert.equal(getMkteroLanguagePreference(zotero), 'system');
    assert.equal(setMkteroLanguagePreference(zotero, 'de-DE'), 'system');
    assert.deepEqual(values, ['system']);
});

test('prefers the Zotero locale and falls back to the platform locale', () => {
    assert.equal(
        getZoteroLocale(
            { locale: 'zh-CN' },
            { locale: { appLocaleAsBCP47: 'en-US' } }
        ),
        'zh-CN'
    );
    assert.equal(
        getZoteroLocale({}, { locale: { appLocaleAsBCP47: 'en-GB' } }),
        'en-GB'
    );
    assert.equal(getZoteroLocale({}, null), '');
});

test('observes language changes and unregisters during shutdown', () => {
    let registration;
    let unregistered;
    const listener = () => {};
    const zotero = {
        Prefs: {
            registerObserver(key, handler, global) {
                registration = { key, handler, global };
                return 37;
            },
            unregisterObserver(id) {
                unregistered = id;
            },
        },
    };

    const dispose = observeMkteroLanguagePreference(zotero, listener);
    assert.deepEqual(registration, {
        key: MKTERO_LANGUAGE_PREF,
        handler: listener,
        global: true,
    });

    dispose();
    assert.equal(unregistered, 37);
});

test('registers and opens the Mktero preference pane', async () => {
    let registered;
    let opened;
    const zotero = {
        PreferencePanes: {
            register: async options => {
                registered = options;
                return options.id;
            },
        },
        Utilities: {
            Internal: {
                openPreferences: paneID => {
                    opened = paneID;
                },
            },
        },
    };

    const paneID = await registerMinerUPreferencesPane({
        zotero,
        pluginID: 'mktero@example.com',
        rootURI: 'resource://mktero/',
    });
    openMinerUPreferences(zotero);

    assert.equal(paneID, MINERU_PREFERENCE_PANE_ID);
    assert.deepEqual(registered, {
        pluginID: 'mktero@example.com',
        id: MINERU_PREFERENCE_PANE_ID,
        label: 'Mktero',
        src: 'resource://mktero/ui/preferences.xhtml',
        scripts: ['resource://mktero/ui/preferences.js'],
        stylesheets: ['resource://mktero/ui/preferences.css'],
        helpURL: 'https://mineru.net/apiManage/docs',
    });
    assert.equal(opened, MINERU_PREFERENCE_PANE_ID);
});
