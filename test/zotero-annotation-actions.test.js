import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroAnnotationActions,
} from '../src/platform/zotero-annotation-actions.js';
import {
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
} from '../src/core/pdf-annotation.js';

test('creates a Zotero PDF highlight from located Markdown text', async () => {
    const selectedText = 'The sound of stress recovery: an exploratory study '
        + 'of self-selected music listening after stress';
    const queue = {};
    const attachment = {
        id: 42,
        libraryID: 7,
        isPDFAttachment: () => true,
    };
    let savedJSON;
    let committedQueue;
    const zotero = {
        Items: {
            get: id => id === 42 ? attachment : null,
        },
        DataObjectUtilities: {
            generateKey: () => 'SYNC0001',
        },
        Annotations: {
            async saveFromJSON(parent, json, options) {
                assert.equal(parent, attachment);
                assert.equal(options.notifierQueue, queue);
                savedJSON = json;
                return {
                    key: json.key,
                    annotationType: json.type,
                    annotationText: json.text,
                    annotationComment: json.comment,
                    annotationColor: json.color,
                    annotationPageLabel: json.pageLabel,
                    annotationSortIndex: json.sortIndex,
                    annotationPosition: JSON.stringify(json.position),
                };
            },
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
    const actions = createZoteroAnnotationActions(zotero, {
        async locateText(itemID, text) {
            assert.equal(itemID, 42);
            assert.equal(text, selectedText);
            return {
                text,
                pageLabel: '1',
                sortIndex: '00000|000001|00000',
                position: {
                    pageIndex: 0,
                    rects: [[72, 700, 420, 720]],
                },
            };
        },
    });

    const created = await actions.createFromText(42, {
        text: selectedText,
        comment: 'Paper title',
        color: '#ffd400',
        ranges: [{ from: 0, to: selectedText.length }],
    });

    assert.deepEqual(savedJSON, {
        key: 'SYNC0001',
        type: 'highlight',
        text: selectedText,
        comment: 'Paper title',
        color: '#ffd400',
        pageLabel: '1',
        sortIndex: '00000|000001|00000',
        position: {
            pageIndex: 0,
            rects: [[72, 700, 420, 720]],
        },
    });
    assert.equal(created.id, 'SYNC0001');
    assert.equal(created.source, 'zotero');
    assert.equal(created.pageIndex, 0);
    assert.equal(committedQueue, queue);
});

test('locates Markdown text through an open Zotero PDF reader', async () => {
    const previousFindState = {
        active: false,
        query: '',
        result: null,
    };
    const restoredStates = [];
    let readerActiveDuringSearch = false;
    let zotero;
    const view = {
        _findState: previousFindState,
        initializedPromise: Promise.resolve(),
        setFindState(state) {
            if (!state.active) {
                restoredStates.push(state);
                this._findState = state;
                return;
            }
            readerActiveDuringSearch = zotero.Reader._readers[0]
                ._iframe.docShellIsActive;
            markSearchComplete(this, state.query);
            this._findState = {
                ...state,
                result: {
                    total: 1,
                    index: 0,
                    annotation: {
                        text: 'The sound of stress recovery',
                        pageLabel: '1',
                        sortIndex: '00000|000001|00000',
                        position: {
                            pageIndex: 0,
                            rects: [[72, 700, 280, 720]],
                        },
                    },
                },
            };
        },
    };
    let savedJSON;
    zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            savedJSON = json;
            return { key: json.key };
        },
    });
    zotero.Reader._readers[0]._iframe = { docShellIsActive: false };
    const actions = createZoteroAnnotationActions(zotero);

    const created = await actions.createFromText(42, {
        text: 'The sound of stress recovery',
        comment: '',
        color: '#ffd400',
    });

    assert.equal(created.id, 'SYNC0001');
    assert.deepEqual(savedJSON.position, {
        pageIndex: 0,
        rects: [[72, 700, 280, 720]],
    });
    assert.deepEqual(restoredStates, [previousFindState]);
    assert.equal(readerActiveDuringSearch, true);
    assert.equal(
        zotero.Reader._readers[0]._iframe.docShellIsActive,
        false
    );
});

