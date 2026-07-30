import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalization } from '../src/i18n/localization.js';
import {
    localizeConversionError,
    localizeConversionResult,
    removeProviderBranding,
} from '../src/ui/provider-neutral-copy.js';

test('removes provider branding from errors shown to users', () => {
    assert.equal(
        removeProviderBranding('MinerU parsing failed'),
        'PDF conversion service parsing failed'
    );
    assert.doesNotMatch(
        removeProviderBranding('Unable to extract MinerU result'),
        /mineru/i
    );
});

test('localizes known conversion errors and hides unknown internal messages', () => {
    const localization = createLocalization({ zoteroLocale: 'zh-CN' });
    const translate = localization.t.bind(localization);

    assert.equal(
        localizeConversionError(
            new Error('The local PDF file is unavailable'),
            translate
        ),
        '本地 PDF 文件不可用。'
    );
    assert.equal(
        localizeConversionError(
            new Error('MinerU parsing failed: page limit exceeded'),
            translate
        ),
        '转换服务无法解析此 PDF：page limit exceeded'
    );
    assert.equal(
        localizeConversionError(new Error('internal implementation detail'), translate),
        'PDF 转换失败。'
    );
});

test('localizes fallback titles and conversion warnings', () => {
    const localization = createLocalization({ zoteroLocale: 'zh-CN' });
    const result = localizeConversionResult({
        title: 'Untitled PDF',
        warnings: [
            'The local Markdown cache is unavailable.',
            'Zotero PDF annotations could not be loaded.',
            'Local Markdown annotations could not be loaded.',
            'Some local Markdown annotations could not be synchronized to the PDF.',
            'Unknown non-fatal warning.',
        ],
    }, localization.t.bind(localization));

    assert.equal(result.title, '未命名 PDF');
    assert.deepEqual(result.warnings, [
        '本地 Markdown 缓存不可用。',
        '无法读取 Zotero PDF 标注。',
        '无法读取本地 Markdown 标注。',
        '部分本地 Markdown 标注无法同步到 PDF。',
        '转换过程中发生了一个不影响阅读的问题。',
    ]);
});
