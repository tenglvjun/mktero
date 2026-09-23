import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversionActivity } from '../src/core/conversion-activity.js';

test('matches both the parent row and the PDF attachment row', () => {
    const activity = createConversionActivity();
    assert.equal(activity.mark({
        libraryID: 1,
        itemKey: 'PARENT01',
        attachmentKey: 'ATTACH1',
    }), true);
    assert.equal(activity.mark({
        libraryID: 1,
        itemKey: 'PARENT01',
        attachmentKey: 'ATTACH1',
    }), false);
    assert.equal(activity.isActive({ libraryID: 1, key: 'PARENT01' }), true);
    assert.equal(activity.isActive({ libraryID: 1, key: 'ATTACH1' }), true);
    assert.equal(activity.isActive({ libraryID: 1, key: 'OTHER001' }), false);
    assert.equal(activity.clear({
        libraryID: 1,
        itemKey: 'PARENT01',
        attachmentKey: 'ATTACH1',
    }), true);
    assert.equal(activity.isActive({ libraryID: 1, key: 'PARENT01' }), false);
});

test('ignores identities that cannot be matched to a row', () => {
    const activity = createConversionActivity();
    assert.equal(activity.mark({ libraryID: -1, itemKey: 'A', attachmentKey: 'B' }), false);
    assert.equal(activity.mark({ libraryID: 1, itemKey: '', attachmentKey: 'B' }), false);
    assert.equal(activity.isActive({ key: 'A' }), false);
    assert.equal(activity.clearAll(), false);
});
