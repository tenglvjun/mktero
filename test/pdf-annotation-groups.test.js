import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFAnnotationGroups } from '../src/core/pdf-annotation-groups.js';
import { createZoteroMarkdownAnnotationStore } from '../src/cache/markdown-annotation-store.js';
import { PDF_ANNOTATION_UNAVAILABLE } from '../src/core/pdf-annotation.js';

function unavailable() {
    const error = new Error('PDF annotation is unavailable or read-only');
    error.code = PDF_ANNOTATION_UNAVAILABLE;
    return error;
}

function memoryStore(initial = {}) {
    const values = new Map(Object.entries(initial).map(([key, value]) => [
        Number(key),
        structuredClone(value),
    ]));
    return {
        values,
        async get(itemID) {
            return structuredClone(values.get(itemID) || []);
        },
        async put(itemID, groups) {
            values.set(itemID, structuredClone(groups));
        },
    };
}

test('remembers the page parts of a cross-page highlight', async () => {
    const groups = new PDFAnnotationGroups({ store: memoryStore() });

    assert.equal(await groups.record(42, ['PAGE0001', 'PAGE0002']), true);

    assert.deepEqual(await groups.membersOf(42, 'PAGE0002'), ['PAGE0002', 'PAGE0001']);
    assert.deepEqual(await groups.membersOf(42, 'OTHER001'), ['OTHER001']);
    assert.deepEqual(await groups.membersOf(7, 'PAGE0001'), ['PAGE0001']);
});

test('a single-page highlight is not a group', async () => {
    const store = memoryStore();
    const groups = new PDFAnnotationGroups({ store });

    assert.equal(await groups.record(42, ['ONLY0001']), false);
    assert.equal(store.values.has(42), false);
});

test('a part recorded again moves to its new highlight', async () => {
    const groups = new PDFAnnotationGroups({ store: memoryStore() });
    await groups.record(42, ['A0000001', 'B0000001']);

    await groups.record(42, ['B0000001', 'C0000001']);

    assert.deepEqual(await groups.membersOf(42, 'A0000001'), ['A0000001']);
    assert.deepEqual(await groups.membersOf(42, 'C0000001'), ['C0000001', 'B0000001']);
});

test('applies an action to every part, clicked one first', async () => {
    const groups = new PDFAnnotationGroups({ store: memoryStore() });
    await groups.record(42, ['PAGE0001', 'PAGE0002', 'PAGE0003']);
    const calls = [];

    const reached = await groups.applyToGroup(42, 'PAGE0002', async id => {
        calls.push(id);
    });

    assert.deepEqual(calls, ['PAGE0002', 'PAGE0001', 'PAGE0003']);
    assert.deepEqual(reached, ['PAGE0002', 'PAGE0001', 'PAGE0003']);
});

test('skips a part deleted elsewhere and forgets it', async () => {
    const errors = [];
    const groups = new PDFAnnotationGroups({
        store: memoryStore(),
        onError: error => errors.push(error.message),
    });
    await groups.record(42, ['PAGE0001', 'PAGE0002', 'PAGE0003']);

    const reached = await groups.applyToGroup(42, 'PAGE0001', async id => {
        if (id === 'PAGE0002') throw unavailable();
    });

    assert.deepEqual(reached, ['PAGE0001', 'PAGE0003']);
    assert.deepEqual(errors, ['PDF annotation is unavailable or read-only']);
    assert.deepEqual(await groups.membersOf(42, 'PAGE0001'), ['PAGE0001', 'PAGE0003']);
});

test('keeps a part in its group when its save only failed for now', async () => {
    const groups = new PDFAnnotationGroups({ store: memoryStore(), onError: () => {} });
    await groups.record(42, ['PAGE0001', 'PAGE0002']);

    const reached = await groups.applyToGroup(42, 'PAGE0001', async id => {
        if (id === 'PAGE0002') throw new Error('database is locked');
    });

    assert.deepEqual(reached, ['PAGE0001']);
    assert.deepEqual(await groups.membersOf(42, 'PAGE0001'), ['PAGE0001', 'PAGE0002']);
});