test('opens a background PDF reader when none is already open', async () => {
    const view = createSearchView({
        total: 1,
        annotation: locatedAnnotation('Selected paper title'),
    });
    const reader = createReader(view);
    let closeCalls = 0;
    reader.close = () => closeCalls++;
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            return { key: json.key };
        },
    });
    zotero.Reader._readers = [];
    const openCalls = [];
    zotero.Reader.open = async (...args) => {
        openCalls.push(args);
        return reader;
    };
    const actions = createZoteroAnnotationActions(zotero);

    const created = await actions.createFromText(42, {
        text: 'Selected paper title',
        comment: '',
        color: '#ffd400',
    });

    assert.equal(created.id, 'SYNC0001');
    assert.deepEqual(openCalls, [[
        42,
        null,
        { openInBackground: true },
    ]]);
    assert.equal(closeCalls, 1);
});

test('reports when Markdown text cannot be found uniquely in the PDF', async () => {
    for (const [total, code] of [
        [0, 'MKTERO_PDF_TEXT_NOT_FOUND'],
        [2, 'MKTERO_PDF_TEXT_AMBIGUOUS'],
    ]) {
        const view = createSearchView({ total });
        const zotero = createZoteroForAnnotationCreation({
            view,
            async saveFromJSON() {
                assert.fail('The annotation must not be saved');
            },
        });
        const actions = createZoteroAnnotationActions(zotero);

        await assert.rejects(
            actions.createFromText(42, {
                text: 'Selected paper title',
                comment: '',
                color: '#ffd400',
            }),
            error => error.code === code
        );
    }
});

test('waits for every PDF page before accepting a unique text match', async () => {
    const text = 'Selected paper title';
    const firstResult = {
        total: 1,
        annotation: locatedAnnotation(text),
    };
    const view = createSearchView(firstResult);
    const originalSetFindState = view.setFindState;
    view.setFindState = function setFindState(state) {
        originalSetFindState.call(this, state);
        if (state.active) {
            this._findController._pendingFindMatches.add(1);
        }
    };
    let delayCalls = 0;
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON() {
            assert.fail('The annotation must not be saved');
        },
    });
    const actions = createZoteroAnnotationActions(zotero, {
        async delay() {
            delayCalls++;
            view._findState.result = { total: 2 };
            view._findController._pendingFindMatches.clear();
        },
    });

    await assert.rejects(
        actions.createFromText(42, {
            text,
            comment: '',
            color: '#ffd400',
        }),
        error => error.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
    assert.equal(delayCalls, 1);
});

test('times out when Zotero does not finish locating the PDF text', async () => {
    let clock = 0;
    const view = createSearchView(null);
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON() {
            assert.fail('The annotation must not be saved');
        },
    });
    const actions = createZoteroAnnotationActions(zotero, {
        now: () => clock,
        delay: async () => {
            clock += 250;
        },
        searchTimeout: 1_000,
    });

    await assert.rejects(
        actions.createFromText(42, {
            text: 'Selected paper title',
            comment: '',
            color: '#ffd400',
        }),
        error => error.code === 'MKTERO_PDF_TEXT_SEARCH_TIMEOUT'
    );
});

test('preserves a PDF search error when restoring find state also fails', async () => {
    const previousFindState = { active: false, query: '', result: null };
    const view = {
        _findState: previousFindState,
        initializedPromise: Promise.resolve(),
        setFindState(state) {
            if (!state.active) throw new Error('restore failed');
            markSearchComplete(this, state.query);
            this._findState = { ...state, result: { total: 0 } };
        },
    };
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON() {
            assert.fail('The annotation must not be saved');
        },
    });
    const actions = createZoteroAnnotationActions(zotero);

    await assert.rejects(
        actions.createFromText(42, {
            text: 'Selected paper title',
            comment: '',
            color: '#ffd400',
        }),
        error => error.code === 'MKTERO_PDF_TEXT_NOT_FOUND'
    );
});

