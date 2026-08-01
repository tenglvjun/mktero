import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroAnnotationActions,
} from '../src/platform/zotero-annotation-actions.js';
import {
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
} from '../src/core/pdf-annotation.js';

const LONG_STRESS_RECOVERY_PASSAGE = 'Previous research support for the notion '
    + 'that music listening is beneficial for stress recovery is inconclusive, '
    + 'given the methodological diversity with which the effects of music on '
    + 'stress recovery have been investigated.';
const HYPHENATED_MARKDOWN_PASSAGE = 'Background Empirical support for the notion '
    + 'that music listening is beneficial for stress recovery is inconclusive, '
    + 'potentially due to the methodological diversity with which the effects '
    + 'of music on stress recovery have been investigated.';
const HYPHENATED_PDF_PASSAGE = HYPHENATED_MARKDOWN_PASSAGE.replace(
    'investigated',
    'inves- tigated'
);

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

test('opens a Zotero PDF reader at the selected annotation', async () => {
    const attachment = {
        id: 42,
        isPDFAttachment: () => true,
    };
    const opened = [];
    const zotero = {
        Items: {
            get: id => id === 42 ? attachment : null,
        },
        Reader: {
            async open(...args) {
                opened.push(args);
            },
        },
    };
    const actions = createZoteroAnnotationActions(zotero);

    await actions.openInPDF(42, 'HIGH0001');

    assert.deepEqual(opened, [[42, { annotationID: 'HIGH0001' }]]);
});

test('opens annotations from different windows through the shared reader manager', async () => {
    const attachments = new Map([
        [42, { isPDFAttachment: () => true }],
        [84, { isPDFAttachment: () => true }],
    ]);
    const opened = [];
    const zotero = {
        Items: {
            get: id => attachments.get(id) || null,
        },
        Reader: {
            async open(itemID, location) {
                opened.push({ itemID, location });
            },
        },
    };
    const actions = createZoteroAnnotationActions(zotero);

    await actions.openInPDF(42, 'WINDOW01');
    await actions.openInPDF(84, 'WINDOW02');

    assert.deepEqual(opened, [{
        itemID: 42,
        location: { annotationID: 'WINDOW01' },
    }, {
        itemID: 84,
        location: { annotationID: 'WINDOW02' },
    }]);
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
    }, null);

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

test('activates an inactive PDF reader before waiting for initialization', async () => {
    const text = 'Selected paper title';
    const view = createSearchView({
        total: 1,
        annotation: locatedAnnotation(text),
    });
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            return { key: json.key };
        },
    });
    const reader = zotero.Reader._readers[0];
    reader._iframe = { docShellIsActive: false };
    let resolveInitialization;
    reader._initPromise = new Promise(resolve => {
        resolveInitialization = resolve;
    });
    let clock = 0;
    let activatedBeforeInitialization = false;
    const actions = createZoteroAnnotationActions(zotero, {
        now: () => clock,
        async delay(milliseconds) {
            clock += milliseconds;
            if (reader._iframe.docShellIsActive) {
                activatedBeforeInitialization = true;
                resolveInitialization();
                await Promise.resolve();
            }
        },
        searchTimeout: 1_000,
    });

    const created = await actions.createFromText(42, {
        text,
        comment: '',
        color: '#ffd400',
    });

    assert.equal(created.id, 'SYNC0001');
    assert.equal(activatedBeforeInitialization, true);
    assert.equal(reader._iframe.docShellIsActive, false);
});

test('uses a ready PDF view when the internal reader promise remains pending', async () => {
    const text = 'Selected paper title';
    const view = createSearchView({
        total: 1,
        annotation: locatedAnnotation(text),
    });
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            return { key: json.key };
        },
    });
    zotero.Reader._readers[0]._internalReader.initializedPromise = (
        new Promise(() => {})
    );
    let clock = 0;
    const actions = createZoteroAnnotationActions(zotero, {
        now: () => clock,
        delay: async milliseconds => {
            clock += milliseconds;
        },
        searchTimeout: 1_000,
    });

    const created = await actions.createFromText(42, {
        text,
        comment: '',
        color: '#ffd400',
    });

    assert.equal(created.id, 'SYNC0001');
});

