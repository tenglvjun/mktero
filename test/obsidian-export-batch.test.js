import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createObsidianExportBatch,
    selectObsidianExportGroups,
    summarizeObsidianExportBatch,
} from '../src/core/obsidian-export-batch.js';

function target(itemID, title, libraryID, itemKey) {
    return { itemID, title, libraryID, itemKey };
}

function group(identity, pdfs, title = pdfs[0]?.title) {
    return { identity, title, pdfs };
}

test('merges PDFs that share a parent and drops invalid targets', () => {
    const groups = selectObsidianExportGroups([
        target(1, 'First', 1, 'ABCD2345'),
        target(2, 'Other parent', 1, 'ZZZZZZZZ'),
        target(3, 'Second', 1, 'ABCD2345'),
        target(4, 'Short key', 1, 'SHORT'),
        target(5, 'Lower key', 1, 'abcd2345'),
        target(0, 'Zero item', 1, 'ABCD2345'),
        target(6, 'Negative library', -1, 'ABCD2345'),
        target(1.5, 'Fractional item', 1, 'ABCD2345'),
        target(7, 'Fractional library', 1.5, 'KEY12345'),
        target(8, 'User\u0000title', 0, 'KEY12345'),
        null,
    ]);

    assert.deepEqual(groups, [
        {
            identity: '1:ABCD2345',
            title: 'First',
            pdfs: [
                { itemID: 1, title: 'First' },
                { itemID: 3, title: 'Second' },
            ],
        },
        {
            identity: '1:ZZZZZZZZ',
            title: 'Other parent',
            pdfs: [{ itemID: 2, title: 'Other parent' }],
        },
        {
            identity: '0:KEY12345',
            title: 'User\u0000title',
            pdfs: [{ itemID: 8, title: 'User\u0000title' }],
        },
    ]);
});

test('exports the first cached PDF and does not load later siblings', async () => {
    const loads = [];
    const exported = [];
    const signal = new AbortController().signal;
    const batch = createObsidianExportBatch({
        load(pdf, options) {
            loads.push({ itemID: pdf.itemID, signal: options.signal });
            if (pdf.itemID === 1) return null;
            if (pdf.itemID === 2) return { markdown: 'second' };
            throw new Error(`loaded ${pdf.itemID}`);
        },
        exportDocument(document, options) {
            exported.push({
                document,
                signal: options.signal,
                conflictPolicy: options.conflictPolicy,
            });
            return { status: 'exported' };
        },
        isPreparing: () => false,
    });

    const result = await batch.run(selectObsidianExportGroups([
        target(1, 'Missing', 2, 'AAAAAAAA'),
        target(2, 'Cached', 2, 'AAAAAAAA'),
        target(3, 'Later', 2, 'AAAAAAAA'),
    ]), { signal, conflictPolicy: 'overwrite' });

    assert.deepEqual(loads, [
        { itemID: 1, signal },
        { itemID: 2, signal },
    ]);
    assert.deepEqual(exported, [{
        document: { markdown: 'second' },
        signal,
        conflictPolicy: 'overwrite',
    }]);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.exported, [{
        identity: '2:AAAAAAAA',
        itemID: 2,
        title: 'Cached',
    }]);
    assert.deepEqual(result.duplicate, [{
        identity: '2:AAAAAAAA',
        itemID: 3,
        title: 'Later',
    }]);
    assert.deepEqual(result.notReady, []);
    assert.deepEqual(result.preparing, []);
    assert.deepEqual(result.failed, []);
});

test('reports a group with no cache as not ready without exporting', async () => {
    let exports = 0;
    const batch = createObsidianExportBatch({
        load: () => null,
        exportDocument() {
            exports += 1;
            return { status: 'exported' };
        },
        isPreparing: () => false,
    });

    const result = await batch.run([
        group('1:BBBBBBBB', [
            { itemID: 4, title: 'Empty' },
            { itemID: 5, title: 'Also empty' },
        ]),
    ], { conflictPolicy: 'skip' });

    assert.equal(exports, 0);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.notReady, [{
        identity: '1:BBBBBBBB',
        itemID: 4,
        title: 'Empty',
    }]);
    assert.deepEqual(result.duplicate, []);
    assert.deepEqual(result.exported, []);
});

test('skips a preparing PDF and exports the next cached sibling', async () => {
    const loads = [];
    const batch = createObsidianExportBatch({
        load(pdf) {
            loads.push(pdf.itemID);
            return { markdown: `doc ${pdf.itemID}` };
        },
        exportDocument: () => ({ status: 'exported' }),
        isPreparing: itemID => itemID === 1,
    });

    const result = await batch.run([
        group('1:CCCCCCCC', [
            { itemID: 1, title: 'Preparing' },
            { itemID: 2, title: 'Ready' },
        ]),
    ], { conflictPolicy: 'skip' });

    assert.deepEqual(loads, [2]);
    assert.deepEqual(result.exported, [{
        identity: '1:CCCCCCCC',
        itemID: 2,
        title: 'Ready',
    }]);
    assert.deepEqual(result.preparing, []);
    assert.deepEqual(result.duplicate, []);
});