test('reuses an identical Zotero highlight after a synchronization retry', async () => {
    const position = {
        pageIndex: 0,
        rects: [[72, 700, 280, 720]],
    };
    const existing = {
        key: 'EXIST001',
        annotationType: 'highlight',
        annotationText: 'The sound of stress recovery',
        annotationComment: 'Paper title',
        annotationColor: '#ffd400',
        annotationPageLabel: '1',
        annotationSortIndex: '00000|000001|00000',
        annotationPosition: JSON.stringify(position),
    };
    let saveCalls = 0;
    const zotero = createZoteroForAnnotationCreation({
        view: {},
        async saveFromJSON() {
            saveCalls++;
        },
    });
    zotero.Items.get(42).getAnnotations = () => [existing];
    zotero.Items.loadDataTypes = async () => {};
    const actions = createZoteroAnnotationActions(zotero, {
        async locateText() {
            return {
                text: existing.annotationText,
                pageLabel: existing.annotationPageLabel,
                sortIndex: existing.annotationSortIndex,
                position,
            };
        },
    });

    const created = await actions.createFromText(42, {
        text: existing.annotationText,
        comment: existing.annotationComment,
        color: existing.annotationColor,
    });

    assert.equal(created.id, 'EXIST001');
    assert.equal(saveCalls, 0);
});

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

test('updates the comment of an annotation owned by the current PDF', async () => {
    const queue = {};
    let saveOptions;
    let committedQueue;
    const annotation = {
        id: 73,
        parentID: 42,
        annotationComment: 'Old note',
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

    await actions.updateComment(42, 'ANN00001', 'Revised note');

    assert.equal(annotation.annotationComment, 'Revised note');
    assert.equal(saveOptions.skipDateModifiedUpdate, true);
    assert.equal(saveOptions.notifierQueue, queue);
    assert.equal(committedQueue, queue);
});

test('rejects an oversized annotation comment before saving it', async () => {
    let saveCalls = 0;
    const annotation = {
        parentID: 42,
        annotationComment: 'Old note',
        isAnnotation: () => true,
        isEditable: () => true,
        async saveTx() {
            saveCalls++;
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
        actions.updateComment(
            42,
            'ANN00001',
            'x'.repeat(MAX_PDF_ANNOTATION_TEXT_LENGTH + 1)
        ),
        /safety limit/
    );
    assert.equal(annotation.annotationComment, 'Old note');
    assert.equal(saveCalls, 0);
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
    await assert.rejects(
        actions.updateComment(42, 'ANN00001', 'Review this'),
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

test('restores the previous comment when Zotero cannot save the annotation', async () => {
    let committed = false;
    const annotation = {
        parentID: 42,
        annotationComment: 'Old note',
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
        actions.updateComment(42, 'ANN00001', 'Revised note'),
        /database unavailable/
    );
    assert.equal(annotation.annotationComment, 'Old note');
    assert.equal(committed, true);
});

function createZoteroForAnnotationCreation({ view, saveFromJSON }) {
    const attachment = {
        id: 42,
        libraryID: 7,
        isPDFAttachment: () => true,
    };
    return {
        Items: {
            get: id => id === 42 ? attachment : null,
        },
        DataObjectUtilities: {
            generateKey: () => 'SYNC0001',
        },
        Annotations: { saveFromJSON },
        Notifier: {
            Queue: class Queue {},
            async commit() {},
        },
        Reader: {
            _readers: [{
                itemID: 42,
                _initPromise: Promise.resolve(),
                _internalReader: {
                    initializedPromise: Promise.resolve(),
                    _primaryView: view,
                },
            }],
        },
    };
}

function createReader(view) {
    return {
        itemID: 42,
        _initPromise: Promise.resolve(),
        _internalReader: {
            initializedPromise: Promise.resolve(),
            _primaryView: view,
        },
    };
}

function createSearchView(result) {
    return {
        _findState: { active: false, query: '', result: null },
        initializedPromise: Promise.resolve(),
        setFindState(state) {
            if (state.active) markSearchComplete(this, state.query);
            this._findState = state.active ? { ...state, result } : state;
        },
    };
}

function markSearchComplete(view, query) {
    view._findController = {
        state: { query },
        _dirtyMatch: false,
        _findTimeout: null,
        _pendingFindMatches: new Set(),
    };
}

function locatedAnnotation(text) {
    return {
        text,
        pageLabel: '1',
        sortIndex: '00000|000001|00000',
        position: {
            pageIndex: 0,
            rects: [[72, 700, 280, 720]],
        },
    };
}
