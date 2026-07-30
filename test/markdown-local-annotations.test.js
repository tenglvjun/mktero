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
