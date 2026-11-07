import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createZoteroEpubExporter,
} from '../src/platform/zotero-epub-exporter.js';

const EPUB_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

test('configures a localized EPUB save picker and cancels without building or writing', async () => {
    const writes = [];
    const picker = createFilePicker({ result: 1, file: '' });
    const ownerWindow = { name: 'zotero-window' };
    const messages = {
        'viewer.exportEpubDialogTitle': '导出 EPUB',
        'viewer.exportEpubDefaultFileName': '文档',
        'viewer.exportEpubFilter': 'EPUB 电子书',
    };
    const exporter = createExporter({
        picker,
        writes,
        translate: key => messages[key] || key,
        buildEpub: async () => {
            assert.fail('cancelled exports must not build an EPUB');
        },
        createID: () => {
            assert.fail('cancelled exports must not allocate a write ID');
        },
    });

    const result = await exporter.export({
        ownerWindow,
        title: 'Paper',
        markdown: '# Paper',
        assets: [],
    });

    assert.deepEqual(result, { status: 'cancelled' });
    assert.deepEqual(writes, []);
    assert.deepEqual(picker.initialized, {
        ownerWindow,
        title: '导出 EPUB',
        mode: picker.modeSave,
    });
    assert.equal(picker.shown.defaultString, 'Paper.epub');
    assert.deepEqual(picker.shown.filters, [{
        title: 'EPUB 电子书',
        pattern: '*.epub',
    }]);
});

test('uses the localized default EPUB file name and defaults the builder language to English', async () => {
    const picker = createFilePicker();
    const requests = [];
    const exporter = createExporter({
        picker,
        translate: key => key === 'viewer.exportEpubDefaultFileName'
            ? '文档'
            : key,
        buildEpub: async options => {
            requests.push(options);
            return EPUB_BYTES;
        },
    });

    await exporter.export({
        ownerWindow: {},
        title: '   ',
        markdown: '# Paper',
        assets: [],
    });

    assert.equal(picker.shown.defaultString, '文档.epub');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].language, 'en');
});

test('adds an EPUB extension only when the chosen path does not already end in one', async t => {
    const cases = [
        { file: '/exports/Paper', expected: '/exports/Paper.epub' },
        { file: '/exports/Paper.epub', expected: '/exports/Paper.epub' },
        {
            file: '/exports/Paper.EPUB',
            expected: '/exports/Paper.EPUB',
            result: 2,
        },
        { file: '/exports/Paper.pdf', expected: '/exports/Paper.pdf.epub' },
        {
            file: '/exports/Paper.epub.backup',
            expected: '/exports/Paper.epub.backup.epub',
        },
    ];
    for (const { file, expected, result = 0 } of cases) {
        await t.test(file, async () => {
            const writes = [];
            const exporter = createExporter({
                picker: createFilePicker({ file, result }),
                writes,
            });

            const exported = await exporter.export({
                title: 'Paper',
                markdown: '# Paper',
                assets: [],
            });

            assert.equal(exported.status, 'exported');
            assert.equal(exported.path, expected);
            assert.equal(writes.length, 1);
            assert.equal(writes[0].path, expected);
        });
    }
});

test('passes content, language, assets and renderers to the builder and writes its bytes through a temporary file', async () => {
    const writes = [];
    const requests = [];
    const assets = [{
        path: 'result/images/figure.webp',
        mimeType: 'image/webp',
        data: new Uint8Array([1, 2, 3]),
    }];
    const renderWideTable = async () => {
        assert.fail('the adapter must pass the table renderer to the builder');
    };
    const renderImageToPNG = async () => {
        assert.fail('the adapter must pass the image renderer to the builder');
    };
    const exporter = createExporter({
        writes,
        renderWideTable,
        renderImageToPNG,
        createID: () => 'dc3b6389-a940-4a5b-a85b-3369e0ab5e76',
        buildEpub: async options => {
            requests.push(options);
            return EPUB_BYTES;
        },
    });

    const result = await exporter.export({
        ownerWindow: { name: 'zotero-window' },
        title: '论文',
        markdown: '# 论文\n\n![图](images/figure.webp)',
        language: 'zh-CN',
        assetBasePath: 'result',
        assets,
    });

    assert.deepEqual(requests, [{
        title: '论文',
        language: 'zh-CN',
        markdown: '# 论文\n\n![图](images/figure.webp)',
        assets,
        assetBasePath: 'result',
        renderWideTable,
        renderImageToPNG,
    }]);
    assert.equal(requests[0].assets, assets);
    assert.deepEqual(writes, [{
        path: '/exports/Paper.epub',
        data: EPUB_BYTES,
        options: { tmpPath: '/exports/Paper.epub.mktero-dc3b6389.tmp' },
    }]);
    assert.equal(writes[0].data, EPUB_BYTES);
    assert.deepEqual(result, {
        status: 'exported',
        path: '/exports/Paper.epub',
        byteLength: EPUB_BYTES.byteLength,
    });
});

test('rejects invalid builder bytes without writing a file', async t => {
    const cases = [
        { name: 'undefined', bytes: undefined },
        { name: 'null', bytes: null },
        { name: 'string', bytes: 'EPUB' },
        { name: 'plain array', bytes: [0x50, 0x4b] },
        { name: 'ArrayBuffer', bytes: new ArrayBuffer(2) },
        { name: 'Uint16Array', bytes: new Uint16Array([0x4b50]) },
        { name: 'empty Uint8Array', bytes: new Uint8Array() },
    ];
    for (const { name, bytes } of cases) {
        await t.test(name, async () => {
            const writes = [];
            const exporter = createExporter({
                writes,
                translate: key => key === 'viewer.exportEpubFailed'
                    ? 'EPUB 导出失败'
                    : key,
                buildEpub: async () => bytes,
                createID: () => {
                    assert.fail('invalid builder bytes must not allocate a write ID');
                },
            });

            await assert.rejects(exporter.export({
                title: 'Paper',
                markdown: '# Paper',
                assets: [],
            }), { message: 'EPUB 导出失败' });
            assert.deepEqual(writes, []);
        });
    }
});

function createExporter({
    picker = createFilePicker(),
    writes = [],
    ...options
} = {}) {
    return createZoteroEpubExporter({
        createFilePicker: () => picker,
        ioUtils: {
            async write(filePath, data, writeOptions) {
                writes.push({ path: filePath, data, options: writeOptions });
            },
        },
        createID: () => 'request-id',
        translate: key => key,
        buildEpub: async () => EPUB_BYTES,
        ...options,
    });
}

function createFilePicker({ result = 0, file = '/exports/Paper.epub' } = {}) {
    return {
        modeSave: 1,
        returnCancel: 1,
        file,
        filters: [],
        init(ownerWindow, title, mode) {
            this.initialized = { ownerWindow, title, mode };
        },
        appendFilter(title, pattern) {
            this.filters.push({ title, pattern });
        },
        async show() {
            this.shown = {
                defaultString: this.defaultString,
                filters: [...this.filters],
            };
            return result;
        },
    };
}
