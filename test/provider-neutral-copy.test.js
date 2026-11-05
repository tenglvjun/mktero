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
        'The API key is invalid or expired. Update it in Settings -> Mktero.'
    );
});

test('localizes every local cache import failure with a specific cause in both languages', async t => {
    const cases = [
        [['LLM_CACHE_DISABLED'], /Enable.*Reuse conversion results/, /启用“复用转换结果”/],
        [['LLM_CACHE_BUSY', 'LLM_CACHE_IMPORT_BUSY'], /already processing this PDF/, /正在处理此 PDF/],
        [['LLM_CACHE_CHANGED'], /PDF or source cache changed/, /PDF 或来源缓存发生了变化/],
        [['LLM_CACHE_WRITING'], /still writing this result/, /仍在写入此结果/],
        [['LLM_CACHE_UNSAFE_PATH'], /unsafe file path or symbolic link/, /不安全的文件路径或符号链接/],
        [['LLM_CACHE_RESOURCE_LIMIT'], /file size, image size, or file count limits/, /文件大小、图片尺寸或文件数量限制/],
        [['LLM_CACHE_UNSUPPORTED_BBOX'], /no supported bounding boxes.*V1/, /缺少受支持的边界框.*V1/],
        [['LLM_CACHE_UNSUPPORTED_FORMAT'], /content list with bounding boxes or a supported layout/, /带有边界框的内容列表或受支持的布局/],
        [['LLM_CACHE_UNSUPPORTED_GEOMETRY'], /PDF coordinates are uncertain/, /PDF 坐标无法确定/],
        [['LLM_CACHE_MISSING_IMAGE'], /image is missing.*could not be restored/, /缺少必需的图片.*无法从 PDF 恢复/],
        [['LLM_CACHE_INVALID_IMAGE'], /image is invalid.*dimensions/, /缓存图片无效.*图片尺寸/],
        [['LLM_CACHE_AMBIGUOUS_FIGURE'], /Multiple cached crops match the same figure/, /多个缓存裁图对应同一图表/],
        [['LLM_CACHE_INVALID_CROP'], /crop coordinates are invalid/, /裁剪坐标无效/],
        [['LLM_CACHE_INVALID_SOURCE'], /source record is invalid or incomplete/, /来源记录无效或不完整/],
        [['LLM_CACHE_UNSUPPORTED_SOURCE'], /source record uses an unsupported format/, /不支持此缓存来源记录的格式/],
        [['LLM_CACHE_ATTACHMENT_MISMATCH'], /different PDF attachment/, /属于其他 PDF 附件/],
        [['LLM_CACHE_PAGE_MISMATCH'], /different page counts/, /页数不一致/],
        [['LLM_CACHE_IMPORT_INDEX_INVALID'], /import index.*damaged or invalid/, /导入索引已损坏或无效/],
        [['LLM_CACHE_IMPORT_INDEX_UNSUPPORTED'], /index.*unsupported version/, /索引由不受支持的.*版本创建/],
        [['LLM_CACHE_IMPORT_INDEX_FULL'], /index has reached its storage limit/, /导入索引已达到存储上限/],
        [['LLM_CACHE_STORAGE_FAILED', 'LLM_CACHE_IMPORT_INDEX_WRITE_FAILED'], /save or read back.*disk space/, /保存或重新读取.*磁盘空间/],
        [['LLM_CACHE_NO_DATA_DIRECTORY'], /Zotero data directory is unavailable/, /Zotero 数据目录不可用/],
        [['LLM_CACHE_NOT_FOUND'], /local parsed result is unavailable/, /本地解析结果不可用/],
        [['LLM_CACHE_UNAVAILABLE'], /local PDF or selected imported result is unavailable/, /本地 PDF 或已选的导入结果不可用/],
        [['LLM_CACHE_IMPORT_UNAVAILABLE'], /previously imported local result is unavailable/, /之前导入的本地结果已不可用/],
        [['LLM_CACHE_INVALID_ATTACHMENT'], /attachment is unavailable or has been deleted/, /附件不可用或已删除/],
        [['LLM_CACHE_INVALID_DOCUMENT'], /no usable mapping to the PDF/, /缺少可用的 PDF 来源映射/],
        [['LLM_CACHE_INVALID_JSON'], /damaged or invalid JSON file/, /损坏或无效的 JSON 文件/],
        [['LLM_CACHE_INVALID_FILE'], /cached file.*valid file data/, /缓存文件.*有效的文件数据/],
        [['LLM_CACHE_INVALID_MANIFEST'], /cache manifest is invalid/, /缓存清单无效/],
        [['LLM_CACHE_INVALID_MARKDOWN'], /Markdown is not valid UTF-8/, /Markdown 不是有效的 UTF-8/],
        [['LLM_CACHE_MISSING_MARKDOWN'], /missing a supported full\.md/, /缺少受支持的 full\.md/],
        [['LLM_CACHE_EMPTY'], /cached Markdown is empty/, /缓存 Markdown 为空/],
        [['LLM_CACHE_AMBIGUOUS_STRUCTURE'], /multiple document structures/, /包含多份文档结构/],
        [['LLM_CACHE_INVALID_STRUCTURE'], /document structure or page information is invalid or incomplete/, /文档结构或页码信息无效或不完整/],
    ];
    for (const [codes, english, chinese] of cases) {
        for (const code of codes) {
            await t.test(code, () => {
                // A typed failure takes precedence over untrusted diagnostic text.
                const error = Object.assign(new Error('no extractable text: /private/source token=secret'), { code });
                for (const [locale, expected] of [['en-US', english], ['zh-CN', chinese]]) {
                    const localization = createLocalization({ zoteroLocale: locale });
                    const message = localizeConversionError(error, localization.t.bind(localization));
                    assert.match(message, expected);
                    assert.doesNotMatch(message, /private\/source|secret|LLM_CACHE_|^importLLM\./);
                    assert.notEqual(message, localization.t('error.conversionFailed'));
                    assert.notEqual(message, localization.t('importLLM.failed'));
                }
            });
        }
    }
});

