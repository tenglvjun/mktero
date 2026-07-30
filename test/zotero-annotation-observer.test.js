import test from 'node:test';
import assert from 'node:assert/strict';
import {
    registerZoteroAnnotationObserver,
} from '../src/platform/zotero-annotation-observer.js';

test('reports the PDF attachment changed by a Zotero annotation item', async () => {
    let observer;
    let unregistered;
    const changes = [];
    const zotero = {
        Items: {
            get(id) {
                return id === 73
                    ? { parentID: 42, isAnnotation: () => true }
                    : { id, isAnnotation: () => false };
            },
        },
        Notifier: {
            registerObserver(value, types, id) {
                observer = value;
                assert.deepEqual(types, ['item']);
                assert.equal(id, 'mktero-annotation-sync');
                return 'observer-1';
            },
            unregisterObserver(id) {
                unregistered = id;
            },
        },
    };
    const dispose = registerZoteroAnnotationObserver(zotero, {
        onChange: itemIDs => changes.push(itemIDs),
    });

    observer.notify('modify', 'item', [73, 99], {});
    await Promise.resolve();

    assert.deepEqual(changes, [[42]]);
    dispose();
    assert.equal(unregistered, 'observer-1');
});

test('uses deleted item data and refreshes all open PDFs when it is unavailable', async () => {
    let observer;
    const changes = [];
    const zotero = {
        Items: { get: () => null },
        Notifier: {
            registerObserver(value) {
                observer = value;
                return 'observer-1';
            },
            unregisterObserver() {},
        },
    };
    registerZoteroAnnotationObserver(zotero, {
        onChange: itemIDs => changes.push(itemIDs),
    });

    observer.notify('delete', 'item', [73], {
        73: { oldData: { parentID: 42 } },
    });
    observer.notify('delete', 'item', [74], {});
    await Promise.resolve();

    assert.deepEqual(changes, [[42], null]);
});

test('ignores ordinary item changes and cancels queued callbacks on disposal', async () => {
    let observer;
    let calls = 0;
    const zotero = {
        Items: {
            get: id => ({
                parentID: id === 2 ? 42 : null,
                isAnnotation: () => id === 2,
            }),
        },
        Notifier: {
            registerObserver(value) {
                observer = value;
                return 'observer-1';
            },
            unregisterObserver() {},
        },
    };
    const dispose = registerZoteroAnnotationObserver(zotero, {
        onChange: () => calls++,
    });

    observer.notify('modify', 'item', [1], {});
    observer.notify('modify', 'item', [2], {});
    dispose();
    observer.notify('modify', 'item', [3], {});
    await Promise.resolve();

    assert.equal(calls, 0);
});