test('reports a preparing-only group without loading it', async () => {
    let loads = 0;
    const batch = createObsidianExportBatch({
        load() {
            loads += 1;
            return { markdown: 'should not load' };
        },
        exportDocument: () => ({ status: 'exported' }),
        isPreparing: () => true,
    });

    const result = await batch.run([
        group('1:DDDDDDDD', [{ itemID: 9, title: 'Busy' }]),
    ], { conflictPolicy: 'skip' });

    assert.equal(loads, 0);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.preparing, [{
        identity: '1:DDDDDDDD',
        itemID: 9,
        title: 'Busy',
    }]);
    assert.deepEqual(result.exported, []);
    assert.deepEqual(result.notReady, []);
});

test('prefers preparing when every PDF is uncached and one is preparing', async () => {
    const loads = [];
    const batch = createObsidianExportBatch({
        load(pdf) {
            loads.push(pdf.itemID);
            return null;
        },
        exportDocument() {
            throw new Error('should not export');
        },
        isPreparing: itemID => itemID === 12,
    });

    const result = await batch.run([
        group('1:EEEEEEEE', [
            { itemID: 11, title: 'Missing' },
            { itemID: 12, title: 'Busy' },
        ]),
    ], { conflictPolicy: 'skip' });

    assert.deepEqual(loads, [11]);
    assert.deepEqual(result.preparing, [{
        identity: '1:EEEEEEEE',
        itemID: 11,
        title: 'Missing',
    }]);
    assert.deepEqual(result.notReady, []);
    assert.deepEqual(result.duplicate, []);
});

test('records a load failure and still exports the next group', async () => {
    const loads = [];
    const batch = createObsidianExportBatch({
        load(pdf) {
            loads.push(pdf.itemID);
            if (pdf.itemID === 1) throw new Error('disk failed');
            return { markdown: 'ok' };
        },
        exportDocument: () => ({ status: 'exported' }),
        isPreparing: () => false,
    });

    const result = await batch.run([
        group('1:FFFFFFFF', [
            { itemID: 1, title: 'Broken' },
            { itemID: 2, title: 'Sibling' },
        ]),
        group('1:GGGGGGGG', [{ itemID: 3, title: 'Next' }]),
    ], { conflictPolicy: 'skip' });

    assert.deepEqual(loads, [1, 3]);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.failed, [{
        identity: '1:FFFFFFFF',
        itemID: 1,
        title: 'Broken',
        message: 'disk failed',
    }]);
    assert.deepEqual(result.exported, [{
        identity: '1:GGGGGGGG',
        itemID: 3,
        title: 'Next',
    }]);
    assert.deepEqual(result.duplicate, []);
});

test('records an export failure and continues', async () => {
    const batch = createObsidianExportBatch({
        load: pdf => ({ itemID: pdf.itemID }),
        exportDocument(document) {
            if (document.itemID === 1) throw new Error('index full');
            return { status: 'exported' };
        },
        isPreparing: () => false,
    });

    const result = await batch.run([
        group('1:HHHHHHHH', [{ itemID: 1, title: 'First' }]),
        group('1:IIIIIIII', [{ itemID: 2, title: 'Second' }]),
    ], { conflictPolicy: 'skip' });

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.failed, [{
        identity: '1:HHHHHHHH',
        itemID: 1,
        title: 'First',
        message: 'index full',
    }]);
    assert.equal(result.exported.length, 1);
    assert.equal(result.exported[0].itemID, 2);
});

test('cancels before the next group without loading it', async () => {
    const controller = new AbortController();
    const loads = [];
    const batch = createObsidianExportBatch({
        load(pdf) {
            loads.push(pdf.itemID);
            return { markdown: 'cached' };
        },
        exportDocument() {
            return { status: 'exported' };
        },
        isPreparing: () => false,
        onEvent() {
            controller.abort();
        },
    });

    const result = await batch.run([
        group('1:JJJJJJJJ', [{ itemID: 1, title: 'Started' }]),
        group('1:KKKKKKKK', [{ itemID: 2, title: 'Waiting' }]),
    ], { signal: controller.signal, conflictPolicy: 'skip' });

    assert.deepEqual(loads, [1]);
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.exported, [{
        identity: '1:JJJJJJJJ',
        itemID: 1,
        title: 'Started',
    }]);
    assert.deepEqual(result.failed, []);
});

