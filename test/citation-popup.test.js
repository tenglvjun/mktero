import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { OpenAlexClient } from '../src/citations/openalex-client.js';
import {
    createReferenceImportService,
} from '../src/core/reference-import-service.js';
import { createCitationPopup } from '../src/editor/citation-popup.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

function createHarness() {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="anchor">cite</button></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const anchor = document.querySelector('#anchor');
    anchor.getBoundingClientRect = () => ({
        left: 20,
        right: 60,
        top: 20,
        bottom: 40,
        width: 40,
        height: 20,
    });
    return { dom, document, parent, anchor };
}

function reference() {
    return {
        id: 'number:1',
        number: 1,
        text: 'Doe. Paper. doi:10.1000/test. 2024.',
        identifiers: { doi: '10.1000/test' },
    };
}

function nextTask() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function createTimerHarness() {
    let nextID = 1;
    const callbacks = new Map();
    return {
        setTimer(callback) {
            const id = nextID++;
            callbacks.set(id, callback);
            return id;
        },
        clearTimer(id) {
            callbacks.delete(id);
        },
        runAll() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            for (const callback of pending) callback();
        },
    };
}

function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), { status, headers });
}

test('renders XHTML controls and closes after opening a Zotero match', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const opened = [];
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'present',
            match: { itemID: 7, libraryID: 1, hasPDF: true },
        }),
        onOpenReferenceMatch: async match => opened.push(match.itemID),
    });
    await nextTask();

    const row = document.querySelector('.mktero-citation-popup-item');
    const select = document.querySelector('.mktero-citation-popup-library-select');
    const action = document.querySelector('.mktero-citation-popup-action');
    assert.equal(row.namespaceURI, XHTML_NAMESPACE);
    assert.equal(row.matches('button'), false);
    assert.equal(row.hasAttribute('tabindex'), false);
    assert.equal(select.namespaceURI, XHTML_NAMESPACE);
    assert.equal(action.textContent, 'Open in Zotero');

    action.click();
    await nextTask();
    assert.deepEqual(opened, [7]);
    assert.equal(document.querySelector('.mktero-citation-popup'), null);

    popup.destroy();
    dom.window.close();
});

test('shows affiliation details without reference import controls', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        label: 'Author affiliations',
        targets: [{
            id: 'affiliation:2',
            label: '2',
            number: 2,
            text: 'Purdue University Correspondence: sanketbadhe@google.com',
            affiliation: true,
        }],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'My Library',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'absent',
            canImport: true,
        }),
        onImportReference: async () => ({ state: 'imported' }),
    });
    await nextTask();

    const popupElement = document.querySelector('.mktero-citation-popup');
    assert.equal(popupElement?.getAttribute('aria-label'), 'Author affiliations');
    assert.match(
        popupElement?.textContent || '',
        /Purdue University Correspondence/
    );
    assert.equal(document.querySelector('.mktero-citation-popup-header'), null);
    assert.equal(
        document.querySelector('.mktero-citation-popup-library-select'),
        null
    );
    assert.equal(
        document.querySelector('.mktero-citation-popup-actions')?.hidden,
        true
    );
    assert.doesNotMatch(popupElement?.textContent || '', /Import reference/);

    popup.destroy();
    dom.window.close();
});

