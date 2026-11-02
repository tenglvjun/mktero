import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePDFCandidates } from '../src/ui/pdf-item-targets.js';

function pdf(id, properties = {}) {
    return { id, isPDFAttachment: () => true, ...properties };
}

function paper(id, attachments, properties = {}) {
    return {
        id,
        isRegularItem: () => true,
        getAttachments: () => attachments,
        ...properties,
    };
}

function runtime(items) {
    return { Items: { get: id => items.find(item => item.id === id) } };
}

test('resolves a selected PDF with attachment identity and distinct attachment labels', () => {
    const parent = paper(10, [42], { getDisplayTitle: () => 'Paper title' });
    const attachment = pdf(42, {
        key: 'PDF00042', libraryID: 1, parentItemID: 10,
        getDisplayTitle: () => 'Supplement', attachmentFilename: 'supplement.pdf',
    });
    const [target] = resolvePDFCandidates(runtime([parent, attachment]), [attachment]);
    assert.equal(target.itemID, 42);
    assert.equal(target.libraryID, 1);
    assert.equal(target.attachmentKey, 'PDF00042');
    assert.equal(target.title, 'Paper title');
    assert.equal(target.attachmentTitle, 'Supplement');
    assert.equal(target.fileName, 'supplement.pdf');
    assert.equal(target.item, attachment);
});

test('expands all PDF attachments in order and deduplicates mixed parent and attachment selections', () => {
    const first = pdf(42);
    const second = pdf(43);
    const webpage = { id: 44, isPDFAttachment: () => false };
    const parent = paper(10, [42, 44, 43]);
    assert.deepEqual(
        resolvePDFCandidates(runtime([first, second, webpage]), [parent, second, parent])
            .map(target => target.itemID),
        [42, 43]
    );
});

test('ignores deleted parents and attachments, notes, webpages, missing items, and invalid IDs', () => {
    const deleted = pdf(42, { deleted: true });
    const parent = paper(10, [42, 43, 999]);
    const live = pdf(43);
    const deletedParent = paper(11, [43], { deleted: true });
    const invalid = [pdf(0), pdf(-1), pdf(1.5), pdf('44'), null, {}];
    const notes = [{ id: 12, isNote: () => true }, { id: 13, isPDFAttachment: () => false }];
    assert.deepEqual(
        resolvePDFCandidates(runtime([deleted, live]), [...invalid, ...notes, deletedParent, parent])
            .map(target => target.itemID),
        [43]
    );
    assert.deepEqual(resolvePDFCandidates(runtime([]), null), []);
});

test('keeps parent display titles for preparation while sanitizing labels from attachments', () => {
    const parent = paper(10, [42], { getDisplayTitle: () => 'Paper\nTitle' });
    const attachment = pdf(42, {
        parentItemID: 10,
        getDisplayTitle: () => `Attachment\u0000 ${'x'.repeat(400)}`,
        attachmentFilename: 'file\nname.pdf',
    });
    const [target] = resolvePDFCandidates(runtime([parent, attachment]), [parent]);
    assert.equal(target.title, 'Paper Title');
    assert.equal(target.attachmentTitle.length, 300);
    assert.equal(target.fileName, 'file name.pdf');
    assert.doesNotMatch(target.attachmentTitle, /[\u0000-\u001F\u007F]/u);
});

test('does not let an unavailable attachment enumeration break other targets', () => {
    const unavailable = paper(10, [], { getAttachments: () => { throw new Error('deleted'); } });
    assert.deepEqual(resolvePDFCandidates(runtime([]), [unavailable, pdf(43)])
        .map(target => target.itemID), [43]);
});