test('sets an unreadable group file aside and starts over', async () => {
    const setAside = [];
    let corrupt = true;
    const stored = new Map();
    const groups = new PDFAnnotationGroups({
        store: {
            async get(itemID) {
                if (corrupt) {
                    const error = new Error('Invalid Markdown annotation store');
                    error.code = 'MARKDOWN_ANNOTATION_STORE_INVALID';
                    throw error;
                }
                return stored.get(itemID) || [];
            },
            async put(itemID, value) { stored.set(itemID, value); },
            async setAside(itemID) { setAside.push(itemID); corrupt = false; return true; },
        },
        onError: () => {},
    });

    assert.equal(await groups.record(42, ['PAGE0001', 'PAGE0002']), true);
    assert.deepEqual(setAside, [42]);
    assert.deepEqual(await groups.membersOf(42, 'PAGE0001'), ['PAGE0001', 'PAGE0002']);
});

test('the clicked part still decides whether the action failed', async () => {
    const groups = new PDFAnnotationGroups({ store: memoryStore() });
    await groups.record(42, ['PAGE0001', 'PAGE0002']);
    const calls = [];

    await assert.rejects(
        groups.applyToGroup(42, 'PAGE0001', async id => {
            calls.push(id);
            throw new Error('read-only');
        }),
        /read-only/
    );
    assert.deepEqual(calls, ['PAGE0001']);
});

test('deleting a highlight forgets its group', async () => {
    const groups = new PDFAnnotationGroups({ store: memoryStore() });
    await groups.record(42, ['PAGE0001', 'PAGE0002']);

    await groups.applyToGroup(42, 'PAGE0001', async () => {}, { forgetAfter: true });

    assert.deepEqual(await groups.membersOf(42, 'PAGE0002'), ['PAGE0002']);
});

test('an unreadable group store never blocks the action', async () => {
    const errors = [];
    const groups = new PDFAnnotationGroups({
        store: {
            async get() { throw new Error('disk error'); },
            async put() { throw new Error('disk error'); },
        },
        onError: error => errors.push(error.message),
    });
    const calls = [];

    const reached = await groups.applyToGroup(42, 'PAGE0001', async id => {
        calls.push(id);
    });

    assert.deepEqual(calls, ['PAGE0001']);
    assert.deepEqual(reached, ['PAGE0001']);
    assert.ok(errors.length >= 1);
    assert.equal(await groups.record(42, ['PAGE0001', 'PAGE0002']), false);
});

test('ignores malformed stored groups and keys', async () => {
    const groups = new PDFAnnotationGroups({
        store: memoryStore({
            42: [['GOOD0001', 'GOOD0002'], 'not-a-group', ['bad key!', 'GOOD0003'], null],
        }),
    });

    assert.deepEqual(await groups.membersOf(42, 'GOOD0002'), ['GOOD0002', 'GOOD0001']);
    assert.deepEqual(await groups.membersOf(42, 'GOOD0003'), ['GOOD0003']);
});

test('keeps groups in their own directory beside the local annotations', () => {
    const joined = [];
    const pathUtils = {
        join: (...parts) => {
            joined.push(parts);
            return parts.join('/');
        },
    };
    const io = { stat() {}, exists() {}, readUTF8() {}, writeUTF8() {}, makeDirectory() {} };
    const zotero = { Profile: { dir: '/profile' } };

    const groups = createZoteroMarkdownAnnotationStore({
        zotero, ioUtils: io, pathUtils, directory: 'groups-v1',
    });
    const local = createZoteroMarkdownAnnotationStore({ zotero, ioUtils: io, pathUtils });

    assert.equal(groups.rootPath, '/profile/mktero-annotations/groups-v1');
    assert.equal(local.rootPath, '/profile/mktero-annotations/v1');
    assert.throws(
        () => createZoteroMarkdownAnnotationStore({
            zotero, ioUtils: io, pathUtils, directory: '../escape',
        }),
        /Invalid Markdown annotation store directory/
    );
});
