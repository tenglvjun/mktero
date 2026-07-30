import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroAnnotationActions,
} from '../src/platform/zotero-annotation-actions.js';

test('changes the color of an annotation owned by the current PDF', async () => {
    const queue = {};
    let saveOptions;
    let committedQueue;
    const annotation = {
        id: 73,
        parentID: 42,
        isAnnotation: () => true,
        isEditable: () => true,
        async saveTx(options) {
            saveOptions = options;
        },
    };
    const zotero = {
        Items: {
            get: id => id === 42 ? { id: 42, libraryID: 7 } : null,
            getByLibraryAndKey: (libraryID, key) => (
                libraryID === 7 && key === 'ANN00001' ? annotation : null
            ),
        },
        Notifier: {
            Queue: class Queue {
                constructor() {
                    return queue;
                }
            },
            async commit(value) {
                committedQueue = value;
            },
        },
    };
    const actions = createZoteroAnnotationActions(zotero);

    await actions.changeColor(42, 'ANN00001', '#ff6666');

    assert.equal(annotation.annotationColor, '#ff6666');
    assert.equal(saveOptions.skipDateModifiedUpdate, true);
    assert.equal(saveOptions.notifierQueue, queue);
    assert.equal(committedQueue, queue);
});

test('deletes an annotation owned by the current PDF', async () => {
    const queue = {};
    let eraseOptions;
    let committedQueue;
    const annotation = {
        id: 73,
        parentID: 42,
        isAnnotation: () => true,
        isEditable: () => true,
        async eraseTx(options) {
            eraseOptions = options;
        },
    };
    const zotero = {
        Items: {
            get: id => id === 42 ? { id: 42, libraryID: 7 } : null,
            getByLibraryAndKey: (libraryID, key) => (
                libraryID === 7 && key === 'ANN00001' ? annotation : null
            ),
        },
        Notifier: {
            Queue: class Queue {
                constructor() {
                    return queue;
                }
            },
            async commit(value) {
                committedQueue = value;
            },
        },
    };
    const actions = createZoteroAnnotationActions(zotero);

    await actions.deleteAnnotation(42, 'ANN00001');

    assert.equal(eraseOptions.notifierQueue, queue);
    assert.equal(committedQueue, queue);
});

test('rejects unsafe colors and annotations owned by another PDF', async () => {
    let saveCalls = 0;
    let eraseCalls = 0;
    const annotation = {
        parentID: 99,
        isAnnotation: () => true,
        isEditable: () => true,
        async saveTx() {
            saveCalls++;
        },
        async eraseTx() {
            eraseCalls++;
        },
    };
    const zotero = {
        Items: {
            get: () => ({ id: 42, libraryID: 7 }),
            getByLibraryAndKey: () => annotation,
        },
        Notifier: {
            Queue: class Queue {},
            async commit() {},
        },
    };
    const actions = createZoteroAnnotationActions(zotero);

    await assert.rejects(
        actions.changeColor(42, 'ANN00001', '#fff; color: red'),
        /Unsupported PDF annotation color/
    );
    await assert.rejects(
        actions.deleteAnnotation(42, 'ANN00001'),
        /unavailable or read-only/
    );
    assert.equal(saveCalls, 0);
    assert.equal(eraseCalls, 0);
});

test('restores the previous color when Zotero cannot save the annotation', async () => {
    let committed = false;
    const annotation = {
        parentID: 42,
        annotationColor: '#ffd400',
        isAnnotation: () => true,
        isEditable: () => true,
        async saveTx() {
            throw new Error('database unavailable');
        },
    };
    const zotero = {
        Items: {
            get: () => ({ id: 42, libraryID: 7 }),
            getByLibraryAndKey: () => annotation,
        },
        Notifier: {
            Queue: class Queue {},
            async commit() {
                committed = true;
            },
        },
    };
    const actions = createZoteroAnnotationActions(zotero);

    await assert.rejects(
        actions.changeColor(42, 'ANN00001', '#ff6666'),
        /database unavailable/
    );
    assert.equal(annotation.annotationColor, '#ffd400');
    assert.equal(committed, true);
});