test('offers a per-row import action without batch selection controls', async () => {
    const { dom, document, parent, anchor } = createHarness();
    let activated = 0;
    let imported = 0;
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onActivate: () => { activated++; },
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'absent',
            canImport: true,
        }),
        onImportReference: async () => {
            imported++;
            return { state: 'imported' };
        },
    });
    await nextTask();

    const row = document.querySelector('.mktero-citation-popup-item');
    const action = document.querySelector('.mktero-citation-popup-action');
    const libraryPicker = document.querySelector(
        '.mktero-citation-popup-library-picker'
    );
    assert.equal(row.querySelectorAll('button:not([hidden])').length, 2);
    assert.equal(row.querySelector('button')?.parentElement, row);
    assert.equal(action.hidden, false);
    assert.equal(action.textContent, 'Import reference');
    assert.deepEqual(
        [...document.querySelector('.mktero-citation-popup-header').children],
        [libraryPicker]
    );
    assert.equal(
        document.querySelector('.mktero-citation-popup-select-all'),
        null
    );
    assert.equal(
        document.querySelector('.mktero-citation-popup-batch-import'),
        null
    );
    assert.equal(
        document.querySelector('.mktero-citation-popup-reference-checkbox'),
        null
    );
    action.click();
    await nextTask();
    assert.equal(imported, 1);
    assert.equal(activated, 0);

    popup.destroy();
    dom.window.close();
});

test('lets the user review uncertain metadata before importing', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const target = {
        id: 'number:title-only',
        number: 1,
        text: 'Doe. A title-only paper. 2024.',
        year: 2024,
        authorSearchText: 'doe',
        identifiers: {},
    };
    let imported = 0;
    const searched = [];
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [target],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async reference => reference.identifiers?.doi
            ? { state: 'absent', canImport: true }
            : { state: 'unknown', canImport: false },
        onSearchReferenceMetadata: async reference => {
            searched.push(reference);
            return {
                candidates: [{
                    source: 'openalex',
                    paperID: 'W42',
                    title: 'A title-only paper',
                    year: 2024,
                    identifiers: {
                        doi: '10.1000/confirmed',
                        openAlexID: 'W42',
                        pdfURL: 'https://repository.example/paper.pdf',
                    },
                    metadata: {
                        itemType: 'book',
                        title: 'A title-only paper',
                        year: 2024,
                        authors: ['Jane Doe'],
                    },
                }],
            };
        },
        onImportReference: async () => {
            imported++;
            return { state: 'imported' };
        },
    });
    await nextTask();
    await nextTask();

    const action = document.querySelector('.mktero-citation-popup-action');
    assert.equal(action.hidden, false);
    assert.equal(action.textContent, 'Import reference');
    action.click();
    await nextTask();
    assert.equal(searched.length, 1);
    assert.equal(imported, 0);
    assert.equal(action.textContent, 'Review matches');
    const candidate = document.querySelector(
        '.mktero-citation-popup-candidate'
    );
    assert.equal(candidate.hidden, false);
    assert.match(candidate.textContent, /A title-only paper/);

    candidate.click();
    await nextTask();
    await nextTask();
    assert.equal(target.identifiers.doi, '10.1000/confirmed');
    assert.equal(target.identifiers.openAlexID, 'W42');
    assert.equal(target.metadata.itemType, 'book');
    assert.equal(imported, 1);
    assert.equal(
        document.querySelector('.mktero-citation-popup-status').dataset.state,
        'imported'
    );
    assert.equal(
        document.querySelector('.mktero-citation-popup-reference-checkbox'),
        null
    );
    assert.equal(document.querySelector('.mktero-citation-popup-candidates').hidden,
        true);

    popup.destroy();
    dom.window.close();
});

test('imports a unique exact metadata match from one row action', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const target = {
        id: 'number:exact-title',
        number: 1,
        text: 'Doe. An exact paper. 2024.',
        year: 2024,
        authorSearchText: 'doe',
        identifiers: {},
    };
    const exactCandidate = {
        source: 'openalex',
        paperID: 'W42',
        title: 'An exact paper',
        year: 2024,
        matchConfidence: 'exact',
        identifiers: {
            doi: '10.1000/exact',
            openAlexID: 'W42',
        },
    };
    let searches = 0;
    const imported = [];
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [target],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async reference => reference.identifiers?.doi
            ? { state: 'absent', canImport: true }
            : { state: 'unknown', canImport: false },
        onSearchReferenceMetadata: async () => {
            searches++;
            return {
                candidates: [exactCandidate],
                automaticCandidate: exactCandidate,
            };
        },
        onImportReference: async reference => {
            imported.push(reference.identifiers.doi);
            return { state: 'imported' };
        },
    });
    await nextTask();
    await nextTask();

    const action = document.querySelector('.mktero-citation-popup-action');
    assert.equal(action.textContent, 'Import reference');
    action.click();
    await nextTask();
    await nextTask();

    assert.equal(searches, 1);
    assert.deepEqual(imported, ['10.1000/exact']);
    assert.equal(target.identifiers.openAlexID, 'W42');
    assert.equal(
        document.querySelector('.mktero-citation-popup-status').dataset.state,
        'imported'
    );
    assert.equal(document.querySelector('.mktero-citation-popup-candidates').hidden,
        true);

    popup.destroy();
    dom.window.close();
});

