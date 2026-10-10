import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroConversionProgress,
    installZoteroConversionProgressButton,
    resolveAbandonedExportProgressStatus,
    signalProgressAlreadyRunning,
} from '../src/platform/zotero-conversion-progress.js';

test('updates one Zotero progress queue and retitles its dialog', () => {
    const rows = [];
    const listeners = [];
    let status = '';
    let opened = 0;
    let cancelled = 0;
    const queue = {
        addListener(name, callback) {
            listeners.push([name, callback]);
        },
        addRow(item) {
            rows.push({ id: item.id, title: item.getDisplayTitle() });
        },
        updateRow(itemID, rowStatus, message) {
            rows.push({ itemID, rowStatus, message });
        },
        deleteRow(itemID) {
            rows.push({ deleted: itemID });
        },
        getDialog: () => ({
            setStatus(message) {
                status = message;
            },
            open() {
                opened += 1;
            },
        }),
        cancel() {
            cancelled += 1;
        },
    };
    const titled = [];
    const progress = createZoteroConversionProgress({
        zotero: {
            ProgressQueue: {
                ROW_QUEUED: 1,
                ROW_PROCESSING: 2,
                ROW_FAILED: 3,
                ROW_SUCCEEDED: 4,
            },
            ProgressQueues: {
                get: () => null,
                create(options) {
                    assert.equal(options.id, 'mktero-prepare');
                    assert.equal(options.title, 'general.processing');
                    return queue;
                },
            },
        },
        services: {
            wm: {
                getEnumerator() {
                    let pending = true;
                    return {
                        hasMoreElements: () => pending,
                        getNext: () => {
                            pending = false;
                            return {
                                document: {
                                    title: '',
                                    getElementById: () => ({}),
                                    set title(value) {
                                        titled.push(value);
                                    },
                                },
                            };
                        },
                    };
                },
            },
        },
        title: 'Preparing Markdown',
        onCancel: () => cancelled += 1,
        schedule: callback => callback(),
    });

    progress.add(7, 'Paper');
    progress.update(7, progress.statuses.processing, 'Converting');
    progress.setStatus('Minimizing continues.');
    progress.open();
    listeners[0][1]();
    progress.remove(7);
    progress.cancel();

    assert.deepEqual(rows[0], { id: 7, title: 'Paper' });
    assert.equal(rows[1].message, 'Converting');
    assert.equal(status, 'Minimizing continues.');
    assert.equal(opened, 1);
    assert.deepEqual(titled, ['Preparing Markdown', 'Preparing Markdown']);
    assert.equal(cancelled, 2);
    assert.deepEqual(rows.at(-1), { deleted: 7 });
    assert.equal(createZoteroConversionProgress({ zotero: {} }), null);
});

test('rebinds cancellation when Zotero already has the preparation queue', () => {
    const listeners = [];
    const queue = {
        addListener(name, callback) {
            listeners.push(callback);
        },
        removeListener(_name, callback) {
            const index = listeners.indexOf(callback);
            if (index >= 0) listeners.splice(index, 1);
        },
        getDialog: () => ({ open() {}, setStatus() {} }),
    };
    const zotero = {
        ProgressQueue: {
            ROW_QUEUED: 1,
            ROW_PROCESSING: 2,
            ROW_FAILED: 3,
            ROW_SUCCEEDED: 4,
        },
        ProgressQueues: {
            get: () => queue,
            create: () => {
                throw new Error('existing queue must be reused');
            },
        },
    };
    let first = 0;
    let second = 0;
    createZoteroConversionProgress({ zotero, onCancel: () => { first += 1; }, schedule() {} });
    createZoteroConversionProgress({ zotero, onCancel: () => { second += 1; }, schedule() {} });
    assert.equal(listeners.length, 1);
    listeners[0]();
    assert.equal(first, 0);
    assert.equal(second, 1);
});