test('defers PDF synchronization when no PDF reader is already open', async () => {
    const view = createSearchView({
        total: 1,
        annotation: locatedAnnotation('Selected paper title'),
    });
    const reader = createReader(view);
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON() {
            assert.fail('A deferred annotation must not be saved');
        },
    });
    zotero.Reader._readers = [];
    const openCalls = [];
    zotero.Reader.open = async (...args) => {
        openCalls.push(args);
        return reader;
    };
    const actions = createZoteroAnnotationActions(zotero);

    const result = await actions.createFromText(42, {
        text: 'Selected paper title',
        comment: '',
        color: '#ffd400',
    });

    assert.deepEqual(result, { deferred: true });
    assert.deepEqual(openCalls, []);
});

test('uses a newly opened PDF reader before Zotero registers it globally', async () => {
    const text = 'Selected paper title';
    const view = createSearchView({
        total: 1,
        annotation: locatedAnnotation(text),
    });
    const openedReader = createReader(view);
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            return { key: json.key };
        },
    });
    zotero.Reader._readers = [];
    zotero.Reader.open = () => {
        assert.fail('Synchronization must not open another PDF reader');
    };
    const actions = createZoteroAnnotationActions(zotero);

    const created = await actions.createFromText(42, {
        text,
        comment: '',
        color: '#ffd400',
    }, { reader: openedReader });

    assert.equal(created.id, 'SYNC0001');
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

test('creates a highlight for a long match without waiting for every PDF page', async () => {
    const text = LONG_STRESS_RECOVERY_PASSAGE;
    const view = createSearchView({
        total: 1,
        annotation: locatedAnnotation(text),
    });
    const originalSetFindState = view.setFindState;
    view.setFindState = function setFindState(state) {
        originalSetFindState.call(this, state);
        if (state.active) {
            this._findController._pendingFindMatches.add(1);
        }
    };
    let clock = 0;
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            return { key: json.key };
        },
    });
    const actions = createZoteroAnnotationActions(zotero, {
        now: () => clock,
        delay: async () => {
            clock += 250;
        },
        searchTimeout: 1_000,
    });

    const created = await actions.createFromText(42, {
        text,
        comment: '',
        color: '#ff6666',
    });

    assert.equal(created.id, 'SYNC0001');
});

test('rejects a later-page duplicate during the long-match settle window', async () => {
    const text = LONG_STRESS_RECOVERY_PASSAGE;
    const view = createSearchView({
        total: 1,
        annotation: locatedAnnotation(text),
    });
    const originalSetFindState = view.setFindState;
    view.setFindState = function setFindState(state) {
        originalSetFindState.call(this, state);
        if (state.active) {
            this._findController._pendingFindMatches.add(1);
        }
    };
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON() {
            assert.fail('The annotation must not be saved');
        },
    });
    const actions = createZoteroAnnotationActions(zotero, {
        async delay() {
            view._findState.result = { total: 2 };
            view._findController._pendingFindMatches.clear();
        },
    });

    await assert.rejects(
        actions.createFromText(42, {
            text,
            comment: '',
            color: '#ff6666',
        }),
        error => error.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
});

test('locates Markdown text split by a PDF line-end hyphen', async () => {
    const queries = [];
    let savedJSON;
    const view = {
        _findState: { active: false, query: '', result: null },
        initializedPromise: Promise.resolve(),
        setFindState(state) {
            if (!state.active) {
                this._findState = state;
                return;
            }
            queries.push(state.query);
            markSearchComplete(this, state.query);
            this._findController._pageContents = [HYPHENATED_PDF_PASSAGE];
            this._findState = {
                ...state,
                result: state.query === HYPHENATED_PDF_PASSAGE
                    ? {
                        total: 1,
                        annotation: locatedAnnotation(
                            HYPHENATED_PDF_PASSAGE
                        ),
                    }
                    : { total: 0 },
            };
        },
    };
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            savedJSON = json;
            return { key: json.key };
        },
    });
    const actions = createZoteroAnnotationActions(zotero);

    const created = await actions.createFromText(42, {
        text: HYPHENATED_MARKDOWN_PASSAGE,
        comment: '',
        color: '#a28ae5',
    });

    assert.equal(created.id, 'SYNC0001');
    assert.deepEqual(queries, [
        HYPHENATED_MARKDOWN_PASSAGE,
        HYPHENATED_PDF_PASSAGE,
    ]);
    assert.equal(savedJSON.text, HYPHENATED_MARKDOWN_PASSAGE);
    assert.deepEqual(savedJSON.position, {
        pageIndex: 0,
        rects: [[72, 700, 280, 720]],
    });
});