test('imports the wrist-wearable citation with one click despite year drift', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const target = {
        id: 'number:11',
        number: 11,
        text: 'Shilaih, M.; Goodale, B.M.; Falco, L.; Kübler, F.; '
            + 'De Clerck, V.; Leeners, B. Modern fertility awareness methods: '
            + 'Wrist wearables capture the changes of temperature associated '
            + 'with the menstrual cycle. Biosci. Rep. 2018, 38, '
            + 'BSR20171279. [CrossRef]',
        year: 2018,
        authorSearchText: 'shilaih m goodale b m falco l kubler f de clerck v '
            + 'leeners b',
        identifiers: {},
    };
    const metadataClient = new OpenAlexClient({
        fetch: async url => {
            const parsed = new URL(url);
            if (parsed.searchParams.has('filter')) {
                return jsonResponse({ results: [] });
            }
            return jsonResponse({ results: [{
                id: 'https://openalex.org/W2768584306',
                title: 'Modern fertility awareness methods: wrist wearables '
                    + 'capture the changes in temperature associated with '
                    + 'the menstrual cycle',
                publication_year: 2017,
                doi: 'https://doi.org/10.1042/BSR20171279',
                ids: { openalex: 'https://openalex.org/W2768584306' },
                authorships: [{
                    author: { display_name: 'Mohaned Shilaih' },
                }],
            }] });
        },
    });
    const library = {
        async find() {
            return {
                selectedMatches: [],
                otherMatches: [],
                candidates: [],
                ambiguous: false,
            };
        },
        async listLibraries() {
            return [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }];
        },
        async getDefaultLibraryID() {
            return 1;
        },
    };
    const service = createReferenceImportService({ library, metadataClient });
    let searches = 0;
    const imported = [];
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [target],
        onListReferenceLibraries: options => service.listTargetLibraries(
            null,
            options
        ),
        onGetReferenceStatus: (reference, options) => service.getStatus(
            reference,
            options
        ),
        onSearchReferenceMetadata: (reference, options) => {
            searches++;
            return service.searchReferenceMetadata(reference, options);
        },
        onImportReference: async reference => {
            imported.push(reference.identifiers.doi);
            return { state: 'imported' };
        },
    });
    await nextTask();
    await nextTask();

    document.querySelector('.mktero-citation-popup-action').click();
    await nextTask();
    await nextTask();
    await nextTask();

    assert.equal(searches, 1);
    assert.deepEqual(imported, ['10.1042/bsr20171279']);
    assert.equal(target.identifiers.doi, '10.1042/bsr20171279');
    assert.equal(
        document.querySelector('.mktero-citation-popup-status').dataset.state,
        'imported'
    );

    service.dispose();
    popup.destroy();
    dom.window.close();
});