test('adds a tab-bar button that reopens a minimized preparation window', () => {
    const listeners = [];
    let opened = 0;
    const button = {
        id: '',
        hidden: true,
        attributes: new Map(),
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        addEventListener(name, callback) {
            this[name] = callback;
        },
        removeEventListener() {},
        remove() {
            this.removed = true;
        },
    };
    const box = { appendChild(node) { this.child = node; } };
    const queue = {
        getTotal: () => 2,
        addListener(name, callback) {
            listeners.push([name, callback]);
        },
        removeListener() {},
        getDialog: () => ({ open() { opened += 1; } }),
    };
    const dispose = installZoteroConversionProgressButton({
        zotero: { ProgressQueues: { get: () => queue } },
        window: {
            document: {
                getElementById: id => (id === 'zotero-pq-buttons' ? box : null),
                createElement: () => button,
            },
        },
        title: 'Preparing Markdown',
        iconURL: 'resource://mktero/ui/icons/mktero.svg',
        schedule() {},
    });

    assert.equal(button.id, 'zotero-tb-pq-mktero-prepare');
    assert.equal(button.hidden, false);
    assert.equal(button.attributes.get('tooltiptext'), 'Preparing Markdown');
    assert.equal(box.child, button);
    button.command();
    assert.equal(opened, 1);
    listeners.find(([name]) => name === 'empty')[1]();
    assert.equal(button.hidden, true);
    dispose();
    assert.equal(button.removed, true);
    assert.equal(installZoteroConversionProgressButton({
        zotero: { ProgressQueues: { get: () => null } },
        window: { document: { getElementById: () => box } },
    }), null);
});

test('uses a custom queue id without touching mktero-prepare', () => {
    const requested = [];
    const prepare = progressWindow('Preparing Markdown');
    const exporting = progressWindow('Processing');
    exporting.arguments = [{
        progressQueue: {
            getID: () => 'mktero-obsidian-export',
        },
    }];
    let includeExport = false;
    const queue = {
        addListener() {},
        getDialog() {
            return {
                open() {
                    includeExport = true;
                },
                setStatus() {},
            };
        },
    };
    const progress = createZoteroConversionProgress({
        queueID: 'mktero-obsidian-export',
        title: 'Exporting Markdown to Obsidian',
        schedule: callback => callback(),
        zotero: {
            ProgressQueue: {
                ROW_QUEUED: 1,
                ROW_PROCESSING: 2,
                ROW_FAILED: 3,
                ROW_SUCCEEDED: 4,
            },
            ProgressQueues: {
                get(id) {
                    requested.push(id);
                    assert.notEqual(id, 'mktero-prepare');
                    return null;
                },
                create(options) {
                    requested.push(options.id);
                    assert.notEqual(options.id, 'mktero-prepare');
                    return queue;
                },
            },
        },
        services: {
            wm: {
                getEnumerator() {
                    const windows = includeExport
                        ? [prepare, exporting]
                        : [prepare];
                    let index = 0;
                    return {
                        hasMoreElements: () => index < windows.length,
                        getNext: () => windows[index++],
                    };
                },
            },
        },
    });

    progress.open();

    assert.deepEqual(requested, [
        'mktero-obsidian-export',
        'mktero-obsidian-export',
    ]);
    assert.equal(requested.includes('mktero-prepare'), false);
    assert.equal(prepare.document.title, 'Preparing Markdown');
    assert.equal(exporting.document.title, 'Exporting Markdown to Obsidian');
    assert.equal(
        exporting.attributes.get('data-mktero-queue'),
        'mktero-obsidian-export'
    );
    assert.equal(prepare.attributes.has('data-mktero-queue'), false);
});

