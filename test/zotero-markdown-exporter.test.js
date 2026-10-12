import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
    createZoteroMarkdownExporter,
} from '../src/platform/zotero-markdown-exporter.js';

const pathUtils = {
    join: path.posix.join,
};

test('cancels a Markdown export without writing files', async () => {
    const writes = [];
    const picker = createFilePicker({ result: 1 });
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => picker,
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: { name: 'zotero-window' },
        title: 'Paper',
        markdown: '# Paper',
        assets: [],
    });

    assert.deepEqual(result, { status: 'cancelled' });
    assert.deepEqual(writes, []);
    assert.deepEqual(picker.initialized, {
        ownerWindow: { name: 'zotero-window' },
        title: 'viewer.exportMarkdownDialogTitle',
        mode: 2,
    });
});

test('localizes the default Markdown export directory and file name', async () => {
    const writes = [];
    const picker = createFilePicker({ result: 0 });
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => picker,
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key === 'viewer.exportMarkdownDefaultFileName'
            ? '文档'
            : key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: '',
        markdown: '',
        assets: [],
    });

    assert.equal(result.path, '/exports/文档/文档.md');
    assert.equal(writes.at(-1).path, '/exports/文档/文档.md');
});

test('exports Markdown and images inside a paper directory', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: '/exports',
        }),
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '![Figure](images/figure.png)',
        assetBasePath: 'result',
        assets: [{
            path: 'result/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
    });

    assert.deepEqual(result, {
        status: 'exported',
        path: '/exports/Paper/Paper.md',
        assetDirectoryPath: '/exports/Paper/assets',
        assetCount: 1,
    });
    assert.deepEqual(writes, [
        {
            type: 'directory',
            path: '/exports/Paper',
            options: { ignoreExisting: false },
        },
        {
            type: 'directory',
            path: '/exports/Paper/assets',
            options: { ignoreExisting: false },
        },
        {
            type: 'directory',
            path: '/exports/Paper/assets/images',
            options: { ignoreExisting: true },
        },
        {
            type: 'binary',
            path: '/exports/Paper/assets/images/figure.png',
            data: new Uint8Array([1, 2, 3]),
        },
        {
            type: 'text',
            path: '/exports/Paper/Paper.md',
            data: '![Figure](assets/images/figure.png)',
            options: {
                tmpPath: '/exports/Paper/Paper.md.mktero-request-.tmp',
            },
        },
    ]);
});

test('exports case-colliding images without overwriting either file', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: '/exports',
        }),
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: [
            '![Upper](images/Figure.png)',
            '![Lower](images/figure.png)',
        ].join('\n'),
        assetBasePath: 'result',
        assets: [
            {
                path: 'result/images/Figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([1]),
            },
            {
                path: 'result/images/figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([2]),
            },
        ],
    });

    assert.deepEqual(
        writes.filter(write => write.type === 'binary').map(write => ({
            path: write.path,
            data: [...write.data],
        })),
        [
            {
                path: '/exports/Paper/assets/images/Figure.png',
                data: [1],
            },
            {
                path: '/exports/Paper/assets/images/figure-2.png',
                data: [2],
            },
        ]
    );
    assert.equal(writes.at(-1).data, [
        '![Upper](assets/images/Figure.png)',
        '![Lower](assets/images/figure-2.png)',
    ].join('\n'));
});

test('creates a paper directory without an empty assets directory', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: '/exports',
        }),
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '# Paper',
        assets: [],
    });

    assert.equal(result.path, '/exports/Paper/Paper.md');
    assert.equal(result.assetDirectoryPath, null);
    assert.deepEqual(writes.map(write => [write.type, write.path]), [
        ['directory', '/exports/Paper'],
        ['text', '/exports/Paper/Paper.md'],
    ]);
});

test('uses a numbered paper directory without overwriting existing exports', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: '/exports',
        }),
        ioUtils: createIOUtils(writes, {
            existingPaths: ['/exports/Paper', '/exports/Paper-2'],
        }),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '# Paper',
        assets: [],
    });

    assert.equal(result.path, '/exports/Paper-3/Paper-3.md');
    assert.equal(
        writes.some(write => write.path === '/exports/Paper'),
        false
    );
    assert.equal(
        writes.some(write => write.path === '/exports/Paper-2'),
        false
    );
});

test('keeps asset links stable inside a numbered paper directory', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({ result: 0 }),
        ioUtils: createIOUtils(writes, {
            existingPaths: ['/exports/Paper'],
        }),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    });

    assert.equal(result.path, '/exports/Paper-2/Paper-2.md');
    assert.equal(result.assetDirectoryPath, '/exports/Paper-2/assets');
    assert.equal(
        writes.at(-1).data,
        '![Figure](assets/images/figure.png)'
    );
});

test('retries when a paper directory is created during export', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({ result: 0 }),
        ioUtils: createIOUtils(writes, {
            raceDirectoryPath: '/exports/Paper',
        }),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    });

    assert.equal(result.path, '/exports/Paper-2/Paper-2.md');
    assert.equal(result.assetDirectoryPath, '/exports/Paper-2/assets');
    assert.equal(
        writes.some(write => (
            write.type === 'remove'
            && write.path === '/exports/Paper'
        )),
        false
    );
});