test('does not overwrite refreshed Zotero status after metadata import', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const target = {
        id: 'number:refresh-during-import',
        number: 1,
        text: 'Doe. An exact paper. 2024.',
        year: 2024,
        authorSearchText: 'doe',
        identifiers: {},
    };
    const exactCandidate = {
        source: 'openalex',
        paperID: 'W42',
        title: 'An exact paper',
        year: 2024,
        matchConfidence: 'exact',
        identifiers: { doi: '10.1000/exact' },
    };
    let notifyUpdates;
    let finishImport;
    const importFinished = new Promise(resolve => { finishImport = resolve; });
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [target],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async reference => reference.identifiers?.doi
            ? { state: 'present', match: { itemID: 42, libraryID: 1 } }
            : { state: 'unknown', canImport: false },
        onSearchReferenceMetadata: async () => ({
            candidates: [exactCandidate],
            automaticCandidate: exactCandidate,
        }),
        onImportReference: async () => {
            notifyUpdates();
            await importFinished;
            return { state: 'failed', canImport: true };
        },
        onSubscribeReferenceUpdates: listener => {
            notifyUpdates = listener;
            return () => {};
        },
    });
    await nextTask();
    await nextTask();

    document.querySelector('.mktero-citation-popup-action').click();
    await nextTask();
    await nextTask();
    finishImport();
    await nextTask();

    const status = document.querySelector('.mktero-citation-popup-status');
    assert.equal(status.dataset.state, 'present');
    assert.equal(status.textContent, 'Already in Zotero');

    popup.destroy();
    dom.window.close();
});

test('keeps rendered reference rows stable during a background refresh', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const targets = [1, 2].map(number => ({
        id: `number:${number}`,
        number,
        text: `Reference ${number}`,
        identifiers: { doi: `10.1000/${number}` },
    }));
    const pendingStatuses = [];
    const timers = createTimerHarness();
    let refreshInBackground = false;
    let notifyUpdates;
    const popup = createCitationPopup(parent, timers);
    popup.open({
        anchor,
        targets,
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async target => {
            if (!refreshInBackground) {
                return { state: 'absent', canImport: true };
            }
            return new Promise(resolve => pendingStatuses.push({
                target,
                resolve,
            }));
        },
        onImportReference: async () => ({ state: 'imported' }),
        onSubscribeReferenceUpdates: listener => {
            notifyUpdates = listener;
            return () => {};
        },
    });
    await nextTask();
    await nextTask();

    const statuses = [...document.querySelectorAll(
        '.mktero-citation-popup-status'
    )];
    const actions = [...document.querySelectorAll(
        '.mktero-citation-popup-action'
    )];
    assert.deepEqual(statuses.map(status => status.dataset.state), [
        'absent',
        'absent',
    ]);
    assert.deepEqual(actions.map(action => action.hidden), [false, false]);

    refreshInBackground = true;
    notifyUpdates({ type: 'invalidated' });
    timers.runAll();
    await nextTask();

    assert.equal(pendingStatuses.length, 2);
    assert.deepEqual(statuses.map(status => status.dataset.state), [
        'absent',
        'absent',
    ]);
    assert.deepEqual(actions.map(action => action.hidden), [false, false]);

    for (const pending of pendingStatuses) {
        pending.resolve({
            state: pending.target.number === 1 ? 'present' : 'absent',
            match: pending.target.number === 1
                ? { itemID: 7, libraryID: 1, hasPDF: true }
                : null,
            canImport: true,
        });
    }
    await nextTask();
    assert.deepEqual(statuses.map(status => status.dataset.state), [
        'present',
        'absent',
    ]);

    popup.destroy();
    dom.window.close();
});

test('keeps actions usable while an older background refresh is pending', async () => {
    const { dom, document, parent, anchor } = createHarness();
    let notifyUpdates;
    let refreshInBackground = false;
    let resolveBackgroundStatus;
    let imports = 0;
    const timers = createTimerHarness();
    const popup = createCitationPopup(parent, timers);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => {
            if (!refreshInBackground) {
                return { state: 'absent', canImport: true };
            }
            return new Promise(resolve => {
                resolveBackgroundStatus = resolve;
            });
        },
        onImportReference: async () => {
            imports++;
            return {
                state: 'imported',
                match: { itemID: 7, libraryID: 1, hasPDF: true },
            };
        },
        onOpenReferenceMatch: async () => {},
        onSubscribeReferenceUpdates: listener => {
            notifyUpdates = listener;
            return () => {};
        },
    });
    await nextTask();
    await nextTask();

    refreshInBackground = true;
    notifyUpdates({ type: 'invalidated' });
    timers.runAll();
    await nextTask();
    document.querySelector('.mktero-citation-popup-action').click();
    await nextTask();

    const status = document.querySelector('.mktero-citation-popup-status');
    assert.equal(imports, 1);
    assert.equal(status.dataset.state, 'imported');

    resolveBackgroundStatus({ state: 'absent', canImport: true });
    await nextTask();
    assert.equal(status.dataset.state, 'imported');

    popup.destroy();
    dom.window.close();
});