test('installs a custom queue button without using the prepare button id', () => {
    const requested = [];
    const button = {
        id: '',
        hidden: true,
        attributes: new Map(),
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        addEventListener() {},
        removeEventListener() {},
        remove() {},
    };
    const box = { appendChild(node) { this.child = node; } };
    const queue = {
        getTotal: () => 1,
        addListener() {},
        removeListener() {},
        getDialog: () => ({ open() {} }),
    };
    const dispose = installZoteroConversionProgressButton({
        queueID: 'mktero-obsidian-export',
        zotero: {
            ProgressQueues: {
                get(id) {
                    requested.push(id);
                    return id === 'mktero-obsidian-export' ? queue : null;
                },
            },
        },
        window: {
            document: {
                getElementById: id => (id === 'zotero-pq-buttons' ? box : null),
                createElement: () => button,
            },
        },
        title: 'Exporting Markdown to Obsidian',
    });

    assert.deepEqual(requested, ['mktero-obsidian-export']);
    assert.equal(requested.includes('mktero-prepare'), false);
    assert.equal(button.id, 'zotero-tb-pq-mktero-obsidian-export');
    assert.notEqual(button.id, 'zotero-tb-pq-mktero-prepare');
    dispose();
});

test('signals an already-running export before the progress object exists', () => {
    let created = 0;
    let status = '';
    let opened = 0;
    const result = signalProgressAlreadyRunning({
        running: true,
        progress: null,
        message: 'An Obsidian export is already running.',
        ensureProgress() {
            created += 1;
            return {
                setStatus(message) {
                    status = message;
                },
                open() {
                    opened += 1;
                },
            };
        },
    });

    assert.equal(result.ignored, true);
    assert.equal(result.signaled, true);
    assert.equal(result.createdProgress, true);
    assert.equal(created, 1);
    assert.equal(status, 'An Obsidian export is already running.');
    assert.equal(opened, 1);

    let existingOpened = 0;
    const existing = signalProgressAlreadyRunning({
        running: true,
        progress: {
            setStatus(message) {
                status = message;
            },
            open() {
                existingOpened += 1;
            },
        },
        message: 'still running',
        ensureProgress() {
            throw new Error('progress already exists');
        },
    });
    assert.equal(existing.createdProgress, false);
    assert.equal(status, 'still running');
    assert.equal(existingOpened, 0);

    let idleCreated = 0;
    const idle = signalProgressAlreadyRunning({
        running: false,
        ensureProgress() {
            idleCreated += 1;
        },
    });
    assert.equal(idle.ignored, false);
    assert.equal(idle.signaled, false);
    assert.equal(idleCreated, 0);
});

test('marks an export window that appears after open returns', () => {
    const prepare = progressWindow('Preparing Markdown');
    const exporting = progressWindow('Processing');
    exporting.arguments = [{
        progressQueue: {
            getID: () => 'mktero-obsidian-export',
        },
    }];
    const visible = [prepare];
    const queued = [];
    const progress = createZoteroConversionProgress({
        queueID: 'mktero-obsidian-export',
        title: 'Exporting Markdown to Obsidian',
        schedule(callback, delay) {
            queued.push({ callback, delay });
        },
        zotero: progressQueues({
            open() {},
        }),
        services: windowService(() => visible),
    });

    progress.open();
    assert.equal(exporting.attributes.has('data-mktero-queue'), false);
    assert.equal(queued.length, 1);
    assert.ok(queued[0].delay > 0);

    queued.shift().callback();
    assert.equal(exporting.attributes.has('data-mktero-queue'), false);
    assert.equal(prepare.document.title, 'Preparing Markdown');

    visible.push(exporting);
    queued.shift().callback();

    assert.equal(
        exporting.attributes.get('data-mktero-queue'),
        'mktero-obsidian-export'
    );
    assert.equal(exporting.document.title, 'Exporting Markdown to Obsidian');
    assert.equal(prepare.document.title, 'Preparing Markdown');
    assert.equal(prepare.attributes.has('data-mktero-queue'), false);
});