test('clones find states into the Zotero reader realm', async () => {
    const queries = [];
    const readerRealm = {};
    const readerValues = new WeakSet();
    let savedJSON;
    const view = {
        _findState: { active: false, query: '', result: null },
        initializedPromise: Promise.resolve(),
        setFindState(state) {
            this._findState = state;
            if (!state.active || !readerValues.has(state)) return;
            queries.push(state.query);
            markSearchComplete(this, state.query);
            this._findController._pageContents = [HYPHENATED_PDF_PASSAGE];
            this._findState = {
                ...state,
                result: state.query === HYPHENATED_PDF_PASSAGE
                    ? {
                        total: 1,
                        annotation: locatedAnnotation(
                            HYPHENATED_PDF_PASSAGE
                        ),
                    }
                    : { total: 0 },
            };
        },
    };
    let clock = 0;
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            savedJSON = json;
            return { key: json.key };
        },
    });
    zotero.Reader._readers[0]._iframeWindow = readerRealm;
    const actions = createZoteroAnnotationActions(zotero, {
        cloneIntoReader(value, target) {
            assert.equal(target, readerRealm);
            const cloned = { ...value };
            readerValues.add(cloned);
            return cloned;
        },
        now: () => clock,
        delay: async () => {
            clock += 250;
        },
        searchTimeout: 1_000,
    });

    const created = await actions.createFromText(42, {
        text: HYPHENATED_MARKDOWN_PASSAGE,
        comment: '',
        color: '#a28ae5',
    });

    assert.equal(created.id, 'SYNC0001');
    assert.equal(savedJSON.text, HYPHENATED_MARKDOWN_PASSAGE);
    assert.deepEqual(queries, [
        HYPHENATED_MARKDOWN_PASSAGE,
        HYPHENATED_PDF_PASSAGE,
    ]);
});

test('recovers a line-end hyphen when extracted pages remain pending', async () => {
    const queries = [];
    let savedJSON;
    const view = {
        _findState: { active: false, query: '', result: null },
        initializedPromise: Promise.resolve(),
        setFindState(state) {
            if (!state.active) {
                this._findState = state;
                return;
            }
            queries.push(state.query);
            markSearchComplete(this, state.query);
            this._findController._extractTextPromises = [Promise.resolve()];
            this._findController._pageContents = [HYPHENATED_PDF_PASSAGE];
            if (state.query === HYPHENATED_MARKDOWN_PASSAGE) {
                this._findController._pendingFindMatches.add(0);
            }
            this._findState = {
                ...state,
                result: state.query === HYPHENATED_PDF_PASSAGE
                    ? {
                        total: 1,
                        annotation: locatedAnnotation(
                            HYPHENATED_PDF_PASSAGE
                        ),
                    }
                    : { total: 0 },
            };
        },
    };
    let clock = 0;
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            savedJSON = json;
            return { key: json.key };
        },
    });
    const actions = createZoteroAnnotationActions(zotero, {
        now: () => clock,
        delay: async () => {
            clock += 250;
        },
        searchTimeout: 1_000,
    });

    const created = await actions.createFromText(42, {
        text: HYPHENATED_MARKDOWN_PASSAGE,
        comment: '',
        color: '#a28ae5',
    });

    assert.equal(created.id, 'SYNC0001');
    assert.equal(savedJSON.text, HYPHENATED_MARKDOWN_PASSAGE);
    assert.deepEqual(queries, [
        HYPHENATED_MARKDOWN_PASSAGE,
        HYPHENATED_PDF_PASSAGE,
    ]);
});

