import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createLocalization,
    LANGUAGE_ENGLISH,
    LANGUAGE_SIMPLIFIED_CHINESE,
    LANGUAGE_FOLLOW_ZOTERO,
    normalizeLanguagePreference,
    resolveLanguage,
} from '../src/i18n/localization.js';

test('maps supported Zotero locales and falls back to English', () => {
    for (const locale of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh_CN']) {
        assert.equal(
            resolveLanguage(LANGUAGE_FOLLOW_ZOTERO, locale),
            LANGUAGE_SIMPLIFIED_CHINESE
        );
    }
    for (const locale of ['en', 'en-US', 'en-GB']) {
        assert.equal(resolveLanguage(LANGUAGE_FOLLOW_ZOTERO, locale), LANGUAGE_ENGLISH);
    }
    assert.equal(resolveLanguage(LANGUAGE_FOLLOW_ZOTERO, 'fr-FR'), LANGUAGE_ENGLISH);
    assert.equal(resolveLanguage(LANGUAGE_FOLLOW_ZOTERO, ''), LANGUAGE_ENGLISH);
});

test('uses an explicit language instead of the Zotero locale', () => {
    assert.equal(resolveLanguage(LANGUAGE_ENGLISH, 'zh-CN'), LANGUAGE_ENGLISH);
    assert.equal(
        resolveLanguage(LANGUAGE_SIMPLIFIED_CHINESE, 'en-US'),
        LANGUAGE_SIMPLIFIED_CHINESE
    );
});

test('treats invalid stored language values as following Zotero', () => {
    assert.equal(normalizeLanguagePreference('invalid'), LANGUAGE_FOLLOW_ZOTERO);
    assert.equal(resolveLanguage('invalid', 'zh-CN'), LANGUAGE_SIMPLIFIED_CHINESE);
});

test('switches languages and formats localized message variables', () => {
    const localization = createLocalization({
        preference: LANGUAGE_FOLLOW_ZOTERO,
        zoteroLocale: 'en-GB',
    });

    assert.equal(localization.language, LANGUAGE_ENGLISH);
    assert.equal(
        localization.t('preferences.cache.stats.many', {
            count: 2,
            size: '1.5 KB',
        }),
        '2 cached documents, 1.5 KB'
    );

    localization.setPreference(LANGUAGE_SIMPLIFIED_CHINESE);

    assert.equal(localization.language, LANGUAGE_SIMPLIFIED_CHINESE);
    assert.equal(
        localization.t('preferences.cache.stats.many', {
            count: 2,
            size: '1.5 KB',
        }),
        '2 个缓存文档，1.5 KB'
    );
    assert.equal(localization.t('missing.message'), 'missing.message');
});