test('preparation does not claim an export progress window', () => {
    const prepare = progressWindow('Old title');
    const marked = progressWindow('Exporting Markdown to Obsidian');
    marked.attributes.set('data-mktero-queue', 'mktero-obsidian-export');
    marked.document.getElementById('progress-queue-root').setAttribute(
        'data-mktero-queue',
        'mktero-obsidian-export'
    );
    const byArguments = progressWindow('Processing');
    byArguments.arguments = [{
        progressQueue: {
            getID: () => 'mktero-obsidian-export',
        },
    }];
    const progress = createZoteroConversionProgress({
        title: 'Preparing Markdown',
        schedule: callback => callback(),
        zotero: progressQueues({
            open() {},
        }),
        services: windowService(() => [prepare, marked, byArguments]),
    });

    progress.open();

    assert.equal(prepare.document.title, 'Preparing Markdown');
    assert.equal(prepare.attributes.has('data-mktero-queue'), false);
    assert.equal(marked.document.title, 'Exporting Markdown to Obsidian');
    assert.equal(
        marked.attributes.get('data-mktero-queue'),
        'mktero-obsidian-export'
    );
    assert.equal(byArguments.document.title, 'Processing');
    assert.equal(byArguments.attributes.has('data-mktero-queue'), false);
});

test('toolbar reopen marks a late export progress window', () => {
    const exporting = progressWindow('Processing');
    exporting.arguments = [{
        progressQueue: {
            getID: () => 'mktero-obsidian-export',
        },
    }];
    const visible = [];
    const queued = [];
    let opened = 0;
    const button = {
        id: '',
        hidden: true,
        attributes: new Map(),
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        addEventListener(name, callback) {
            this[name] = callback;
        },
        removeEventListener() {},
        remove() {},
    };
    const box = { appendChild(node) { this.child = node; } };
    installZoteroConversionProgressButton({
        queueID: 'mktero-obsidian-export',
        title: 'Exporting Markdown to Obsidian',
        schedule(callback, delay) {
            queued.push({ callback, delay });
        },
        services: windowService(() => visible),
        zotero: {
            ProgressQueues: {
                get: () => ({
                    getTotal: () => 1,
                    addListener() {},
                    removeListener() {},
                    getDialog: () => ({
                        open() {
                            opened += 1;
                        },
                    }),
                }),
            },
        },
        window: {
            document: {
                getElementById: id => (id === 'zotero-pq-buttons' ? box : null),
                createElement: () => button,
            },
        },
    });

    button.command();
    assert.equal(opened, 1);
    assert.equal(exporting.attributes.has('data-mktero-queue'), false);
    assert.ok(queued[0].delay > 0);

    visible.push(exporting);
    queued.shift().callback();

    assert.equal(
        exporting.attributes.get('data-mktero-queue'),
        'mktero-obsidian-export'
    );
    assert.equal(exporting.document.title, 'Exporting Markdown to Obsidian');
});

test('does not mark a prepare dialog as the export queue', () => {
    const prepare = progressWindow('Processing');
    const visible = [];
    const queued = [];
    const progress = createZoteroConversionProgress({
        queueID: 'mktero-obsidian-export',
        title: 'Exporting Markdown to Obsidian',
        schedule(callback, delay) {
            queued.push({ callback, delay });
        },
        zotero: progressQueues({ open() {} }),
        services: windowService(() => visible),
    });

    progress.open();
    visible.push(prepare);
    queued.shift().callback();
    prepare.arguments = [{
        progressQueue: {
            getID: () => 'mktero-prepare',
        },
    }];
    queued.shift().callback();

    assert.notEqual(
        prepare.attributes.get('data-mktero-queue'),
        'mktero-obsidian-export',
    );
    assert.notEqual(prepare.document.title, 'Exporting Markdown to Obsidian');

    const guessed = progressWindow('Processing');
    guessed.arguments = [{
        progressQueue: {
            getID: () => 'mktero-prepare',
        },
    }];
    guessed.document.getElementById('progress-queue-root').setAttribute(
        'data-mktero-queue',
        'mktero-obsidian-export',
    );
    const preparing = createZoteroConversionProgress({
        title: 'Preparing Markdown',
        schedule: callback => callback(),
        zotero: progressQueues({ open() {} }),
        services: windowService(() => [guessed]),
    });
    preparing.open();
    assert.equal(guessed.document.title, 'Preparing Markdown');
    assert.notEqual(
        guessed.attributes.get('data-mktero-queue'),
        'mktero-obsidian-export',
    );
});

