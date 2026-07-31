import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MarkdownLocalAnnotations,
    mergeAnnotationOverlays,
} from '../src/core/markdown-local-annotations.js';
import {
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
} from '../src/core/pdf-annotation.js';

test('creates, updates, and deletes a persistent Markdown annotation', async () => {
    const store = createMemoryStore();
    const annotations = new MarkdownLocalAnnotations({
        store,
        createID: () => 'local-1',
    });

    const created = await annotations.create(42, {
        text: 'Selected text',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 5, to: 18 }],
    });
    const updated = await annotations.update(42, created.id, {
        comment: 'Review this',
        color: '#ff6666',
    });

    assert.equal(updated.comment, 'Review this');
    assert.equal(updated.color, '#ff6666');
    assert.equal(updated.source, 'markdown');
    assert.deepEqual((await store.get(42))[0], {
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'Selected text',
        comment: 'Review this',
        color: '#ff6666',
        ranges: [{ from: 5, to: 18 }],
    });

    await annotations.delete(42, created.id);
    assert.deepEqual(await store.get(42), []);
});

test('creates a Zotero PDF annotation for a Markdown highlight', async () => {
    const createdPDFAnnotations = [];
    const synchronizationChanges = [];
    const store = createMemoryStore();
    const annotations = new MarkdownLocalAnnotations({
        store,
        createID: () => 'local-1',
        createPDFAnnotation: async (itemID, annotation) => {
            createdPDFAnnotations.push({ itemID, annotation });
            return {
                ...annotation,
                id: 'ZOTERO001',
                source: 'zotero',
                pageLabel: '1',
            };
        },
        onSynchronizationChange: itemID => {
            synchronizationChanges.push(itemID);
        },
    });
    const draft = {
        text: 'The sound of stress recovery',
        comment: 'Paper title',
        color: '#ffd400',
        ranges: [{ from: 0, to: 28 }],
    };

    const created = await annotations.create(42, draft);

    assert.equal(created.id, 'mktero-local-1');
    assert.equal(created.source, 'markdown');
    await waitFor(() => createdPDFAnnotations.length === 1);
    assert.deepEqual(createdPDFAnnotations, [{
        itemID: 42,
        annotation: draft,
    }]);
    await waitFor(async () => (await store.get(42)).length === 0);
    assert.deepEqual(synchronizationChanges, [42]);
});

test('persists a Markdown highlight without waiting for PDF synchronization', async () => {
    const store = createMemoryStore();
    const annotations = new MarkdownLocalAnnotations({
        store,
        createID: () => 'local-1',
        createPDFAnnotation: async () => new Promise(() => {}),
    });
    const draft = {
        text: 'The sound of stress recovery',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 0, to: 28 }],
    };

    const outcome = await Promise.race([
        annotations.create(42, draft),
        new Promise(resolve => setImmediate(() => resolve('stalled'))),
    ]);

    assert.notEqual(outcome, 'stalled');
    assert.equal(outcome.id, 'mktero-local-1');
    assert.equal(outcome.source, 'markdown');
    assert.deepEqual(await store.get(42), [{
        ...draft,
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
    }]);
    annotations.dispose();
});

test('keeps a deferred Markdown highlight without reporting a failure', async () => {
    const store = createMemoryStore();
    const errors = [];
    const synchronizationChanges = [];
    let createCalls = 0;
    const annotations = new MarkdownLocalAnnotations({
        store,
        createID: () => 'local-1',
        createPDFAnnotation: async () => {
            createCalls++;
            return { deferred: true };
        },
        onError: error => errors.push(error.message),
        onSynchronizationChange: itemID => {
            synchronizationChanges.push(itemID);
        },
    });
    const draft = {
        text: 'The sound of stress recovery',
        comment: 'Paper title',
        color: '#ffd400',
        ranges: [{ from: 0, to: 28 }],
    };

    const created = await annotations.create(42, draft);
    await waitFor(() => createCalls === 1);
    const resolved = await annotations.resolve(
        42,
        'The sound of stress recovery continues.'
    );
    await waitFor(() => createCalls === 2);

    assert.equal(created.id, 'mktero-local-1');
    assert.deepEqual(await store.get(42), [{
        ...draft,
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
    }]);
    assert.equal(resolved.warning, undefined);
    assert.deepEqual(errors, []);
    assert.deepEqual(synchronizationChanges, []);
});

test('synchronizes deferred Markdown highlights when the PDF is opened later', async () => {
    const local = {
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'The sound of stress recovery',
        comment: 'Paper title',
        color: '#ffd400',
        ranges: [{ from: 0, to: 28 }],
    };
    const store = createMemoryStore([local]);
    let readerOpen = false;
    let createCalls = 0;
    const contexts = [];
    const annotations = new MarkdownLocalAnnotations({
        store,
        async createPDFAnnotation(_itemID, _draft, context) {
            createCalls++;
            contexts.push(context);
            return readerOpen
                ? { id: 'ZOTERO001', source: 'zotero' }
                : { deferred: true };
        },
    });

    await annotations.synchronizePending(42);
    await waitFor(() => createCalls === 1);
    assert.deepEqual(await store.get(42), [local]);

    readerOpen = true;
    const context = { reader: { itemID: 42 } };
    await annotations.synchronizePending(42, context);

    await waitFor(() => createCalls === 2);
    await waitFor(async () => (await store.get(42)).length === 0);
    assert.deepEqual(contexts, [null, context]);
});

