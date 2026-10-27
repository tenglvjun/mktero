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
    const unavailableTask = new Error('The MinerU task is no longer available');
    unavailableTask.code = 'MINERU_TASK_NOT_FOUND';
    assert.equal(
        localizeConversionError(unavailableTask, translate),
        '之前的 PDF 转换任务已失效，请重试。'
    );
    assert.equal(
        localizeConversionError(new Error('internal implementation detail'), translate),
        'PDF 转换失败。'
    );
});

test('tells the user the PDF is over the page limit instead of to retry', () => {
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });
    const translate = chinese.t.bind(chinese);
    const english = createLocalization({ zoteroLocale: 'en-US' });
    const translateEnglish = english.t.bind(english);

    const local = new Error('The PDF has 317 pages; the conversion service accepts at most 200');
    local.code = 'PDF_PAGE_LIMIT_EXCEEDED';
    local.pages = 317;
    local.limit = 200;
    assert.equal(
        localizeConversionError(local, translate),
        '此 PDF 共 317 页，当前转换服务每个 PDF 最多支持 200 页。请拆分 PDF，或在“设置 -> Mktero”中更换转换服务。'
    );
    assert.match(localizeConversionError(local, translateEnglish), /317 pages.*at most 200 pages/);

    const hosted = new Error('The Mktero conversion failed');
    hosted.code = 'MKTERO_CONVERSION_FAILED';
    hosted.errorCode = 'MINERU_PAGE_LIMIT_EXCEEDED';
    assert.equal(
        localizeConversionError(hosted, translate),
        '此 PDF 超过 200 页，超出当前转换服务每个 PDF 的页数上限。请拆分 PDF，或在“设置 -> Mktero”中更换转换服务。'
    );
    assert.doesNotMatch(localizeConversionError(hosted, translateEnglish), /mineru|try again/i);

    const otherFailure = new Error('The Mktero conversion failed');
    otherFailure.code = 'MKTERO_CONVERSION_FAILED';
    otherFailure.errorCode = 'MINERU_TASK_FAILED';
    assert.equal(
        localizeConversionError(otherFailure, translate),
        'Mktero 服务无法转换此 PDF。请重试。'
    );

    const malformed = new Error('The PDF is too long');
    malformed.code = 'PDF_PAGE_LIMIT_EXCEEDED';
    malformed.pages = '<b>9</b>';
    assert.doesNotMatch(localizeConversionError(malformed, translateEnglish), /<b>/);
    assert.match(localizeConversionError(malformed, translateEnglish), /more than 200 pages/);
});

test('tells the user to retry an upload instead of fixing storage', () => {
    const localization = createLocalization({ zoteroLocale: 'zh-CN' });
    const translate = localization.t.bind(localization);
    const english = createLocalization({ zoteroLocale: 'en-US' });
    const translateEnglish = english.t.bind(english);

    const rejected = new Error('The PDF upload to Mktero failed');
    rejected.code = 'MKTERO_UPLOAD_FAILED';
    rejected.stage = 'upload';
    rejected.status = 403;
    assert.equal(localizeConversionError(rejected, translate), '无法把 PDF 上传到 Mktero。请重试。');
    assert.equal(
        localizeConversionError(rejected, translateEnglish),
        'The PDF could not be uploaded to Mktero. Try again.'
    );
    assert.doesNotMatch(localizeConversionError(rejected, translate), /CORS|存储桶/);
    assert.doesNotMatch(localizeConversionError(rejected, translateEnglish), /CORS|bucket/i);

    const unreachable = new Error('The Mktero conversion request failed');
    unreachable.code = 'MKTERO_NETWORK_ERROR';
    unreachable.stage = 'upload';
    unreachable.cause = new TypeError('NetworkError when attempting to fetch resource');
    assert.equal(
        localizeConversionError(unreachable, translate),
        '上传 PDF 时无法连接到 Mktero。请检查当前网络后重试。'
    );
    assert.doesNotMatch(localizeConversionError(unreachable, translate), /CORS|存储桶/);

    const download = new Error('The Mktero result download failed');
    download.code = 'MKTERO_DOWNLOAD_FAILED';
    download.stage = 'download';
    assert.equal(
        localizeConversionError(download, translate),
        '无法从 Mktero 下载转换后的 Markdown。请重试。'
    );

    const converted = new Error('The Mktero conversion failed');
    converted.code = 'MKTERO_CONVERSION_FAILED';
    assert.equal(
        localizeConversionError(converted, translate),
        'Mktero 服务无法转换此 PDF。请重试。'
    );

    const request = new Error('The Mktero conversion request failed');
    request.code = 'MKTERO_HTTP_ERROR';
    assert.equal(localizeConversionError(request, translate), 'Mktero 转换请求失败。请重试。');

    // An API-stage transport failure keeps the generic message.
    const apiFailure = new Error('The Mktero conversion request failed');
    apiFailure.code = 'MKTERO_NETWORK_ERROR';
    apiFailure.stage = 'api';
    assert.equal(localizeConversionError(apiFailure, translate), '无法连接到转换服务。');
});

test('localizes Mistral conversion errors without exposing provider details', () => {
    const localization = createLocalization({ zoteroLocale: 'en-US' });
    const error = new Error('Mistral OCR returned HTTP 401 with secret details');
    error.code = 'MISTRAL_API_KEY_INVALID';
    assert.equal(
        localizeConversionError(error, localization.t.bind(localization)),
        'The API Token is invalid or expired. Update it in Settings -> Mktero.'
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
            'Saved local Markdown annotations could not be fully read. The original file was kept as a backup, and new annotations can be added.',
            'Some local Markdown annotations could not be synchronized to the PDF.',
            'Unknown non-fatal warning.',
        ],
    }, localization.t.bind(localization));

    assert.equal(result.title, '未命名 PDF');
    assert.deepEqual(result.warnings, [
        '本地 Markdown 缓存不可用。',
        '无法读取 Zotero PDF 注释。',
        '无法读取本地 Markdown 注释。',
        '已保存的本地 Markdown 注释未能完整读取，原文件已另存为备份。可以继续添加新注释。',
        '部分本地 Markdown 注释无法同步到 PDF。',
        '转换过程中发生了一个不影响阅读的问题。',
    ]);
});