test('disposed export button does not mark a later progress window', () => {
    const exporting = progressWindow('Processing');
    exporting.arguments = [{
        progressQueue: {
            getID: () => 'mktero-obsidian-export',
        },
    }];
    const visible = [];
    const queued = [];
    const button = {
        id: '',
        hidden: true,
        attributes: new Map(),
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
        addEventListener(name, callback) {
            this[name] = callback;
        },
        removeEventListener() {},
        remove() {
            this.removed = true;
        },
    };
    const box = { appendChild(node) { this.child = node; } };
    const dispose = installZoteroConversionProgressButton({
        queueID: 'mktero-obsidian-export',
        title: 'Exporting Markdown to Obsidian',
        schedule(callback, delay) {
            queued.push({ callback, delay });
        },
        services: windowService(() => visible),
        zotero: {
            ProgressQueues: {
                get: () => ({
                    getTotal: () => 1,
                    addListener() {},
                    removeListener() {},
                    getDialog: () => ({ open() {} }),
                }),
            },
        },
        window: {
            document: {
                getElementById: id => (id === 'zotero-pq-buttons' ? box : null),
                createElement: () => button,
            },
        },
    });

    button.command();
    assert.ok(queued.length >= 1);
    dispose();
    visible.push(exporting);
    for (const item of queued) item.callback();

    assert.equal(exporting.attributes.has('data-mktero-queue'), false);
    assert.notEqual(exporting.document.title, 'Exporting Markdown to Obsidian');
    assert.equal(button.removed, true);
});

test('restores the previous summary when an abandoned batch overwrote it', () => {
    const previous = 'Exported 2. Not ready 1.';
    assert.equal(resolveAbandonedExportProgressStatus({
        rowsOpened: false,
        progressExisted: true,
        alreadyRunningSignaled: true,
        previousStatus: previous,
    }), previous);
    assert.equal(resolveAbandonedExportProgressStatus({
        rowsOpened: false,
        progressExisted: true,
        alreadyRunningSignaled: true,
        previousStatus: '',
    }), '');
    assert.equal(resolveAbandonedExportProgressStatus({
        rowsOpened: false,
        progressExisted: false,
        alreadyRunningSignaled: true,
        previousStatus: '',
    }), '');
    assert.equal(resolveAbandonedExportProgressStatus({
        rowsOpened: false,
        progressExisted: true,
        alreadyRunningSignaled: false,
        previousStatus: previous,
    }), null);
    assert.equal(resolveAbandonedExportProgressStatus({
        rowsOpened: true,
        progressExisted: true,
        alreadyRunningSignaled: true,
        previousStatus: previous,
    }), null);
});

function progressQueues(dialog) {
    return {
        ProgressQueue: {
            ROW_QUEUED: 1,
            ROW_PROCESSING: 2,
            ROW_FAILED: 3,
            ROW_SUCCEEDED: 4,
        },
        ProgressQueues: {
            get: () => null,
            create: () => ({
                addListener() {},
                getDialog: () => dialog,
            }),
        },
    };
}

function windowService(visible) {
    return {
        wm: {
            getEnumerator() {
                const windows = visible();
                let index = 0;
                return {
                    hasMoreElements: () => index < windows.length,
                    getNext: () => windows[index++],
                };
            },
        },
    };
}

function progressWindow(title) {
    const attributes = new Map();
    const root = {
        getAttribute(name) {
            return attributes.get(name) || '';
        },
        setAttribute(name, value) {
            attributes.set(name, value);
        },
    };
    return {
        attributes,
        document: {
            title,
            getElementById(id) {
                return id === 'progress-queue-root' ? root : null;
            },
        },
    };
}