test('recovers a line-end hyphen before every PDF page is extracted', async () => {
    const queries = [];
    let savedJSON;
    let pendingAnnotation = null;
    const view = {
        _findState: { active: false, query: '', result: null },
        initializedPromise: Promise.resolve(),
        setFindState(state) {
            if (!state.active) {
                this._findState = state;
                return;
            }
            queries.push(state.query);
            markSearchComplete(this, state.query);
            this._findController._extractTextPromises = Array.from(
                { length: 16 },
                () => new Promise(() => {})
            );
            this._findController._pageContents = [HYPHENATED_PDF_PASSAGE];
            this._findController._pendingFindMatches = new Set(
                Array.from({ length: 15 }, (_, index) => index + 1)
            );
            if (state.query === HYPHENATED_PDF_PASSAGE) {
                pendingAnnotation = {
                    total: 1,
                    index: 0,
                };
                this._findState = { ...state, result: pendingAnnotation };
            }
            else {
                this._findState = { ...state, result: null };
            }
        },
    };
    let clock = 0;
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            savedJSON = json;
            return { key: json.key };
        },
    });
    const actions = createZoteroAnnotationActions(zotero, {
        now: () => clock,
        delay: async () => {
            clock += 250;
            if (pendingAnnotation && !pendingAnnotation.annotation) {
                pendingAnnotation.annotation = locatedAnnotation(
                    HYPHENATED_PDF_PASSAGE
                );
            }
        },
        searchTimeout: 1_000,
    });

    const created = await actions.createFromText(42, {
        text: HYPHENATED_MARKDOWN_PASSAGE,
        comment: '',
        color: '#ff6666',
    });

    assert.equal(created.id, 'SYNC0001');
    assert.equal(savedJSON.text, HYPHENATED_MARKDOWN_PASSAGE);
    assert.deepEqual(queries, [
        HYPHENATED_MARKDOWN_PASSAGE,
        HYPHENATED_PDF_PASSAGE,
    ]);
});

test('rejects a delayed normalized duplicate with different line wrapping', async () => {
    const queries = [];
    const pages = [HYPHENATED_PDF_PASSAGE];
    const view = {
        _findState: { active: false, query: '', result: null },
        initializedPromise: Promise.resolve(),
        setFindState(state) {
            if (!state.active) {
                this._findState = state;
                return;
            }
            queries.push(state.query);
            markSearchComplete(this, state.query);
            this._findController._pageContents = pages;
            this._findController._pendingFindMatches = new Set([1]);
            this._findState = {
                ...state,
                result: state.query === HYPHENATED_PDF_PASSAGE
                    ? {
                        total: 1,
                        annotation: locatedAnnotation(
                            HYPHENATED_PDF_PASSAGE
                        ),
                    }
                    : null,
            };
        },
    };
    let clock = 0;
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON() {
            assert.fail('An ambiguous annotation must not be saved');
        },
    });
    const actions = createZoteroAnnotationActions(zotero, {
        now: () => clock,
        delay: async () => {
            clock += 250;
            pages[1] = HYPHENATED_MARKDOWN_PASSAGE;
        },
        searchTimeout: 1_000,
    });

    await assert.rejects(
        actions.createFromText(42, {
            text: HYPHENATED_MARKDOWN_PASSAGE,
            comment: '',
            color: '#ff6666',
        }),
        error => error.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
    assert.deepEqual(queries, [HYPHENATED_MARKDOWN_PASSAGE]);
});

test('does not wait forever for PDF reader initialization', async () => {
    let clock = 0;
    const view = createSearchView({ total: 0 });
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON() {
            assert.fail('The annotation must not be saved');
        },
    });
    zotero.Reader._readers[0]._initPromise = new Promise(() => {});
    const actions = createZoteroAnnotationActions(zotero, {
        now: () => clock,
        delay: async () => {
            clock += 250;
        },
        searchTimeout: 1_000,
    });

    const outcome = await Promise.race([
        actions.createFromText(42, {
            text: 'Selected paper title',
            comment: '',
            color: '#ffd400',
        }).then(
            () => 'created',
            error => error.code
        ),
        new Promise(resolve => setImmediate(() => resolve('stalled'))),
    ]);

    assert.equal(outcome, 'MKTERO_PDF_READER_UNAVAILABLE');
});