test('keeps unknown import errors local without exposing internal messages', () => {
    for (const locale of ['en-US', 'zh-CN']) {
        const localization = createLocalization({ zoteroLocale: locale });
        assert.equal(localizeConversionError({
            code: 'LLM_CACHE_FUTURE_ERROR', message: '/private/source token=secret',
        }, localization.t.bind(localization)), localization.t('importLLM.failed'));
    }
});

test('preserves the meaning of all local import warnings in both languages', () => {
    const warnings = [
        'LLM_CACHE_SOURCE_MISSING',
        'LLM_CACHE_SOURCE_LEGACY',
        'LLM_CACHE_SOURCE_INCOMPLETE',
        'LLM_CACHE_CROPS_STALE',
        'LLM_CACHE_IMPORTED_CROPS',
        'LLM_CACHE_LOCAL_CROPS',
    ];
    const expectedByLocale = {
        'en-US': [
            'The imported cache has no source record. Check that its content matches this PDF.',
            'The imported cache uses an older source record. Check that its content matches this PDF.',
            'The imported cache source record has incomplete attachment information. Check that its content matches this PDF.',
            'Cached figure crops were out of date and were skipped. Required images were recovered from other local sources.',
            'Some figures use cropped images from the imported local cache.',
            'Some missing figures were restored by cropping the local PDF.',
        ],
        'zh-CN': [
            '导入的缓存缺少来源记录，请核对其内容是否与此 PDF 一致。',
            '导入的缓存使用旧版来源记录，请核对其内容是否与此 PDF 一致。',
            '导入缓存的来源记录中附件信息不完整，请核对其内容是否与此 PDF 一致。',
            '已跳过过期的缓存裁图，所需图片已从其他本地来源恢复。',
            '部分图表使用了导入缓存中的本地裁图。',
            '部分缺失图表已通过裁剪本地 PDF 恢复。',
        ],
    };
    for (const [locale, expected] of Object.entries(expectedByLocale)) {
        const localization = createLocalization({ zoteroLocale: locale });
        const result = localizeConversionResult({
            title: 'Paper', provider: 'llm-for-zotero', warnings,
        }, localization.t.bind(localization));
        assert.deepEqual(result.warnings, expected);
        assert.equal(new Set(result.warnings).size, 6);
        assert.equal(result.provider, 'llm-for-zotero');
        assert.deepEqual(warnings, [
            'LLM_CACHE_SOURCE_MISSING', 'LLM_CACHE_SOURCE_LEGACY', 'LLM_CACHE_SOURCE_INCOMPLETE',
            'LLM_CACHE_CROPS_STALE', 'LLM_CACHE_IMPORTED_CROPS', 'LLM_CACHE_LOCAL_CROPS',
        ]);
    }
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