test('deletes a newly synchronized PDF highlight after its local draft was deleted', async () => {
    let finishSynchronization;
    let synchronizationStarted = false;
    const synchronization = new Promise(resolve => {
        finishSynchronization = resolve;
    });
    const deleted = [];
    const store = createMemoryStore();
    const annotations = new MarkdownLocalAnnotations({
        store,
        createID: () => 'local-1',
        async createPDFAnnotation() {
            synchronizationStarted = true;
            return synchronization;
        },
        async deletePDFAnnotation(itemID, annotationID) {
            deleted.push({ itemID, annotationID });
        },
    });
    const created = await annotations.create(42, {
        text: 'Selected text',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 0, to: 13 }],
    });
    await waitFor(() => synchronizationStarted);

    await annotations.delete(42, created.id);
    finishSynchronization({ id: 'ZOTERO001', reused: false });

    await waitFor(() => deleted.length === 1);
    assert.deepEqual(deleted, [{
        itemID: 42,
        annotationID: 'ZOTERO001',
    }]);
    assert.deepEqual(await store.get(42), []);
});

test('migrates an existing local Markdown highlight into Zotero PDF', async () => {
    const local = {
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'The sound of stress recovery',
        comment: 'Paper title',
        color: '#ffd400',
        ranges: [{ from: 4, to: 32 }],
    };
    const store = createMemoryStore([local]);
    const synchronized = [];
    const annotations = new MarkdownLocalAnnotations({
        store,
        async createPDFAnnotation(itemID, draft) {
            synchronized.push({ itemID, draft });
            return {
                id: 'ZOTERO001',
                source: 'zotero',
                type: 'highlight',
                text: draft.text,
                comment: draft.comment,
                color: draft.color,
                pageLabel: '1',
                pageIndex: 0,
                sortIndex: '00000|000001|00000',
            };
        },
    });

    const result = await annotations.resolve(
        42,
        'The The sound of stress recovery continues.'
    );

    assert.equal(result.matched[0].id, 'mktero-local-1');
    assert.equal(result.matched[0].source, 'markdown');
    await waitFor(() => synchronized.length === 1);
    await waitFor(async () => (await store.get(42)).length === 0);
    assert.deepEqual(synchronized, [{
        itemID: 42,
        draft: {
            text: local.text,
            comment: local.comment,
            color: local.color,
            ranges: local.ranges,
        },
    }]);
});

test('keeps a local highlight when PDF synchronization fails', async () => {
    const local = {
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'The sound of stress recovery',
        comment: 'Paper title',
        color: '#ffd400',
        ranges: [{ from: 4, to: 32 }],
    };
    const store = createMemoryStore([local]);
    const errors = [];
    const annotations = new MarkdownLocalAnnotations({
        store,
        async createPDFAnnotation() {
            throw new Error('PDF text not found');
        },
        onError: error => errors.push(error.message),
    });

    const result = await annotations.resolve(
        42,
        'The The sound of stress recovery continues.'
    );

    await waitFor(() => errors.length === 1);
    const retried = await annotations.resolve(
        42,
        'The The sound of stress recovery continues.'
    );

    assert.deepEqual(await store.get(42), [local]);
    assert.equal(result.matched[0].id, local.id);
    assert.equal(
        retried.warning,
        'Some local Markdown annotations could not be synchronized to the PDF.'
    );
    assert.deepEqual(errors, ['PDF text not found']);
});

test('retries a failed PDF synchronization when explicitly requested', async () => {
    const local = {
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'The sound of stress recovery',
        comment: 'Paper title',
        color: '#ffd400',
        ranges: [{ from: 4, to: 32 }],
    };
    const store = createMemoryStore([local]);
    let createCalls = 0;
    const errors = [];
    const annotations = new MarkdownLocalAnnotations({
        store,
        async createPDFAnnotation() {
            createCalls++;
            if (createCalls === 1) throw new Error('PDF reader unavailable');
            return { id: 'ZOTERO001', source: 'zotero' };
        },
        onError: error => errors.push(error.message),
    });
    const markdown = 'The The sound of stress recovery continues.';

    await annotations.resolve(42, markdown);
    await waitFor(() => errors.length === 1);
    await annotations.resolve(42, markdown, { retryFailed: true });

    await waitFor(() => createCalls === 2);
    await waitFor(async () => (await store.get(42)).length === 0);
});

