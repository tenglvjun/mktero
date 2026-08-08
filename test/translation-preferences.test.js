import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendTranslationFailureLog,
    clearTranslationFailureLogs,
    formatTranslationFailureLogs,
    ACTIVE_TRANSLATION_SERVICE_PREF,
    createTranslationServiceID,
    DEFAULT_TRANSLATION_SERVICE_LIMITS,
    getTranslationDeveloperMode,
    getTranslationFailureLogs,
    getTranslationConfiguration,
    getTranslationServices,
    normalizeTranslationAPIURL,
    normalizeTranslationService,
    setActiveTranslationServiceID,
    setTranslationDeveloperMode,
    setTranslationServices,
    setTranslationSystemPrompt,
    setTranslationTargetLanguage,
    TRANSLATION_SERVICES_PREF,
    TranslationConfigurationError,
} from '../src/config/translation-preferences.js';

function createZoteroPreferences(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        Prefs: {
            get: key => values.get(key),
            set: (key, value, global) => {
                assert.equal(global, true);
                values.set(key, value);
            },
        },
    };
}

function service(overrides = {}) {
    return {
        id: 'service-1',
        name: 'Academic service',
        apiURL: 'https://api.example.test/v1',
        apiKey: 'secret',
        model: 'test-model',
        ...DEFAULT_TRANSLATION_SERVICE_LIMITS,
        ...overrides,
    };
}

test('normalizes OpenAI-compatible base and endpoint URLs', () => {
    assert.equal(
        normalizeTranslationAPIURL('https://api.example.test/v1'),
        'https://api.example.test/v1/chat/completions'
    );
    assert.equal(
        normalizeTranslationAPIURL(
            'https://api.example.test/chat/completions?ignored=yes'
        ),
        'https://api.example.test/chat/completions'
    );
    assert.throws(
        () => normalizeTranslationAPIURL(
            'https://user:pass@api.example.test/v1#fragment'
        ),
        TranslationConfigurationError
    );
});

test('rejects API keys over non-local insecure HTTP transports', () => {
    assert.throws(
        () => normalizeTranslationService(service({
            apiURL: 'http://api.example.test/v1',
        }), { requireID: true }),
        error => error.code === 'TRANSLATION_INSECURE_TRANSPORT'
    );
    assert.doesNotThrow(() => normalizeTranslationService(service({
        apiURL: 'http://127.0.0.1:8080/v1',
    }), { requireID: true }));
    assert.doesNotThrow(() => normalizeTranslationService(service({
        apiURL: 'http://api.example.test/v1',
        apiKey: '',
    }), { requireID: true }));
});

test('persists service CRUD data and resolves the active configuration', () => {
    const zotero = createZoteroPreferences();
    const stored = setTranslationServices(zotero, [service()]);
    setActiveTranslationServiceID(zotero, stored[0].id);
    setTranslationTargetLanguage(zotero, 'zh-CN');
    setTranslationSystemPrompt(zotero, 'Translate {{targetLanguage}}.');

    assert.equal(
        JSON.parse(zotero.values.get(TRANSLATION_SERVICES_PREF))[0].apiKey,
        'secret'
    );
    assert.equal(
        zotero.values.get(ACTIVE_TRANSLATION_SERVICE_PREF),
        'service-1'
    );
    assert.deepEqual(getTranslationConfiguration(zotero), {
        service: {
            ...service(),
            apiURL: 'https://api.example.test/v1/chat/completions',
        },
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate {{targetLanguage}}.',
    });
});

test('uses defaults for omitted per-service request limits', () => {
    const normalized = normalizeTranslationService({
        id: 'service-2',
        name: 'Local model',
        apiURL: 'http://localhost:1234/v1',
        apiKey: '',
        model: 'local-model',
    }, { requireID: true });

    assert.deepEqual({
        maxRequestsPerSecond: normalized.maxRequestsPerSecond,
        maxParagraphsPerRequest: normalized.maxParagraphsPerRequest,
        maxCharactersPerRequest: normalized.maxCharactersPerRequest,
        temperature: normalized.temperature,
    }, DEFAULT_TRANSLATION_SERVICE_LIMITS);
});

test('treats malformed preference JSON as an empty service list', () => {
    const zotero = createZoteroPreferences({
        [TRANSLATION_SERVICES_PREF]: '{not-json',
    });

    assert.deepEqual(getTranslationServices(zotero), []);
    assert.throws(
        () => getTranslationConfiguration(zotero),
        error => error.code === 'TRANSLATION_SERVICE_REQUIRED'
    );
});

test('validates service limits and service identifiers', () => {
    assert.throws(
        () => normalizeTranslationService(service({
            maxRequestsPerSecond: 0,
        }), { requireID: true }),
        /out of range/i
    );
    assert.throws(
        () => normalizeTranslationService(service({
            maxParagraphsPerRequest: 2.5,
        }), { requireID: true }),
        /integer/i
    );
    assert.throws(
        () => normalizeTranslationService(service({
            maxCharactersPerRequest: 100,
        }), { requireID: true }),
        /out of range/i
    );
    assert.throws(
        () => normalizeTranslationService(service({
            temperature: 3,
        }), { requireID: true }),
        /out of range/i
    );
    assert.throws(
        () => setTranslationServices(createZoteroPreferences(), [
            service(),
            service({ name: 'Duplicate' }),
        ]),
        /unique/i
    );
});

test('creates stable preference-safe service IDs', () => {
    const id = createTranslationServiceID({
        crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
        now: () => 1_700_000_000_000,
    });

    assert.match(id, /^service-[a-z0-9]+-[a-z0-9]+$/u);
    assert.ok(id.length <= 64);
});

test('records and copies sanitized failure metadata only in developer mode', () => {
    const zotero = createZoteroPreferences();
    const failure = {
        documentID: 'item-42',
        outcome: 'partial',
        errorCode: 'TRANSLATION_PARTIAL',
        httpStatus: 429,
        service: {
            ...service(),
            apiURL: 'https://api.example.test/v1/chat/completions?token=secret',
        },
        completed: 3,
        failed: 2,
        total: 5,
        failureCodes: { TRANSLATION_HTTP_ERROR: 2 },
        sourceText: 'Private paper text',
        prompt: 'Private prompt',
        rawResponse: 'Private response',
    };

    assert.equal(getTranslationDeveloperMode(zotero), false);
    assert.deepEqual(appendTranslationFailureLog(zotero, failure), []);
    setTranslationDeveloperMode(zotero, true);
    appendTranslationFailureLog(zotero, failure, {
        now: () => Date.UTC(2026, 7, 7, 0, 0, 0),
    });

    const entries = getTranslationFailureLogs(zotero);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].failureCodes, {
        TRANSLATION_HTTP_ERROR: 2,
    });
    assert.equal(entries[0].apiURL.includes('?'), false);
    const copied = formatTranslationFailureLogs(zotero);
    assert.match(copied, /TRANSLATION_HTTP_ERROR/u);
    assert.doesNotMatch(
        copied,
        /secret|Private paper text|Private prompt|Private response/u
    );

    clearTranslationFailureLogs(zotero);
    assert.deepEqual(getTranslationFailureLogs(zotero), []);
});