test('does not wait or open a PDF reader solely for synchronization', async () => {
    const view = createSearchView({ total: 0 });
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON() {
            assert.fail('The annotation must not be saved');
        },
    });
    zotero.Reader._readers = [];
    let openCalls = 0;
    zotero.Reader.open = () => {
        openCalls++;
        return new Promise(() => {});
    };
    let delayCalls = 0;
    const actions = createZoteroAnnotationActions(zotero, {
        delay: async () => {
            delayCalls++;
        },
        searchTimeout: 1_000,
    });

    const outcome = await Promise.race([
        actions.createFromText(42, {
            text: 'Selected paper title',
            comment: '',
            color: '#ffd400',
        }),
        new Promise(resolve => setImmediate(() => resolve('stalled'))),
    ]);

    assert.deepEqual(outcome, { deferred: true });
    assert.equal(openCalls, 0);
    assert.equal(delayCalls, 0);
});

test('prefers an exact PDF text match over line-end hyphen recovery', async () => {
    const queries = [];
    const view = createSearchView({
        total: 1,
        annotation: locatedAnnotation(HYPHENATED_MARKDOWN_PASSAGE),
    });
    const originalSetFindState = view.setFindState;
    view.setFindState = function setFindState(state) {
        if (state.active) queries.push(state.query);
        originalSetFindState.call(this, state);
        this._findController._pageContents = [HYPHENATED_PDF_PASSAGE];
    };
    const zotero = createZoteroForAnnotationCreation({
        view,
        async saveFromJSON(_attachment, json) {
            return { key: json.key };
        },
    });
    const actions = createZoteroAnnotationActions(zotero);

    await actions.createFromText(42, {
        text: HYPHENATED_MARKDOWN_PASSAGE,
        comment: '',
        color: '#a28ae5',
    });

    assert.deepEqual(queries, [HYPHENATED_MARKDOWN_PASSAGE]);
});

test('rejects ambiguous line-end hyphen matches across PDF pages', async () => {
    const queries = [];
    const view = createSearchView({ total: 0 });
    const originalSetFindState = view.setFindState;
    view.setFindState = function setFindState(state) {
        if (state.active) queries.push(state.query);
        originalSetFindState.call(this, state);
        this._findController._pageContents = [
            HYPHENATED_PDF_PASSAGE,
            HYPHENATED_PDF_PASSAGE,
        ];
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
            text: HYPHENATED_MARKDOWN_PASSAGE,
            comment: '',
            color: '#a28ae5',
        }),
        error => error.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
    );
    assert.deepEqual(queries, [HYPHENATED_MARKDOWN_PASSAGE]);
});

test('fails safely for malformed or oversized PDF page text', async () => {
    for (const pageContents of [
        [42],
        ['x'.repeat(1_000_001)],
    ]) {
        const queries = [];
        const view = createSearchView({ total: 0 });
        const originalSetFindState = view.setFindState;
        view.setFindState = function setFindState(state) {
            if (state.active) queries.push(state.query);
            originalSetFindState.call(this, state);
            this._findController._pageContents = pageContents;
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
                text: HYPHENATED_MARKDOWN_PASSAGE,
                comment: '',
                color: '#a28ae5',
            }),
            error => error.code === 'MKTERO_PDF_TEXT_NOT_FOUND'
        );
        assert.deepEqual(queries, [HYPHENATED_MARKDOWN_PASSAGE]);
    }
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
    assert.equal(created.reused, true);
    assert.equal(saveCalls, 0);
});

test('updates an existing highlight at the same PDF position', async () => {
    const position = {
        pageIndex: 0,
        rects: [[72, 700, 280, 720]],
    };
    let itemSaveCalls = 0;
    const existing = {
        key: 'EXIST001',
        annotationType: 'highlight',
        annotationText: 'The sound of stress recovery',
        annotationComment: 'Old note',
        annotationColor: '#ffd400',
        annotationPageLabel: '1',
        annotationSortIndex: '00000|000001|00000',
        annotationPosition: JSON.stringify(position),
        isEditable: () => true,
        async saveTx() {
            itemSaveCalls++;
        },
    };
    let createCalls = 0;
    const zotero = createZoteroForAnnotationCreation({
        view: {},
        async saveFromJSON() {
            createCalls++;
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

    const synchronized = await actions.createFromText(42, {
        text: existing.annotationText,
        comment: 'Revised note',
        color: '#ff6666',
    });

    assert.equal(synchronized.id, 'EXIST001');
    assert.equal(synchronized.reused, true);
    assert.equal(existing.annotationComment, 'Revised note');
    assert.equal(existing.annotationColor, '#ff6666');
    assert.equal(itemSaveCalls, 1);
    assert.equal(createCalls, 0);
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
