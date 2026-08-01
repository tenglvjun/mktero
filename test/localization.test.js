import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createLocalization,
    LANGUAGE_ENGLISH,
    LANGUAGE_SIMPLIFIED_CHINESE,
    resolveLanguage,
} from '../src/i18n/localization.js';

test('maps supported Zotero locales and falls back to English', () => {
    for (const locale of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh_CN']) {
        assert.equal(
            resolveLanguage(locale),
            LANGUAGE_SIMPLIFIED_CHINESE
        );
    }
    for (const locale of ['en', 'en-US', 'en-GB']) {
        assert.equal(resolveLanguage(locale), LANGUAGE_ENGLISH);
    }
    assert.equal(resolveLanguage('fr-FR'), LANGUAGE_ENGLISH);
    assert.equal(resolveLanguage(''), LANGUAGE_ENGLISH);
});

test('creates a fixed localization from the Zotero locale', () => {
    const localization = createLocalization({ zoteroLocale: 'en-GB' });
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });

    assert.equal(localization.language, LANGUAGE_ENGLISH);
    assert.equal(
        localization.t('preferences.cache.stats.many', {
            count: 2,
            size: '1.5 KB',
        }),
        '2 cached documents, 1.5 KB'
    );

    assert.equal(chinese.language, LANGUAGE_SIMPLIFIED_CHINESE);
    assert.equal(
        chinese.t('preferences.cache.stats.many', {
            count: 2,
            size: '1.5 KB',
        }),
        '2 个缓存文档，1.5 KB'
    );
    assert.equal(chinese.t('missing.message'), 'missing.message');
    assert.equal(chinese.t('annotation.noteEditor'), '编辑笔记');
    assert.equal(chinese.t('annotation.saveNote'), '保存');
});

test('localizes Markdown annotation synchronization status', () => {
    const english = createLocalization({ zoteroLocale: 'en-US' });
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });

    assert.equal(english.t('annotation.syncPending'), 'Pending Zotero sync');
    assert.equal(
        english.t('annotation.syncFailed.textAmbiguous'),
        'Multiple PDF matches'
    );
    assert.equal(chinese.t('annotation.syncPending'), '等待同步到 Zotero');
    assert.equal(english.t('annotation.openInPDF'), 'View in PDF');
    assert.equal(chinese.t('annotation.openInPDF'), '在 PDF 中查看');
    assert.equal(
        chinese.t('annotation.syncFailed.textAmbiguous'),
        'PDF 中存在多处匹配'
    );
});