test('keeps folder pickers and exports isolated between Zotero windows', async () => {
    const writes = [];
    const firstPicker = createFilePicker({
        result: 0,
        file: '/first-window',
    });
    const secondPicker = createFilePicker({
        result: 0,
        file: '/second-window',
    });
    const pickerQueue = [firstPicker, secondPicker];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => pickerQueue.shift(),
        ioUtils: createIOUtils(writes),
        pathUtils,
        createID: (() => {
            let index = 0;
            return () => 'request-' + (++index);
        })(),
        translate: key => key,
    });
    const firstWindow = { name: 'first-zotero-window' };
    const secondWindow = { name: 'second-zotero-window' };

    const [first, second] = await Promise.all([
        exporter.export({
            ownerWindow: firstWindow,
            title: 'First Paper',
            markdown: '# First',
            assets: [],
        }),
        exporter.export({
            ownerWindow: secondWindow,
            title: 'Second Paper',
            markdown: '# Second',
            assets: [],
        }),
    ]);

    assert.equal(first.path, '/first-window/First Paper/First Paper.md');
    assert.equal(
        second.path,
        '/second-window/Second Paper/Second Paper.md'
    );
    assert.equal(firstPicker.initialized.ownerWindow, firstWindow);
    assert.equal(secondPicker.initialized.ownerWindow, secondWindow);
    assert.equal(firstPicker.initialized.mode, firstPicker.modeGetFolder);
    assert.equal(secondPicker.initialized.mode, secondPicker.modeGetFolder);
});

test('removes the new paper directory when an image write fails', async () => {
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({ result: 0 }),
        ioUtils: createIOUtils(writes, { failBinary: true }),
        pathUtils,
        createID: () => 'request-id',
        translate: key => key,
    });

    await assert.rejects(() => exporter.export({
        ownerWindow: {},
        title: 'Paper',
        markdown: '![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1]),
        }],
    }), /image write failed/);

    assert.equal(writes.some(write => write.type === 'text'), false);
    assert.deepEqual(
        writes.filter(write => write.type === 'remove').map(write => write.path),
        [
            '/exports/Paper/Paper.md.mktero-request-.tmp',
            '/exports/Paper',
        ]
    );
});

test('exports the reported Windows paper without exceeding 259 characters', async () => {
    const title = 'Study of (La1-xCax)MnO3. I. Magnetic Structure of LaMnO3 Journal of the Physical Society of Japan';
    const parent = 'C:\\Users\\86151\\Desktop';
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: parent,
        }),
        ioUtils: createIOUtils(writes),
        pathUtils: { join: path.win32.join },
        createID: () => 'dc3b6389-a940-4a5b-a85b-3369e0ab5e76',
        translate: key => key,
        isWindows: true,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title,
        markdown: '# Paper',
        assets: [],
    });

    assert.equal(result.path, path.win32.join(parent, title, `${title}.md`));
    assert.equal(
        writes.at(-1).options.tmpPath,
        result.path + '.mktero-dc3b6389.tmp'
    );
    assert.equal(writes.at(-1).options.tmpPath.length, 241);
});

test('shortens a long Windows export so the temporary file still fits', async () => {
    const title = 'x'.repeat(180);
    const parent = 'D:\\2399067154';
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: parent,
        }),
        ioUtils: createIOUtils(writes),
        pathUtils: { join: path.win32.join },
        createID: () => '72484692-9307-4cae-b3bc-fdaace407986',
        translate: key => key,
        isWindows: true,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title,
        markdown: '# Paper',
        assets: [],
    });

    const reserved = path.win32.basename(path.win32.dirname(result.path))
        + '-1000';
    const reservedTmp = path.win32.join(
        parent,
        reserved,
        `${reserved}.md.mktero-72484692.tmp`
    );
    assert.notEqual(path.win32.basename(result.path), `${title}.md`);
    assert.equal(writes.at(-1).options.tmpPath.length <= 259, true);
    assert.equal(reservedTmp.length <= 259, true);
});

test('does not shorten a Windows-looking path unless the platform flag is set', async () => {
    const title = 'x'.repeat(180);
    const writes = [];
    const exporter = createZoteroMarkdownExporter({
        createFilePicker: () => createFilePicker({
            result: 0,
            file: 'E:\\',
        }),
        ioUtils: createIOUtils(writes),
        pathUtils: { join: path.win32.join },
        createID: () => 'request-id',
        translate: key => key,
    });

    const result = await exporter.export({
        ownerWindow: {},
        title,
        markdown: '# Paper',
        assets: [],
    });

    assert.equal(
        result.path,
        path.win32.join('E:\\', title, `${title}.md`)
    );
});

function createFilePicker({ result, file = '/exports' }) {
    return {
        modeGetFolder: 2,
        returnCancel: 1,
        file,
        init(ownerWindow, title, mode) {
            this.initialized = { ownerWindow, title, mode };
        },
        async show() {
            return result;
        },
    };
}

function createIOUtils(writes, {
    existingPaths = [],
    failBinary = false,
    raceDirectoryPath = '',
} = {}) {
    const existing = new Set(existingPaths);
    let raced = false;
    return {
        async exists(filePath) {
            return existing.has(filePath);
        },
        async makeDirectory(filePath, options) {
            writes.push({ type: 'directory', path: filePath, options });
            if (!raced
                && filePath === raceDirectoryPath
                && options?.ignoreExisting === false) {
                raced = true;
                existing.add(filePath);
                throw new Error('directory already exists');
            }
        },
        async write(filePath, data) {
            writes.push({ type: 'binary', path: filePath, data });
            if (failBinary) throw new Error('image write failed');
        },
        async writeUTF8(filePath, data, options) {
            writes.push({ type: 'text', path: filePath, data, options });
        },
        async remove(filePath) {
            writes.push({ type: 'remove', path: filePath });
        },
    };
}
