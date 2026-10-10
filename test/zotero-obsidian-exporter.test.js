import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { sha256Hex } from '../src/core/sha256.js';
import {
    createZoteroObsidianExporter,
} from '../src/platform/zotero-obsidian-exporter.js';

const pathUtils = { join: path.posix.join };
const metadata = {
    libraryID: 1,
    itemKey: 'ABCD2345',
    attachmentKey: 'PDFKEY12',
    title: 'Paper',
    creators: [{
        creatorType: 'author',
        firstName: 'Ada',
        lastName: 'Lovelace',
    }],
    date: '2024',
    doi: '10.1000/paper',
    provider: 'mineru',
    view: 'original',
};

test('cancels Obsidian export without writing when vault selection is cancelled', async () => {
    const writes = [];
    const exporter = createExporter({
        writes,
        pickerResult: 1,
    });

    const result = await exporter.export(exportInput());

    assert.deepEqual(result, { status: 'cancelled' });
    assert.deepEqual(writes, []);
});

test('writes the current Markdown and figures inside the remembered vault', async () => {
    const writes = [];
    const vaults = [];
    const exporter = createExporter({
        writes,
        existingPaths: ['/vault/.obsidian'],
        setVaultPath: value => vaults.push(value),
    });

    const result = await exporter.export(exportInput({
        markdown: '![Figure](images/figure.png)',
        assetBasePath: 'result',
        assets: [{
            path: 'result/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
    }));

    assert.equal(result.status, 'exported');
    assert.equal(result.path, '/vault/Mktero/Paper/Paper.md');
    assert.equal(result.assetCount, 1);
    assert.deepEqual(vaults, ['/vault']);
    const note = writes.find(write => write.path === result.path);
    assert.match(note.data, /^---\n/);
    assert.match(note.data, /mktero-item: "ABCD2345"/);
    assert.match(note.data, /mktero-view: "original"/);
    assert.match(note.data, /!\[\]\(assets\/images\/figure\.png\)\n\nFigure\n?$/);
    const chinese = writes.find(write => (
        write.path === '/vault/Mktero/Paper/Paper - chinese.md'
    ));
    assert.match(chinese.data, /mktero-view: "zh-CN"/);
    assert.match(chinese.data, /# 论文/);
    assert.equal(
        writes.filter(write => write.type === 'binary').length,
        1
    );
    assert.equal(
        writes.find(write => write.type === 'binary').path,
        '/vault/Mktero/Paper/assets/images/figure.png'
    );
});

test('updates the same note after the title changes and skips the picker', async () => {
    const writes = [];
    const files = new Map();
    const ioUtils = createIOUtils(writes, {
        existingPaths: ['/vault/.obsidian'],
        files,
    });
    let pickerCalls = 0;
    const exporter = createZoteroObsidianExporter({
        createFilePicker: () => {
            pickerCalls += 1;
            return createFilePicker({ result: 0, file: '/vault' });
        },
        ioUtils,
        pathUtils,
        createID: () => 'request-id',
        getVaultPath: () => '/vault',
        setVaultPath: () => {},
        getSubdirectory: () => 'Mktero',
        profilePath: '/profile',
        confirmOverwrite: async () => {
            throw new Error('unchanged note should not ask');
        },
        now: () => new Date('2026-09-28T02:40:00.000Z'),
    });

    await exporter.export(exportInput());
    writes.length = 0;
    const result = await exporter.export(exportInput({
        metadata: { ...metadata, title: 'Renamed paper' },
        markdown: '# Renamed\n',
    }));

    assert.equal(pickerCalls, 0);
    assert.equal(result.path, '/vault/Mktero/Paper/Paper.md');
    assert.match(files.get(result.path), /title: "Renamed paper"/);
    assert.match(files.get(result.path), /# Renamed/);
});

test('does not overwrite a hand-edited note unless the user confirms', async () => {
    const writes = [];
    const files = new Map();
    const ioUtils = createIOUtils(writes, {
        existingPaths: ['/vault/.obsidian'],
        files,
    });
    const exporter = createExporter({
        writes,
        ioUtils,
        vaultPath: '/vault',
        confirmOverwrite: async () => false,
    });
    await exporter.export(exportInput({
        markdown: '# Original\n',
        translations: [],
    }));
    files.set(
        '/vault/Mktero/Paper/Paper.md',
        files.get('/vault/Mktero/Paper/Paper.md').replace(
            '# Original\n',
            '# Original\n\nHand edit\n'
        )
    );
    writes.length = 0;

    const cancelled = await exporter.export(exportInput({
        markdown: '# Updated\n',
        translations: [],
    }));

    assert.deepEqual(cancelled, { status: 'cancelled' });
    assert.equal(writes.some(write => write.type === 'text'
        && write.path.endsWith('Paper.md')), false);
    assert.match(files.get('/vault/Mktero/Paper/Paper.md'), /Hand edit/);
});

test('puts a colliding title in a directory named with the Zotero item key', async () => {
    const writes = [];
    const files = new Map();
    files.set('/vault/Mktero/Paper/Paper.md', [
        '---',
        'mktero-library: "1"',
        'mktero-item: "OTHERKEY"',
        '---',
        '# Other',
        '',
    ].join('\n'));
    const exporter = createExporter({
        writes,
        ioUtils: createIOUtils(writes, {
            existingPaths: [
                '/vault/.obsidian',
                '/vault/Mktero/Paper',
                '/vault/Mktero/Paper/Paper.md',
            ],
            files,
        }),
        vaultPath: '/vault',
    });

    const result = await exporter.export(exportInput());

    assert.equal(result.path, '/vault/Mktero/Paper ABCD2345/Paper ABCD2345.md');
    assert.match(files.get(result.path), /mktero-item: "ABCD2345"/);
    assert.match(files.get('/vault/Mktero/Paper/Paper.md'), /OTHERKEY/);
});

test('rejects a selected folder that is not an Obsidian vault', async () => {
    const writes = [];
    const exporter = createExporter({ writes, existingPaths: [] });

    await assert.rejects(
        exporter.export(exportInput()),
        /not an Obsidian vault/
    );
    assert.equal(writes.some(write => write.type === 'text'), false);
});

test('writes into a pre-resolved vault without opening the file picker', async () => {
    const writes = [];
    const files = new Map();
    const exporter = createZoteroObsidianExporter({
        createFilePicker: () => {
            throw new Error('picker should not open');
        },
        ioUtils: createIOUtils(writes, {
            existingPaths: ['/chosen/.obsidian'],
            files,
        }),
        pathUtils,
        createID: () => 'request-id',
        getVaultPath: () => '',
        setVaultPath: () => {
            throw new Error('saved vault should not change');
        },
        getSubdirectory: () => 'Mktero',
        profilePath: '/profile',
        confirmOverwrite: async () => true,
        now: () => new Date('2026-09-28T02:40:00.000Z'),
    });

    const result = await exporter.export(exportInput({
        vaultPath: '/chosen',
        translations: [],
    }));

    assert.equal(result.status, 'exported');
    assert.equal(result.path, '/chosen/Mktero/Paper/Paper.md');
    assert.match(files.get(result.path), /# Paper/);
});

test('skips a hand-edited note without asking when the conflict policy is skip', async () => {
    const writes = [];
    const files = new Map();
    const ioUtils = createIOUtils(writes, {
        existingPaths: ['/vault/.obsidian'],
        files,
    });
    let confirmCalls = 0;
    const exporter = createExporter({
        writes,
        ioUtils,
        vaultPath: '/vault',
        confirmOverwrite: async () => {
            confirmCalls += 1;
            return true;
        },
    });
    await exporter.export(exportInput({
        markdown: '# Original\n',
        translations: [],
    }));
    files.set(
        '/vault/Mktero/Paper/Paper.md',
        files.get('/vault/Mktero/Paper/Paper.md').replace(
            '# Original\n',
            '# Original\n\nHand edit\n'
        )
    );
    writes.length = 0;

    const skipped = await exporter.export(exportInput({
        markdown: '# Updated\n',
        translations: [],
        conflictPolicy: 'skip',
    }));

    assert.equal(confirmCalls, 0);
    assert.equal(skipped.status, 'conflict');
    assert.equal(skipped.conflicts[0].language, 'original');
    assert.equal(
        skipped.conflicts[0].path,
        '/vault/Mktero/Paper/Paper.md'
    );
    assert.equal(writes.some(write => write.type === 'text'
        && write.path.endsWith('Paper.md')), false);
    assert.match(files.get('/vault/Mktero/Paper/Paper.md'), /Hand edit/);
});

test('exports unchanged versions and reports the conflicting version without writing it', async () => {
    const writes = [];
    const files = new Map();
    const ioUtils = createIOUtils(writes, {
        existingPaths: ['/vault/.obsidian'],
        files,
    });
    let confirmCalls = 0;
    const exporter = createExporter({
        writes,
        ioUtils,
        vaultPath: '/vault',
        confirmOverwrite: async () => {
            confirmCalls += 1;
            return true;
        },
    });
    await exporter.export(exportInput({
        markdown: '# Original\n',
        translations: [{
            language: 'zh-CN',
            markdown: '# 论文\n',
        }],
    }));
    files.set(
        '/vault/Mktero/Paper/Paper - chinese.md',
        files.get('/vault/Mktero/Paper/Paper - chinese.md').replace(
            '# 论文\n',
            '# 论文\n\nHand edit\n'
        )
    );
    writes.length = 0;

    const mixed = await exporter.export(exportInput({
        markdown: '# Updated\n',
        translations: [{
            language: 'zh-CN',
            markdown: '# 更新译文\n',
        }],
        conflictPolicy: 'skip',
    }));

    assert.equal(confirmCalls, 0);
    assert.equal(mixed.status, 'exported');
    assert.equal(mixed.conflicts.length, 1);
    assert.equal(mixed.conflicts[0].language, 'zh-CN');
    assert.equal(
        mixed.conflicts[0].path,
        '/vault/Mktero/Paper/Paper - chinese.md'
    );
    assert.equal(writes.some(write => write.type === 'text'
        && write.path.endsWith('/Paper.md')), true);
    assert.equal(writes.some(write => write.type === 'text'
        && write.path.endsWith('Paper - chinese.md')), false);
    assert.match(files.get('/vault/Mktero/Paper/Paper.md'), /# Updated/);
    assert.match(
        files.get('/vault/Mktero/Paper/Paper - chinese.md'),
        /Hand edit/
    );
    assert.doesNotMatch(
        files.get('/vault/Mktero/Paper/Paper - chinese.md'),
        /更新译文/
    );
});

test('overwrites a hand-edited note without asking when the conflict policy is overwrite', async () => {
    const writes = [];
    const files = new Map();
    const ioUtils = createIOUtils(writes, {
        existingPaths: ['/vault/.obsidian'],
        files,
    });
    const exporter = createExporter({
        writes,
        ioUtils,
        vaultPath: '/vault',
        confirmOverwrite: async () => {
            throw new Error('overwrite should not ask');
        },
    });
    await exporter.export(exportInput({
        markdown: '# Original\n',
        translations: [],
    }));
    files.set(
        '/vault/Mktero/Paper/Paper.md',
        files.get('/vault/Mktero/Paper/Paper.md').replace(
            '# Original\n',
            '# Original\n\nHand edit\n'
        )
    );

    const result = await exporter.export(exportInput({
        markdown: '# Updated\n',
        translations: [],
        conflictPolicy: 'overwrite',
    }));

    assert.equal(result.status, 'exported');
    assert.match(files.get('/vault/Mktero/Paper/Paper.md'), /# Updated/);
    assert.doesNotMatch(
        files.get('/vault/Mktero/Paper/Paper.md'),
        /Hand edit/
    );
});

function exportInput(overrides = {}) {
    return {
        ownerWindow: {},
        title: 'Paper',
        markdown: '# Paper\n',
        assets: [],
        metadata,
        translations: [{
            language: 'zh-CN',
            markdown: '# 论文\n',
        }],
        ...overrides,
        metadata: overrides.metadata || metadata,
        translations: Object.hasOwn(overrides, 'translations')
            ? overrides.translations
            : [{
                language: 'zh-CN',
                markdown: '# 论文\n',
            }],
    };
}

function createExporter({
    writes,
    existingPaths = [],
    files,
    ioUtils = createIOUtils(writes, { existingPaths, files }),
    pickerResult = 0,
    vaultPath = '',
    setVaultPath,
    confirmOverwrite = async () => true,
}) {
    let savedVault = vaultPath;
    return createZoteroObsidianExporter({
        createFilePicker: () => createFilePicker({
            result: pickerResult,
            file: '/vault',
        }),
        ioUtils,
        pathUtils,
        createID: () => 'request-id',
        getVaultPath: () => savedVault,
        setVaultPath: value => {
            savedVault = value;
            setVaultPath?.(value);
        },
        getSubdirectory: () => 'Mktero',
        profilePath: '/profile',
        confirmOverwrite,
        now: () => new Date('2026-09-28T02:40:00.000Z'),
    });
}

function createFilePicker({ result, file }) {
    return {
        modeGetFolder: 2,
        returnCancel: 1,
        file,
        init() {},
        async show() {
            return result;
        },
    };
}

function createIOUtils(writes, { existingPaths = [], files = new Map() } = {}) {
    const existing = new Set(existingPaths);
    for (const filePath of files.keys()) existing.add(filePath);
    return {
        async exists(filePath) {
            return existing.has(filePath);
        },
        async makeDirectory(filePath) {
            writes.push({ type: 'directory', path: filePath });
            existing.add(filePath);
        },
        async write(filePath, data) {
            writes.push({ type: 'binary', path: filePath, data });
            existing.add(filePath);
        },
        async writeUTF8(filePath, data, options) {
            writes.push({ type: 'text', path: filePath, data, options });
            files.set(filePath, data);
            existing.add(filePath);
        },
        async readUTF8(filePath) {
            if (!files.has(filePath)) throw new Error(`missing ${filePath}`);
            return files.get(filePath);
        },
        async remove(filePath) {
            writes.push({ type: 'remove', path: filePath });
            existing.delete(filePath);
            files.delete(filePath);
        },
    };
}

test('body hashes are stable for the exporter index', async () => {
    const hash = await sha256Hex(new TextEncoder().encode('# Paper\n'));
    assert.match(hash, /^[a-f0-9]{64}$/);
});