test('applies a reference update without refreshing unrelated rows', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const targets = [1, 2].map(number => ({
        id: `number:${number}`,
        number,
        text: `Reference ${number}`,
        identifiers: { doi: `10.1000/${number}` },
    }));
    const statusChecks = [];
    const timers = createTimerHarness();
    let notifyUpdates;
    const popup = createCitationPopup(parent, timers);
    popup.open({
        anchor,
        targets,
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async target => {
            statusChecks.push(target.id);
            return { state: 'absent', canImport: true };
        },
        onImportReference: async () => ({ state: 'imported' }),
        onOpenReferenceMatch: async () => {},
        onSubscribeReferenceUpdates: listener => {
            notifyUpdates = listener;
            return () => {};
        },
    });
    await nextTask();
    await nextTask();
    statusChecks.length = 0;

    notifyUpdates({
        type: 'updated',
        reference: targets[0],
        result: {
            state: 'imported',
            targetLibraryID: 1,
            match: { itemID: 7, libraryID: 1, hasPDF: true },
        },
    });
    await nextTask();

    const statuses = [...document.querySelectorAll(
        '.mktero-citation-popup-status'
    )];
    const actions = [...document.querySelectorAll(
        '.mktero-citation-popup-action'
    )];
    assert.deepEqual(statusChecks, []);
    assert.deepEqual(statuses.map(status => status.dataset.state), [
        'imported',
        'absent',
    ]);
    assert.deepEqual(actions.map(action => action.textContent), [
        'Open in Zotero',
        'Import reference',
    ]);

    popup.destroy();
    dom.window.close();
});

test('coalesces consecutive Zotero invalidations into one background refresh', async () => {
    const { dom, parent, anchor } = createHarness();
    const targets = [1, 2].map(number => ({
        id: `number:${number}`,
        number,
        text: `Reference ${number}`,
        identifiers: { doi: `10.1000/${number}` },
    }));
    const statusChecks = [];
    const timers = createTimerHarness();
    let notifyUpdates;
    const popup = createCitationPopup(parent, timers);
    popup.open({
        anchor,
        targets,
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async target => {
            statusChecks.push(target.id);
            return { state: 'absent', canImport: true };
        },
        onImportReference: async () => ({ state: 'imported' }),
        onSubscribeReferenceUpdates: listener => {
            notifyUpdates = listener;
            return () => {};
        },
    });
    await nextTask();
    await nextTask();
    statusChecks.length = 0;

    notifyUpdates({ type: 'invalidated' });
    notifyUpdates({ type: 'invalidated' });
    notifyUpdates({ type: 'invalidated' });
    assert.deepEqual(statusChecks, []);

    timers.runAll();
    await nextTask();
    assert.deepEqual(statusChecks, ['number:1', 'number:2']);

    popup.destroy();
    dom.window.close();
});

