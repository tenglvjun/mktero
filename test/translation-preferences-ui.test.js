import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPreferencesController } from '../src/ui/preferences.js';

function preferencesDocument() {
    return new JSDOM([
        '<!doctype html><body>',
        '<section id="mktero-preferences-pane">',
        '<input id="mktero-translation-target-language">',
        '<textarea id="mktero-translation-system-prompt"></textarea>',
        '<button id="mktero-translation-prompt-reset"></button>',
        '<select id="mktero-translation-active-service"></select>',
        '<select id="mktero-translation-service-list"></select>',
        '<button id="mktero-translation-service-new"></button>',
        '<button id="mktero-translation-service-delete"></button>',
        '<button id="mktero-translation-service-save"></button>',
        '<span id="mktero-translation-service-status"></span>',
        '<input id="mktero-translation-service-name">',
        '<input id="mktero-translation-api-url">',
        '<input id="mktero-translation-api-key" type="password">',
        '<input id="mktero-translation-model">',
        '<input id="mktero-translation-qps">',
        '<input id="mktero-translation-max-paragraphs">',
        '<input id="mktero-translation-max-characters">',
        '<input id="mktero-translation-temperature">',
        '<input id="mktero-translation-developer-mode" type="checkbox">',
        '<div id="mktero-translation-developer-controls" hidden>',
        '<button id="mktero-translation-copy-failure-log"></button>',
        '<button id="mktero-translation-clear-failure-log"></button>',
        '<span id="mktero-translation-developer-status"></span>',
        '</div>',
        '<span id="mktero-cache-status"></span>',
        '<button id="mktero-clear-cache"></button>',
        '</section>',
        '</body>',
    ].join(''), { pretendToBeVisual: true });
}

test('creates, selects, masks, edits, and deletes translation services', async () => {
    const dom = preferencesDocument();
    const { document } = dom.window;
    const values = new Map();
    let clipboardText = '';
    const zotero = {
        Prefs: {
            get: key => values.get(key),
            set: (key, value, global) => {
                assert.equal(global, true);
                values.set(key, value);
            },
        },
        logError: assert.fail,
    };
    const controller = createPreferencesController({
        document,
        zotero,
        clipboard: {
            async writeText(value) {
                clipboardText = value;
            },
        },
        cache: {
            getStats: async () => ({ entries: 0, sizeBytes: 0 }),
            clear: async () => {},
        },
    });
    await controller.init();

    assert.equal(
        document.getElementById('mktero-translation-api-key').type,
        'password'
    );
    document.getElementById('mktero-translation-service-new').click();
    document.getElementById('mktero-translation-service-name').value
        = 'Academic API';
    document.getElementById('mktero-translation-api-url').value
        = 'https://api.example.test/v1';
    document.getElementById('mktero-translation-api-key').value = 'secret';
    document.getElementById('mktero-translation-model').value = 'model-a';
    document.getElementById('mktero-translation-qps').value = '1';
    document.getElementById('mktero-translation-max-paragraphs').value = '8';
    document.getElementById('mktero-translation-max-characters').value = '6000';
    document.getElementById('mktero-translation-temperature').value = '0.2';
    document.getElementById('mktero-translation-service-save').click();

    const stored = JSON.parse(
        values.get('extensions.mktero.translationServices')
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].apiKey, 'secret');
    assert.equal(
        stored[0].apiURL,
        'https://api.example.test/v1/chat/completions'
    );
    assert.equal(
        values.get('extensions.mktero.activeTranslationServiceId'),
        stored[0].id
    );
    assert.equal(
        document.getElementById('mktero-translation-active-service').value,
        stored[0].id
    );
    assert.equal(
        document.getElementById('mktero-translation-service-status').textContent,
        'Translation service saved'
    );

    document.getElementById('mktero-translation-service-delete').click();
    assert.deepEqual(
        JSON.parse(values.get('extensions.mktero.translationServices')),
        []
    );
    assert.equal(
        values.get('extensions.mktero.activeTranslationServiceId'),
        ''
    );


    values.set('extensions.mktero.translationFailureLog', JSON.stringify([{
        timestamp: '2026-08-07T00:00:00.000Z',
        documentID: 'item-42',
        outcome: 'partial',
        errorCode: 'TRANSLATION_PARTIAL',
        httpStatus: 429,
        serviceID: 'service-1',
        apiURL: 'https://api.example.test/v1/chat/completions',
        model: 'model-a',
        completed: 3,
        failed: 1,
        total: 4,
        failureCodes: { TRANSLATION_HTTP_ERROR: 1 },
    }]));
    const developerMode = document.getElementById(
        'mktero-translation-developer-mode'
    );
    developerMode.checked = true;
    developerMode.dispatchEvent(new dom.window.Event('change'));
    assert.equal(
        values.get('extensions.mktero.translationDeveloperMode'),
        true
    );
    assert.equal(
        document.getElementById('mktero-translation-developer-controls').hidden,
        false
    );
    document.getElementById('mktero-translation-copy-failure-log').click();
    await Promise.resolve();
    await Promise.resolve();
    assert.match(clipboardText, /TRANSLATION_HTTP_ERROR/u);
    document.getElementById('mktero-translation-clear-failure-log').click();
    assert.equal(values.get('extensions.mktero.translationFailureLog'), '[]');
    controller.destroy();
    dom.window.close();
});
