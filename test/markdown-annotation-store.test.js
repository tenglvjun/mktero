import test from 'node:test';
import assert from 'node:assert/strict';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    MarkdownAnnotationStore,
} from '../src/cache/markdown-annotation-store.js';
import {
    MARKDOWN_ANNOTATIONS_SET_ASIDE_WARNING,
    MarkdownLocalAnnotations,
} from '../src/core/markdown-local-annotations.js';

test('restores local Markdown annotations across store instances', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-annotations-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: {
            join: path.join,
            parent: path.dirname,
        },
    };
    const annotations = [{
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'Selected text',
        comment: 'Review this',
        color: '#ffd400',
        ranges: [{ from: 5, to: 18 }],
    }];

    await new MarkdownAnnotationStore(options).put(42, annotations);

    assert.deepEqual(
        await new MarkdownAnnotationStore(options).get(42),
        annotations
    );
});

test('keeps a corrupt local annotation file for possible recovery', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-annotations-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const filePath = path.join(rootPath, 'item-42.json');
    await writeFile(filePath, '{not-json');
    const store = new MarkdownAnnotationStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
        now: () => 1_786_320_000_000,
    });

    await assert.rejects(() => store.get(42), error => (
        error.code === 'MARKDOWN_ANNOTATION_STORE_INVALID'
        && error.cause instanceof SyntaxError
    ));
    assert.equal(await readFile(filePath, 'utf8'), '{not-json');

    assert.equal(await store.setAside(42), true);
    assert.deepEqual(await readdir(rootPath), [
        'item-42.corrupt-1786320000000.json',
    ]);
    assert.equal(
        await readFile(
            path.join(rootPath, 'item-42.corrupt-1786320000000.json'),
            'utf8'
        ),
        '{not-json'
    );
    assert.deepEqual(await store.get(42), []);
    assert.equal(await store.setAside(42), false);

    // A second damaged file in the same millisecond keeps the first backup.
    await writeFile(filePath, '{also-not-json');
    assert.equal(await store.setAside(42), true);
    assert.deepEqual((await readdir(rootPath)).sort(), [
        'item-42.corrupt-1786320000000-1.json',
        'item-42.corrupt-1786320000000.json',
    ]);
});

test('reports damaged annotation store contents as invalid and read failures as retryable', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-annotations-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const store = new MarkdownAnnotationStore({
        rootPath,
        ioUtils,
        pathUtils: { join: path.join, parent: path.dirname },
    });
    const filePath = path.join(rootPath, 'item-42.json');

    await writeFile(filePath, JSON.stringify({
        schemaVersion: 1,
        itemID: 7,
        annotations: [],
    }));
    await assert.rejects(
        () => store.get(42),
        error => error.code === 'MARKDOWN_ANNOTATION_STORE_INVALID'
    );

    await writeFile(filePath, JSON.stringify({
        schemaVersion: 1,
        itemID: 42,
        annotations: [],
    }));
    const readError = Object.assign(new Error('The file is locked'), {
        name: 'NotReadableError',
    });
    ioUtils.readUTF8 = async () => {
        throw readError;
    };
    await assert.rejects(() => store.get(42), error => error === readError);
});

test('sets aside a damaged annotation file and accepts new annotations', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-annotations-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const filePath = path.join(rootPath, 'item-42.json');
    await writeFile(filePath, '{not-json');
    const errors = [];
    const annotations = new MarkdownLocalAnnotations({
        store: new MarkdownAnnotationStore({
            rootPath,
            ioUtils: createNodeIOUtils(),
            pathUtils: { join: path.join, parent: path.dirname },
            now: () => 1_786_320_000_000,
        }),
        createID: () => 'local-1',
        onError: error => errors.push(error.code),
    });

    const opened = await annotations.resolve(42, 'Readable Markdown');
    assert.deepEqual(opened, {
        matched: [],
        unmatched: [],
        warning: MARKDOWN_ANNOTATIONS_SET_ASIDE_WARNING,
    });
    assert.deepEqual(errors, ['MARKDOWN_ANNOTATION_STORE_INVALID']);

    await annotations.create(42, {
        text: 'Readable',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 0, to: 8 }],
    });
    assert.equal(
        await readFile(
            path.join(rootPath, 'item-42.corrupt-1786320000000.json'),
            'utf8'
        ),
        '{not-json'
    );
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    assert.deepEqual(
        saved.annotations.map(annotation => annotation.id),
        ['mktero-local-1']
    );
    const reopened = await annotations.resolve(42, 'Readable Markdown');
    assert.equal(reopened.warning, undefined);
    assert.equal(reopened.matched.length, 1);
});