test('serializes concurrent migration of the same local highlight', async () => {
    const local = {
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'The sound of stress recovery',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 4, to: 32 }],
    };
    const store = createMemoryStore([local]);
    let createCalls = 0;
    let releaseCreation;
    const creationAllowed = new Promise(resolve => {
        releaseCreation = resolve;
    });
    const annotations = new MarkdownLocalAnnotations({
        store,
        async createPDFAnnotation() {
            createCalls++;
            await creationAllowed;
            return {
                ...local,
                id: 'ZOTERO001',
                source: 'zotero',
            };
        },
    });
    const markdown = 'The The sound of stress recovery continues.';

    const first = annotations.resolve(42, markdown);
    await Promise.resolve();
    await Promise.resolve();
    const second = annotations.resolve(42, markdown);
    const secondResult = await second;

    await waitFor(() => createCalls === 1);
    assert.equal(createCalls, 1);
    assert.equal(secondResult.matched[0].id, 'mktero-local-1');
    releaseCreation();
    const firstResult = await first;
    assert.equal(firstResult.matched[0].id, 'mktero-local-1');
    await waitFor(async () => (await store.get(42)).length === 0);
    assert.equal(createCalls, 1);
});

test('restores saved ranges and relocates a uniquely moved Markdown quote', async () => {
    const store = createMemoryStore([{
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'important result',
        comment: 'Keep this',
        color: '#ffd400',
        ranges: [{ from: 4, to: 20 }],
    }]);
    const annotations = new MarkdownLocalAnnotations({ store });

    const original = await annotations.resolve(42, 'The important result stands.');
    const moved = await annotations.resolve(
        42,
        'A preface. The important result stands.'
    );

    assert.deepEqual(original.matched[0].ranges, [{ from: 4, to: 20 }]);
    assert.deepEqual(moved.matched[0].ranges, [{ from: 15, to: 31 }]);
    assert.equal(moved.matched[0].matchKind, 'local');
});

test('relocates a local quote after Markdown whitespace is reflowed', async () => {
    const store = createMemoryStore([{
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'important result',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 40, to: 56 }],
    }]);
    const annotations = new MarkdownLocalAnnotations({ store });

    const result = await annotations.resolve(
        42,
        'A preface. The important\nresult stands.'
    );

    assert.deepEqual(result.matched[0].ranges, [{ from: 15, to: 31 }]);
});

test('does not guess when a moved Markdown quote becomes ambiguous', async () => {
    const store = createMemoryStore([{
        id: 'mktero-local-1',
        source: 'markdown',
        type: 'highlight',
        text: 'same quote',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 50, to: 60 }],
    }]);
    const annotations = new MarkdownLocalAnnotations({ store });

    const result = await annotations.resolve(
        42,
        'same quote appears, and the same quote appears again.'
    );

    assert.deepEqual(result.matched, []);
    assert.equal(result.unmatched[0].reason, 'ambiguous');
});

test('rejects unsafe local annotation input before writing it', async () => {
    let putCalls = 0;
    const annotations = new MarkdownLocalAnnotations({
        store: {
            async get() {
                return [];
            },
            async put() {
                putCalls++;
            },
        },
        createID: () => 'local-1',
    });
    const draft = {
        text: 'Selected text',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 0, to: 13 }],
    };

    await assert.rejects(
        () => annotations.create(42, {
            ...draft,
            color: '#fff; color: red',
        }),
        /Invalid Markdown annotation/
    );
    await assert.rejects(
        () => annotations.create(42, {
            ...draft,
            ranges: [{ from: 0, to: 8 * 1024 * 1024 + 1 }],
        }),
        /ranges exceed/
    );
    await assert.rejects(
        () => annotations.create(42, {
            ...draft,
            comment: 'x'.repeat(MAX_PDF_ANNOTATION_TEXT_LENGTH + 1),
        }),
        /Invalid Markdown annotation/
    );
    assert.equal(putCalls, 0);
});

test('reports an unreadable local annotation store without breaking conversion', async () => {
    const errors = [];
    const annotations = new MarkdownLocalAnnotations({
        store: {
            async get() {
                throw new Error('private filesystem detail');
            },
            async put() {},
        },
        onError: error => errors.push(error.message),
    });

    const result = await annotations.resolve(42, 'Readable Markdown');

    assert.deepEqual(result, {
        matched: [],
        unmatched: [],
        warning: 'Local Markdown annotations could not be loaded.',
    });
    assert.deepEqual(errors, ['private filesystem detail']);
});

test('merges PDF and local annotations without changing either overlay', () => {
    const pdf = { matched: [{ id: 'PDF1' }], unmatched: [] };
    const local = { matched: [{ id: 'mktero-local-1' }], unmatched: [] };

    assert.deepEqual(mergeAnnotationOverlays(pdf, local), {
        matched: [{ id: 'PDF1' }, { id: 'mktero-local-1' }],
        unmatched: [],
    });
});

function createMemoryStore(initial = []) {
    let value = structuredClone(initial);
    return {
        async get() {
            return structuredClone(value);
        },
        async put(_itemID, annotations) {
            value = structuredClone(annotations);
        },
    };
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (await predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Condition was not reached');
}