test('AbortError cancels the batch without recording the current group as failed', async () => {
    const loads = [];
    const batch = createObsidianExportBatch({
        load(pdf) {
            loads.push(pdf.itemID);
            if (pdf.itemID === 2) {
                const error = new Error('The operation was aborted');
                error.name = 'AbortError';
                throw error;
            }
            return { markdown: 'cached' };
        },
        exportDocument: () => ({ status: 'exported' }),
        isPreparing: () => false,
    });

    const result = await batch.run([
        group('1:LLLLLLLL', [{ itemID: 1, title: 'Done' }]),
        group('1:MMMMMMMM', [{ itemID: 2, title: 'Aborted' }]),
        group('1:NNNNNNNN', [{ itemID: 3, title: 'Later' }]),
    ], { conflictPolicy: 'skip' });

    assert.deepEqual(loads, [1, 2]);
    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.exported.map(entry => entry.itemID), [1]);
});

test('records a conflict without counting it as exported', async () => {
    const conflicts = [{ language: 'original', path: 'Mktero/Paper.md' }];
    const batch = createObsidianExportBatch({
        load: () => ({ markdown: 'cached' }),
        exportDocument: () => ({ status: 'conflict', conflicts }),
        isPreparing: () => false,
    });

    const result = await batch.run([
        group('1:PPPPPPPP', [
            { itemID: 4, title: 'Paper' },
            { itemID: 5, title: 'Extra' },
        ]),
    ], { conflictPolicy: 'skip' });

    assert.deepEqual(result.exported, []);
    assert.deepEqual(result.conflict, [{
        identity: '1:PPPPPPPP',
        itemID: 4,
        title: 'Paper',
        conflicts,
    }]);
    assert.deepEqual(result.duplicate, [{
        identity: '1:PPPPPPPP',
        itemID: 5,
        title: 'Extra',
    }]);
    assert.equal(result.status, 'completed');
});

test('does not overlap exportDocument calls', async () => {
    let running = 0;
    let maxRunning = 0;
    const batch = createObsidianExportBatch({
        load: async pdf => ({ itemID: pdf.itemID }),
        async exportDocument() {
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await new Promise(resolve => setImmediate(resolve));
            running -= 1;
            return { status: 'exported' };
        },
        isPreparing: () => false,
    });

    const result = await batch.run([
        group('1:QQQQQQQQ', [{ itemID: 1, title: 'One' }]),
        group('1:RRRRRRRR', [{ itemID: 2, title: 'Two' }]),
    ], { conflictPolicy: 'skip' });

    assert.equal(maxRunning, 1);
    assert.equal(running, 0);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.exported.map(entry => entry.itemID), [1, 2]);
});

test('keeps going when a progress listener throws', async () => {
    const events = [];
    const batch = createObsidianExportBatch({
        load: () => ({ markdown: 'cached' }),
        exportDocument: () => ({ status: 'exported' }),
        isPreparing: () => false,
        onEvent(event) {
            events.push(event);
            throw new Error('listener failed');
        },
    });

    const result = await batch.run([
        group('1:SSSSSSSS', [{ itemID: 1, title: 'One' }]),
        group('1:TTTTTTTT', [{ itemID: 2, title: 'Two' }]),
    ], { conflictPolicy: 'skip' });

    assert.equal(result.exported.length, 2);
    assert.deepEqual(events.map(event => event.type), ['exported', 'exported']);
    assert.equal(events[0].group.itemID, 1);
    assert.equal(events[0].group.identity, '1:SSSSSSSS');
    assert.deepEqual(events[0].result, { status: 'exported' });
    assert.equal(events[1].group.title, 'Two');
});

test('summarizes export counts for the progress status line', () => {
    const result = {
        status: 'completed',
        exported: [{ identity: '1:AAAAAAAA' }, { identity: '1:BBBBBBBB' }],
        notReady: [{ identity: '1:CCCCCCCC' }],
        preparing: [],
        duplicate: [{ itemID: 9 }, { itemID: 10 }, { itemID: 11 }],
        conflict: [{ identity: '1:DDDDDDDD' }],
        failed: [{ identity: '1:EEEEEEEE', message: 'disk' }],
    };
    assert.equal(
        summarizeObsidianExportBatch(result, (key, variables) => (
            `${key}=${variables.count}`
        )),
        'obsidianBatch.exported=2 obsidianBatch.notReady=1 '
            + 'obsidianBatch.preparing=0 obsidianBatch.duplicate=3 '
            + 'obsidianBatch.conflict=1 obsidianBatch.failed=1'
    );
    const english = summarizeObsidianExportBatch(result);
    assert.match(english, /Exported 2/);
    assert.match(english, /No Markdown: 1/);
    assert.match(english, /Still preparing: 0/);
    assert.match(english, /Extra PDFs: 3/);
    assert.match(english, /Skipped changed notes: 1/);
    assert.match(english, /Failed: 1/);
    assert.match(summarizeObsidianExportBatch(null), /Exported 0/);
});