test('rejects oversized annotation stores before reading their contents', async () => {
    let read = false;
    const store = new MarkdownAnnotationStore({
        rootPath: '/profile/mktero-annotations/v1',
        ioUtils: {
            exists: async () => true,
            stat: async () => ({ size: 4 * 1024 * 1024 + 1 }),
            async readUTF8() {
                read = true;
                return '{}';
            },
        },
        pathUtils: { join: path.join, parent: path.dirname },
    });

    await assert.rejects(
        () => store.get(42),
        /exceeds the safety limit/
    );
    assert.equal(read, false);
});

test('requires a bounded stat adapter for annotation store reads', () => {
    assert.throws(() => new MarkdownAnnotationStore({
        rootPath: '/profile/mktero-annotations/v1',
        ioUtils: {},
        pathUtils: { join: path.join, parent: path.dirname },
    }), /stat adapter is required/);
});

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await access(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        makeDirectory: (filePath, options) => mkdir(filePath, {
            recursive: Boolean(options?.ignoreExisting),
        }),
        readUTF8: filePath => readFile(filePath, 'utf8'),
        async writeUTF8(filePath, value, options = {}) {
            const temporaryPath = options.tmpPath || `${filePath}.tmp`;
            await writeFile(temporaryPath, value, 'utf8');
            await rename(temporaryPath, filePath);
        },
        stat,
        async move(sourcePath, destinationPath, options = {}) {
            if (options.noOverwrite) {
                try {
                    await access(destinationPath);
                    throw new Error('The destination already exists');
                }
                catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
            }
            await rename(sourcePath, destinationPath);
        },
    };
}

test('keeps readable annotations when another entry in the file is damaged', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-annotations-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const filePath = path.join(rootPath, 'item-42.json');
    const readable = {
        id: 'mktero-kept-1',
        source: 'markdown',
        type: 'highlight',
        text: 'Readable',
        comment: 'Keep this',
        color: '#ffd400',
        ranges: [{ from: 0, to: 8 }],
    };
    const original = JSON.stringify({
        schemaVersion: 1,
        itemID: 42,
        annotations: [
            readable,
            { ...readable, id: 'mktero-broken-1', color: 'not-a-color' },
        ],
    });
    await writeFile(filePath, original);
    const errors = [];
    const annotations = new MarkdownLocalAnnotations({
        store: new MarkdownAnnotationStore({
            rootPath,
            ioUtils: createNodeIOUtils(),
            pathUtils: { join: path.join, parent: path.dirname },
            now: () => 1_786_320_000_000,
        }),
        onError: error => errors.push(error.code),
    });

    const opened = await annotations.resolve(42, 'Readable Markdown');
    assert.deepEqual(
        opened.matched.map(annotation => [annotation.id, annotation.comment]),
        [['mktero-kept-1', 'Keep this']]
    );
    assert.equal(opened.warning, MARKDOWN_ANNOTATIONS_SET_ASIDE_WARNING);
    assert.deepEqual(errors, ['MARKDOWN_ANNOTATION_STORE_INVALID']);
    assert.equal(
        await readFile(
            path.join(rootPath, 'item-42.corrupt-1786320000000.json'),
            'utf8'
        ),
        original
    );
    assert.deepEqual(
        JSON.parse(await readFile(filePath, 'utf8')).annotations
            .map(annotation => annotation.id),
        ['mktero-kept-1']
    );

    // The rewritten file is valid, so reopening keeps the annotation
    // without setting aside anything else.
    const reopened = await new MarkdownLocalAnnotations({
        store: new MarkdownAnnotationStore({
            rootPath,
            ioUtils: createNodeIOUtils(),
            pathUtils: { join: path.join, parent: path.dirname },
        }),
    }).resolve(42, 'Readable Markdown');
    assert.equal(reopened.warning, undefined);
    assert.equal(reopened.matched.length, 1);
    assert.equal((await readdir(rootPath)).length, 2);
});

test('stops looking for a backup name after a bounded number of attempts', async () => {
    const moves = [];
    const store = new MarkdownAnnotationStore({
        rootPath: '/profile/mktero-annotations/v1',
        ioUtils: {
            exists: async () => true,
            stat: async () => ({ size: 0 }),
            move: async (...args) => moves.push(args),
        },
        pathUtils: { join: path.join, parent: path.dirname },
        now: () => 1_786_320_000_000,
    });

    await assert.rejects(
        () => store.setAside(42),
        /No free Markdown annotation backup name/
    );
    assert.deepEqual(moves, []);
});