test('renders metadata candidates as bounded inert text', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [{
            id: 'title-only',
            text: 'A title-only reference',
            identifiers: {},
        }],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'unknown',
            canImport: false,
        }),
        onSearchReferenceMetadata: async () => ({
            candidates: Array.from({ length: 25 }, (_, index) => ({
                source: 'openalex',
                paperID: `W${index + 1}`,
                title: index === 0
                    ? '<img src=x onerror=alert(1)>'
                    : `Candidate ${index}`,
                year: 2024,
                identifiers: { doi: `10.1000/candidate-${index}` },
            })),
        }),
    });
    await nextTask();
    await nextTask();
    document.querySelector('.mktero-citation-popup-action').click();
    await nextTask();
    const panel = document.querySelector('.mktero-citation-popup-candidates');
    assert.equal(panel.querySelectorAll('button').length, 20);
    assert.equal(panel.querySelector('img'), null);
    assert.match(panel.textContent, /<img src=x onerror=alert\(1\)>/);

    popup.destroy();
    dom.window.close();
});

test('imports one reference without affecting an adjacent row', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const imported = [];
    const popup = createCitationPopup(parent);
    const targets = [
        { ...reference(), id: 'number:1', number: 1, text: 'First paper' },
        { ...reference(), id: 'number:2', number: 2, text: 'Second paper' },
    ];
    popup.open({
        anchor,
        targets,
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'absent',
            canImport: true,
        }),
        onImportReference: async target => {
            imported.push(target.text);
            return { state: 'imported' };
        },
    });
    await nextTask();
    await nextTask();

    const actions = [...document.querySelectorAll(
        '.mktero-citation-popup-action'
    )];
    assert.equal(actions.length, 2);
    assert.ok(actions.every(action => action.textContent === 'Import reference'));
    assert.equal(
        document.querySelectorAll('.mktero-citation-popup-reference-checkbox')
            .length,
        0
    );

    actions[1].click();
    await nextTask();
    assert.deepEqual(imported, ['Second paper']);
    assert.deepEqual(
        [...document.querySelectorAll('.mktero-citation-popup-status')]
            .map(status => status.dataset.state),
        ['absent', 'imported']
    );

    popup.destroy();
    dom.window.close();
});

test('keeps a failed row import available for retry', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'absent',
            canImport: true,
        }),
        onImportReference: async () => {
            throw Object.assign(new Error('network down'), {
                code: 'REFERENCE_NETWORK_FAILED',
            });
        },
    });
    await nextTask();
    await nextTask();

    const action = document.querySelector('.mktero-citation-popup-action');
    assert.equal(action.textContent, 'Import reference');
    action.click();
    await nextTask();
    assert.equal(action.hidden, false);
    assert.equal(action.disabled, false);
    assert.equal(
        document.querySelector('.mktero-citation-popup-status').dataset.state,
        'failed'
    );

    popup.destroy();
    dom.window.close();
});

test('reports the matching group-library name and offers explicit copy', async () => {
    const { dom, document, parent, anchor } = createHarness();
    let copied = 0;
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'present-other-library',
            canImport: true,
            otherMatches: [{ libraryID: 8, libraryName: 'Research Group' }],
        }),
        onImportReference: async () => {
            copied++;
            return { state: 'present-no-pdf' };
        },
    });
    await nextTask();

    assert.match(
        document.querySelector('.mktero-citation-popup-status').textContent,
        /Research Group/
    );
    assert.equal(document.querySelector('.mktero-citation-popup-action').textContent,
        'Copy to selected library');
    document.querySelector('.mktero-citation-popup-action').click();
    await nextTask();
    assert.equal(copied, 1);

    popup.destroy();
    dom.window.close();
});

test('keeps the row action label after a copy failure', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 1,
                name: 'Personal',
                type: 'user',
                editable: true,
                filesEditable: true,
            }],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async () => ({
            state: 'present-other-library',
            canImport: true,
            otherMatches: [{ libraryName: 'Research Group' }],
        }),
        onImportReference: async () => {
            throw Object.assign(new Error('network down'), {
                code: 'REFERENCE_NETWORK_FAILED',
            });
        },
    });
    await nextTask();
    const action = document.querySelector('.mktero-citation-popup-action');
    assert.equal(action.textContent, 'Copy to selected library');
    action.click();
    await nextTask();
    assert.equal(action.textContent, 'Copy to selected library');
    assert.equal(action.disabled, false);

    popup.destroy();
    dom.window.close();
});

