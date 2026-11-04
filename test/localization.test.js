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
    assert.equal(chinese.t('annotation.noteEditor'), '编辑评论');
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
        /selected provider receives the complete PDF.*Keys are stored unencrypted/i
    );
    assert.match(
        chinese.t('preferences.conversion.privacyNote'),
        /所选服务.*完整 PDF.*密钥.*未加密/
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
        /stable selection automatically.*AI provider.*cost/i
    );
    assert.match(
        chinese.t('preferences.ai.autoTranslateSelectionHelp'),
        /选区稳定后自动翻译.*AI 服务.*费用/
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

test('explains that closing a local import tab cancels unfinished work in both languages', () => {
    const english = createLocalization({ zoteroLocale: 'en-US' });
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });

    assert.equal(english.t('importLLM.working'), 'Importing local parsed result…');
    assert.equal(chinese.t('importLLM.working'), '正在导入本地解析结果…');
    assert.equal(
        english.t('importLLM.hint'),
        'All processing takes place on this computer. Closing this tab cancels an unfinished import.'
    );
    assert.equal(
        chinese.t('importLLM.hint'),
        '所有处理都在本机完成。关闭此标签页将取消尚未完成的导入。'
    );
});

test('explains the possible full PDF upload before reparsing an imported result', () => {
    const english = createLocalization({ zoteroLocale: 'en-US' });
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });
    assert.match(english.t('importLLM.reparseConfirm'), /currently selected conversion provider.*may upload the complete PDF.*replace the imported result/);
    assert.match(chinese.t('importLLM.reparseConfirm'), /当前选择的转换服务.*可能会将完整 PDF 上传.*替换.*导入结果/);
    assert.match(english.t('importLLM.reparse'), /may upload PDF/);
    assert.match(chinese.t('importLLM.reparse'), /可能上传 PDF/);
});

test('keeps the cache note concise while retaining privacy and cleanup safeguards', () => {
    const english = createLocalization({ zoteroLocale: 'en-US' });
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });
    const en = english.t('preferences.cache.note');
    const zh = chinese.t('preferences.cache.note');

    assert.ok(en.length <= 190, en);
    assert.ok(zh.length <= 90, zh);
    for (const term of [
        'unencrypted', 'this Zotero profile', 'not synced',
        'permanent PDF deletion', 'orphan', 'trash', 'shared', 'in-use', 'uncertain',
    ]) assert.ok(en.includes(term), `English cache note must retain: ${term}`);
    for (const term of [
        '未加密', '当前 Zotero 配置文件', '不会同步',
        '永久删除', '孤立缓存', '回收站', '共享', '使用中', '待核实',
    ]) assert.ok(zh.includes(term), `Chinese cache note must retain: ${term}`);
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
