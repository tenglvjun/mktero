import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroConversionProgress,
    installZoteroConversionProgressButton,
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
