import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createLocalization,
    getLocalizationMessageKeys,
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
        '2 local cache entries, 1.5 KB'
    );

    assert.equal(chinese.language, LANGUAGE_SIMPLIFIED_CHINESE);
    assert.equal(
        chinese.t('preferences.cache.stats.many', {
            count: 2,
            size: '1.5 KB',
        }),
        '2 个本地缓存条目，1.5 KB'
    );
    assert.equal(chinese.t('missing.message'), 'missing.message');
    assert.equal(chinese.t('annotation.noteEditor'), '编辑笔记');
    assert.equal(chinese.t('annotation.saveNote'), '保存');
    assert.equal(
        localization.t('preferences.conversion.provider.mineru'),
        'MinerU'
    );
    assert.equal(
        localization.t('preferences.conversion.provider.mistral'),
        'Mistral OCR 4.1'
    );
    assert.equal(
        localization.t('preferences.conversion.apiKeyLabel'),
        'API key'
    );
    assert.equal(
        chinese.t('preferences.conversion.apiKeyLabel'),
        'API key'
    );
    assert.match(
        localization.t('preferences.conversion.privacyNote'),
        /selected provider receives the complete PDF.*API keys.*unencrypted/i
    );
    assert.match(
        chinese.t('preferences.conversion.privacyNote'),
        /所选服务.*完整 PDF.*API Key.*未加密/
    );
    assert.equal(chinese.t('revision.deleteParagraph'), '删除整段');
    assert.equal(localization.t('revision.start'), 'Manage corrections');
    assert.equal(chinese.t('revision.start'), '管理校对');
    assert.equal(chinese.t('revision.deletedBlock'), '已删除一段内容');
    assert.equal(chinese.t('revision.undoDelete'), '撤销删除');
    assert.equal(
        getLocalizationMessageKeys().some(key => (
            key.startsWith('preferences.citations.')
        )),
        false
    );
    assert.equal(localization.t('graph.openWithMktero'), 'Open with Mktero');
    assert.equal(chinese.t('graph.openWithMktero'), '使用 Mktero 打开');
    assert.equal(localization.t('ai.cancelDocumentTranslationCompact'), 'Cancel');
    assert.equal(chinese.t('ai.cancelDocumentTranslationCompact'), '取消');
    assert.equal(
        localization.t('ai.translationView.translatedLanguage', {
            language: 'Simplified Chinese',
        }),
        'Translation: Simplified Chinese'
    );
    assert.equal(
        chinese.t('ai.translationView.translatedLanguage', {
            language: '简体中文',
        }),
        '简体中文译文'
    );
    assert.match(
        localization.t('preferences.ai.autoTranslateSelectionHelp'),
        /stable Markdown selection.*AI Provider.*cost/i
    );
    assert.match(
        chinese.t('preferences.ai.autoTranslateSelectionHelp'),
        /选区.*稳定.*AI Provider.*费用/
    );
    assert.match(
        localization.t('viewer.exportMarkdown'),
        /parent folder.*paper-named folder.*assets\//i
    );
    assert.match(
        chinese.t('viewer.exportMarkdown'),
        /父文件夹.*论文命名.*assets\//
    );
});

test('localizes Markdown annotation synchronization status', () => {
    const english = createLocalization({ zoteroLocale: 'en-US' });
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });

    assert.equal(english.t('annotation.syncPending'), 'Pending Zotero sync');
    assert.equal(
        english.t('annotation.syncFailed.textAmbiguous'),
        'Multiple PDF matches'
    );
    assert.equal(
        english.t('annotation.syncFailed.pdfIndexUnavailable'),
        'Local PDF index unavailable'
    );
    assert.equal(chinese.t('annotation.syncPending'), '等待同步到 Zotero');
    assert.equal(english.t('annotation.openInPDF'), 'View in PDF');
    assert.equal(chinese.t('annotation.openInPDF'), '在 PDF 中查看');
    assert.equal(
        english.t('viewer.noteAmbiguous'),
        'Multiple matches in Markdown'
    );
    assert.equal(
        chinese.t('viewer.noteAmbiguous'),
        'Markdown 中存在多处匹配'
    );
    assert.equal(
        chinese.t('annotation.syncFailed.textAmbiguous'),
        'PDF 中存在多处匹配'
    );
    assert.equal(
        chinese.t('annotation.syncFailed.pdfIndexUnavailable'),
        '本地 PDF 索引不可用'
    );
});

test('keeps English and Simplified Chinese message keys in sync', () => {
    assert.deepEqual(
        [...getLocalizationMessageKeys(LANGUAGE_SIMPLIFIED_CHINESE)].sort(),
        [...getLocalizationMessageKeys(LANGUAGE_ENGLISH)].sort()
    );
    const english = createLocalization({ zoteroLocale: 'en-US' });
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });
    for (const key of [
        'reference.checking',
        'reference.present',
        'reference.presentNoPDF',
        'reference.presentOtherLibrary',
        'reference.absent',
        'reference.unknown',
        'reference.importing',
        'reference.imported',
        'reference.retryPDF',
        'reference.errorTranslator',
        'reference.errorPDF',
        'reference.errorNetwork',
        'reference.errorCanceled',
    ]) {
        assert.notEqual(english.t(key), key);
        assert.notEqual(chinese.t(key), key);
    }
});