test('keeps read-only libraries visible and disables their import action', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        targetLibraryID: 2,
        onListReferenceLibraries: async () => ({
            libraries: [{
                libraryID: 2,
                name: 'Shared',
                type: 'group',
                editable: false,
                filesEditable: false,
            }],
            defaultLibraryID: 2,
        }),
        onGetReferenceStatus: async () => ({
            state: 'absent',
            canImport: false,
            targetLibraryEditable: false,
            targetLibraryFilesEditable: false,
        }),
        onImportReference: async () => ({ state: 'imported' }),
    });
    await nextTask();

    const option = document.querySelector(
        '.mktero-citation-popup-library-option'
    );
    const trigger = document.querySelector(
        '.mktero-citation-popup-library-select'
    );
    assert.equal(trigger.textContent.trim(), 'Shared — Read-only');
    const action = document.querySelector('.mktero-citation-popup-action');
    assert.match(option.textContent, /Shared.*Read-only/);
    assert.equal(option.disabled, false);
    assert.match(
        document.querySelector('.mktero-citation-popup-status').textContent,
        /Read-only/
    );
    assert.equal(action.hidden, true);

    popup.destroy();
    dom.window.close();
});

test('opens a custom library listbox and refreshes status after switching libraries', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const statusLibraryIDs = [];
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [
                {
                    libraryID: 1,
                    name: 'Personal',
                    type: 'user',
                    editable: true,
                    filesEditable: true,
                },
                {
                    libraryID: 8,
                    name: 'Research Group',
                    type: 'group',
                    editable: true,
                    filesEditable: true,
                },
            ],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async (_target, { targetLibraryID }) => {
            statusLibraryIDs.push(String(targetLibraryID));
            return { state: 'absent', canImport: true };
        },
    });
    await nextTask();
    await nextTask();

    const trigger = document.querySelector(
        '.mktero-citation-popup-library-select'
    );
    const options = document.querySelector(
        '.mktero-citation-popup-library-options'
    );
    assert.equal(trigger.matches('button'), true);
    assert.equal(trigger.disabled, false);
    assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(options.hidden, true);
    assert.equal(options.getAttribute('role'), 'listbox');
    assert.deepEqual(
        [...options.querySelectorAll('[role="option"]')]
            .map(option => option.textContent.trim()),
        ['Personal', 'Research Group']
    );
    assert.equal(trigger.textContent.trim(), 'Personal');

    trigger.click();
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(options.hidden, false);
    options.querySelector('[data-library-id="8"]').click();
    await nextTask();
    assert.equal(trigger.textContent.trim(), 'Research Group');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(options.hidden, true);
    assert.ok(statusLibraryIDs.includes('8'));

    popup.destroy();
    dom.window.close();
});

test('supports keyboard navigation and focus restoration in the library listbox', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const statusLibraryIDs = [];
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({
            libraries: [
                {
                    libraryID: 1,
                    name: 'Personal',
                    type: 'user',
                    editable: true,
                    filesEditable: true,
                },
                {
                    libraryID: 8,
                    name: 'Research Group',
                    type: 'group',
                    editable: true,
                    filesEditable: true,
                },
            ],
            defaultLibraryID: 1,
        }),
        onGetReferenceStatus: async (_target, { targetLibraryID }) => {
            statusLibraryIDs.push(String(targetLibraryID));
            return { state: 'absent', canImport: true };
        },
    });
    await nextTask();

    const trigger = document.querySelector(
        '.mktero-citation-popup-library-select'
    );
    const options = document.querySelector(
        '.mktero-citation-popup-library-options'
    );
    trigger.focus();
    trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
    }));
    assert.equal(options.hidden, false);
    assert.equal(
        document.activeElement.dataset.libraryId,
        '1'
    );

    document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
    }));
    assert.equal(document.activeElement.dataset.libraryId, '8');
    document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
    }));
    await nextTask();
    assert.equal(options.hidden, true);
    assert.equal(document.activeElement, trigger);
    assert.equal(trigger.textContent.trim(), 'Research Group');
    assert.ok(statusLibraryIDs.includes('8'));

    trigger.click();
    trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
    }));
    assert.equal(options.hidden, true);
    assert.equal(document.activeElement, trigger);

    trigger.click();
    const selectedOption = document.querySelector(
        '.mktero-citation-popup-library-option[data-library-id="8"]'
    );
    selectedOption.focus();
    selectedOption.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
    }));
    assert.equal(options.hidden, true);
    assert.equal(document.activeElement, trigger);

    popup.destroy();
    dom.window.close();
});

