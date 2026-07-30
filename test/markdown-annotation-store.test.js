import test from 'node:test';
import assert from 'node:assert/strict';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
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
    });

    await assert.rejects(() => store.get(42), SyntaxError);
    assert.equal(await readFile(filePath, 'utf8'), '{not-json');
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
    };
}