test('shows a visible placeholder when library loading fails', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => {
            throw new Error('library service unavailable');
        },
    });
    await nextTask();
    await nextTask();

    const trigger = document.querySelector(
        '.mktero-citation-popup-library-select'
    );
    const placeholder = document.querySelector(
        '.mktero-citation-popup-library-placeholder'
    );
    assert.equal(trigger.disabled, true);
    assert.equal(trigger.textContent, 'Zotero libraries could not be loaded');
    assert.equal(placeholder.textContent, 'Zotero libraries could not be loaded');
    assert.equal(placeholder.getAttribute('aria-disabled'), 'true');

    popup.destroy();
    dom.window.close();
});

test('shows an unavailable state when no Zotero libraries are returned', async () => {
    const { dom, document, parent, anchor } = createHarness();
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async () => ({ libraries: [] }),
    });
    await nextTask();
    await nextTask();

    const trigger = document.querySelector(
        '.mktero-citation-popup-library-select'
    );
    const placeholder = document.querySelector(
        '.mktero-citation-popup-library-placeholder'
    );
    assert.equal(trigger.disabled, true);
    assert.equal(trigger.textContent, 'No Zotero libraries available');
    assert.equal(placeholder.textContent, 'No Zotero libraries available');

    popup.destroy();
    dom.window.close();
});

test('aborts status work on close and ignores an old-library import result', async () => {
    const { dom, document, parent, anchor } = createHarness();
    let importResolve;
    let secondStatusResolve;
    let observedSignal;
    let unsubscribed = 0;
    const popup = createCitationPopup(parent);
    popup.open({
        anchor,
        targets: [reference()],
        onListReferenceLibraries: async ({ signal }) => {
            observedSignal = signal;
            return {
                libraries: [1, 2].map(libraryID => ({
                    libraryID,
                    name: `Library ${libraryID}`,
                    type: libraryID === 1 ? 'user' : 'group',
                    editable: true,
                    filesEditable: true,
                })),
                defaultLibraryID: 1,
            };
        },
        onGetReferenceStatus: async (_target, { targetLibraryID }) => {
            if (String(targetLibraryID) === '2') {
                return new Promise(resolve => { secondStatusResolve = resolve; });
            }
            return {
                state: 'present-other-library',
                otherMatches: [{ libraryName: 'Library 2' }],
                canImport: true,
            };
        },
        onImportReference: async () => new Promise(resolve => {
            importResolve = resolve;
        }),
        onSubscribeReferenceUpdates: () => () => { unsubscribed++; },
    });
    await nextTask();

    document.querySelector('.mktero-citation-popup-action').click();
    const trigger = document.querySelector(
        '.mktero-citation-popup-library-select'
    );
    trigger.click();
    document.querySelector(
        '.mktero-citation-popup-library-option[data-library-id="2"]'
    ).click();
    await nextTask();
    importResolve({ state: 'imported', match: { itemID: 9 } });
    await nextTask();
    assert.equal(
        document.querySelector('.mktero-citation-popup-status').dataset.state,
        'checking'
    );

    popup.close();
    assert.equal(observedSignal.aborted, true);
    assert.equal(unsubscribed, 1);
    secondStatusResolve({ state: 'absent', canImport: true });
    popup.destroy();
    dom.window.close();
});
