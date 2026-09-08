import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createMarkdownRevisionSessionRegistry,
    openMarkdownRevisionSession,
} from '../src/core/markdown-revision-session.js';

const CACHE_KEY = 'a'.repeat(64);

function createMemoryStore() {
    let saved = null;
    return {
        async load(cacheKey) {
            assert.equal(cacheKey, CACHE_KEY);
            return saved ? structuredClone(saved) : null;
        },
        async save(cacheKey, revision) {
            assert.equal(cacheKey, CACHE_KEY);
            saved = structuredClone(revision);
        },
        async delete(cacheKey) {
            assert.equal(cacheKey, CACHE_KEY);
            saved = null;
        },
        getSaved() {
            return saved ? structuredClone(saved) : null;
        },
        setSaved(revision) {
            saved = structuredClone(revision);
        },
    };
}

function createBaseDocument() {
    const heading = '# Study';
    const paragraph = 'The study included 5O participants.';
    const conclusion = 'Conclusion.';
    const markdown = [heading, paragraph, conclusion].join('\n\n');
    const paragraphFrom = markdown.indexOf(paragraph);
    const conclusionFrom = markdown.indexOf(conclusion);
    return {
        itemID: 42,
        cacheKey: CACHE_KEY,
        markdown,
        sourceMap: [{
            type: 'title',
            markdownFrom: 0,
            markdownTo: heading.length,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 180] }],
        }, {
            type: 'text',
            markdownFrom: paragraphFrom,
            markdownTo: paragraphFrom + paragraph.length,
            locations: [{ pageIndex: 0, bbox: [100, 200, 900, 300] }],
            locationRanges: [{
                markdownFrom: paragraphFrom,
                markdownTo: paragraphFrom + paragraph.length,
                location: { pageIndex: 0, bbox: [100, 200, 900, 300] },
            }],
        }, {
            type: 'text',
            markdownFrom: conclusionFrom,
            markdownTo: conclusionFrom + conclusion.length,
            locations: [{ pageIndex: 1, bbox: [100, 100, 900, 180] }],
            locationRanges: [{
                markdownFrom: conclusionFrom,
                markdownTo: conclusionFrom + conclusion.length,
                location: { pageIndex: 1, bbox: [100, 100, 900, 180] },
            }],
        }],
        assets: [],
        assetBasePath: '',
        extractedPages: 2,
        totalPages: 2,
    };
}

test('commits a paragraph correction and downgrades only its source mapping', async () => {
    const store = createMemoryStore();
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store,
        now: () => 1_786_320_000_000,
    });
    const initial = session.snapshot();
    const paragraph = initial.editableBlocks.find(block => (
        block.originalMarkdown.includes('5O participants')
    ));

    const corrected = await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'The study included fifty participants.',
    });

    assert.equal(
        corrected.markdown,
        '# Study\n\nThe study included fifty participants.\n\nConclusion.'
    );
    assert.equal(corrected.correctionCount, 1);
    assert.deepEqual(corrected.correctedBlockIDs, [paragraph.id]);
    assert.equal(corrected.sourceMap[1].corrected, true);
    assert.equal('locationRanges' in corrected.sourceMap[1], false);
    assert.equal(corrected.sourceMap[2].corrected, undefined);
    assert.equal(
        corrected.sourceMap[2].markdownFrom,
        corrected.markdown.indexOf('Conclusion.')
    );
    assert.equal(
        corrected.sourceMap[2].locationRanges[0].markdownFrom,
        corrected.markdown.indexOf('Conclusion.')
    );
});

test('maps an unchanged annotation while correcting text around it', async () => {
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store: createMemoryStore(),
    });
    const initial = session.snapshot();
    const paragraph = initial.editableBlocks.find(block => (
        block.originalMarkdown.includes('5O participants')
    ));
    const annotationFrom = initial.markdown.indexOf('participants');
    const replacementMarkdown = 'Updated: The study included 50 participants.';
    const mappedFrom = paragraph.from
        + replacementMarkdown.indexOf('participants');

    const corrected = await session.commit({
        blockID: paragraph.id,
        replacementMarkdown,
        annotationRanges: [{
            id: 'mktero-local-1',
            source: 'markdown',
            rangeIndex: 0,
            from: annotationFrom,
            to: annotationFrom + 'participants'.length,
        }],
        mappedAnnotationRanges: [{
            id: 'mktero-local-1',
            source: 'markdown',
            rangeIndex: 0,
            from: mappedFrom,
            to: mappedFrom + 'participants'.length,
        }],
    });

    assert.deepEqual(corrected.annotationRangeMappings, [{
        id: 'mktero-local-1',
        source: 'markdown',
        rangeIndex: 0,
        oldFrom: annotationFrom,
        oldTo: annotationFrom + 'participants'.length,
        from: mappedFrom,
        to: mappedFrom + 'participants'.length,
    }]);
});

test('rejects a correction that changes annotated text', async () => {
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store: createMemoryStore(),
    });
    const initial = session.snapshot();
    const paragraph = initial.editableBlocks.find(block => (
        block.originalMarkdown.includes('5O participants')
    ));
    const annotationFrom = initial.markdown.indexOf('5O');

    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: 'The study included 50 participants.',
            annotationRanges: [{
                id: 'mktero-local-1',
                source: 'markdown',
                rangeIndex: 0,
                from: annotationFrom,
                to: annotationFrom + 2,
            }],
            mappedAnnotationRanges: [{
                id: 'mktero-local-1',
                source: 'markdown',
                rangeIndex: 0,
                from: annotationFrom,
                to: annotationFrom + 2,
            }],
        }),
        error => error?.code === 'MARKDOWN_ANNOTATION_PROTECTED'
    );
    assert.equal(session.snapshot().correctionCount, 0);

    const participantFrom = initial.markdown.indexOf('participants');
    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: '',
            annotationRanges: [{
                id: 'mktero-local-2',
                source: 'markdown',
                rangeIndex: 0,
                from: participantFrom,
                to: participantFrom + 'participants'.length,
            }],
        }),
        error => error?.code === 'MARKDOWN_ANNOTATION_PROTECTED'
    );

    const afterAnnotationDeletion = await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'The study included 50 participants.',
    });
    assert.equal(afterAnnotationDeletion.correctionCount, 1);
});

test('blocks restore only when it would change annotated corrected text', async () => {
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store: createMemoryStore(),
    });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.originalMarkdown.includes('5O participants')
    ));
    const replacementMarkdown = 'The study included 50 participants.';
    const corrected = await session.commit({
        blockID: paragraph.id,
        replacementMarkdown,
    });
    const correctedValueFrom = corrected.markdown.indexOf('50');

    await assert.rejects(
        () => session.restore(paragraph.id, {
            annotationRanges: [{
                id: 'mktero-local-1',
                source: 'markdown',
                rangeIndex: 0,
                from: correctedValueFrom,
                to: correctedValueFrom + 2,
            }],
        }),
        error => error?.code === 'MARKDOWN_ANNOTATION_PROTECTED'
    );
    assert.equal(session.snapshot().correctionCount, 1);

    const participantFrom = corrected.markdown.indexOf('participants');
    const restored = await session.restore(paragraph.id, {
        annotationRanges: [{
            id: 'mktero-local-2',
            source: 'markdown',
            rangeIndex: 0,
            from: participantFrom,
            to: participantFrom + 'participants'.length,
        }],
    });
    assert.equal(restored.correctionCount, 0);
    assert.equal(
        restored.markdown.slice(
            restored.annotationRangeMappings[0].from,
            restored.annotationRangeMappings[0].to
        ),
        'participants'
    );
});

test('keeps every correction when restore-all conflicts with an annotation', async () => {
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store: createMemoryStore(),
    });
    const initial = session.snapshot();
    const heading = initial.editableBlocks.find(block => block.type === 'heading');
    const paragraph = initial.editableBlocks.find(block => (
        block.originalMarkdown.includes('5O participants')
    ));
    await session.commit({
        blockID: heading.id,
        replacementMarkdown: '# Updated Study',
    });
    const corrected = await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'The study included 50 participants.',
    });
    const annotatedFrom = corrected.markdown.indexOf('50');

    await assert.rejects(
        () => session.restoreAll({
            annotationRanges: [{
                id: 'mktero-local-1',
                source: 'markdown',
                rangeIndex: 0,
                from: annotatedFrom,
                to: annotatedFrom + 2,
            }],
        }),
        error => error?.code === 'MARKDOWN_ANNOTATION_PROTECTED'
    );
    assert.equal(session.snapshot().correctionCount, 2);
    assert.match(session.snapshot().markdown, /50 participants/);
});

test('deletes a Markdown block and persists the deletion across sessions', async () => {
    const store = createMemoryStore();
    const baseDocument = createBaseDocument();
    const session = await openMarkdownRevisionSession({
        baseDocument,
        store,
        now: () => 1_786_320_000_000,
    });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.originalMarkdown.includes('5O participants')
    ));

    const deleted = await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: '',
    });

    assert.equal(deleted.markdown, '# Study\n\n\n\nConclusion.');
    assert.equal(deleted.correctionCount, 1);
    assert.deepEqual(deleted.correctedBlockIDs, [paragraph.id]);
    assert.equal(deleted.sourceMap.length, 2);
    assert.equal(
        deleted.sourceMap[1].markdownFrom,
        deleted.markdown.indexOf('Conclusion.')
    );
    assert.equal(deleted.sourceMap[1].corrected, undefined);
    const reopened = await openMarkdownRevisionSession({ baseDocument, store });
    assert.equal(reopened.snapshot().markdown, deleted.markdown);
    assert.deepEqual(reopened.snapshot().correctedBlockIDs, [paragraph.id]);
});

test('restores one correction and deletes the persisted revision when empty', async () => {
    const store = createMemoryStore();
    const baseDocument = createBaseDocument();
    const session = await openMarkdownRevisionSession({ baseDocument, store });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));
    await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'Corrected paragraph.',
    });

    const restored = await session.restore(paragraph.id);

    assert.equal(restored.markdown, baseDocument.markdown);
    assert.equal(restored.correctionCount, 0);
    const reopened = await openMarkdownRevisionSession({ baseDocument, store });
    assert.equal(reopened.snapshot().correctionCount, 0);
});

test('persists table cell corrections across sessions', async () => {
    const store = createMemoryStore();
    const markdown = [
        '# Results',
        '',
        '| Metric | Value |',
        '| --- | --- |',
        '| Accuracy | 9O% |',
    ].join('\n');
    const baseDocument = {
        ...createBaseDocument(),
        markdown,
        sourceMap: [],
    };
    const first = await openMarkdownRevisionSession({ baseDocument, store });
    const table = first.snapshot().editableBlocks.find(block => (
        block.type === 'table'
    ));
    await first.commit({
        blockID: table.id,
        replacementMarkdown: [
            '| Metric | Value |',
            '| --- | --- |',
            '| Accuracy | 90% |',
        ].join('\n'),
    });

    const reopened = await openMarkdownRevisionSession({ baseDocument, store });

    assert.match(reopened.snapshot().markdown, /\| Accuracy \| 90% \|/);
    assert.equal(reopened.snapshot().correctionCount, 1);
});

test('maps an annotated table cell while another cell is corrected', async () => {
    const markdown = [
        '| Metric | Value | Note |',
        '| --- | --- | --- |',
        '| Accuracy | 9O% | Keep this |',
    ].join('\n');
    const baseDocument = {
        ...createBaseDocument(),
        markdown,
        sourceMap: [],
    };
    const session = await openMarkdownRevisionSession({
        baseDocument,
        store: createMemoryStore(),
    });
    const table = session.snapshot().editableBlocks[0];
    const annotationFrom = markdown.indexOf('Keep this');
    const replacementMarkdown = markdown.replace('9O%', '90%');

    const corrected = await session.commit({
        blockID: table.id,
        replacementMarkdown,
        annotationRanges: [{
            id: 'mktero-local-1',
            source: 'markdown',
            rangeIndex: 0,
            from: annotationFrom,
            to: annotationFrom + 'Keep this'.length,
        }],
    });

    const mapping = corrected.annotationRangeMappings[0];
    assert.equal(
        corrected.markdown.slice(mapping.from, mapping.to),
        'Keep this'
    );
});

test('rejects structural and unsafe replacements', async () => {
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store: createMemoryStore(),
    });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));

    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: 'First paragraph.\n\nSecond paragraph.',
        }),
        /one editable block/i
    );
    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: '![Remote](https://example.com/image.png)',
        }),
        /images cannot be added/i
    );
    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: 'Text <img src=x onerror=alert(1)>',
        }),
        /raw HTML cannot be added/i
    );
    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: 'The corrected value is $E = mc^2$.',
        }),
        /formulas cannot be added/i
    );
    await assert.rejects(
        () => session.commit({
            blockID: paragraph.id,
            replacementMarkdown: ' '.repeat((256 * 1024) + 1),
        }),
        /size limit/i
    );
    assert.equal(session.snapshot().correctionCount, 0);
});

test('rejects deletion of a table from calls and stored revisions', async () => {
    const markdown = [
        '| Metric | Value |',
        '| --- | --- |',
        '| Accuracy | 90% |',
    ].join('\n');
    const baseDocument = {
        ...createBaseDocument(),
        markdown,
        sourceMap: [],
    };
    const store = createMemoryStore();
    const session = await openMarkdownRevisionSession({ baseDocument, store });
    const table = session.snapshot().editableBlocks[0];

    await assert.rejects(
        () => session.commit({
            blockID: table.id,
            replacementMarkdown: '',
        }),
        /only paragraphs and headings/i
    );
    await session.commit({
        blockID: table.id,
        replacementMarkdown: markdown.replace('90%', '91%'),
    });
    const tampered = store.getSaved();
    tampered.corrections[0].replacementMarkdown = '';
    store.setSaved(tampered);

    await assert.rejects(
        () => openMarkdownRevisionSession({ baseDocument, store }),
        /only paragraphs and headings/i
    );
});

test('keeps the in-memory revision unchanged when persistence fails', async () => {
    const store = createMemoryStore();
    store.save = async () => {
        throw new Error('disk full');
    };
    const session = await openMarkdownRevisionSession({
        baseDocument: createBaseDocument(),
        store,
    });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));

    await assert.rejects(() => session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'Corrected paragraph.',
    }), /disk full/i);

    assert.equal(session.snapshot().correctionCount, 0);
    assert.equal(session.snapshot().markdown, createBaseDocument().markdown);
});

test('shifts source mappings adjacent to a correction without absorbing it', async () => {
    const baseDocument = createBaseDocument();
    const paragraph = 'The study included 5O participants.';
    const from = baseDocument.markdown.indexOf(paragraph);
    const to = from + paragraph.length;
    baseDocument.sourceMap = [{
        type: 'before',
        markdownFrom: 0,
        markdownTo: from,
        locations: [],
        locationRanges: [{
            markdownFrom: 0,
            markdownTo: from,
            location: { pageIndex: 0, bbox: [0, 0, 1, 1] },
        }],
    }, {
        type: 'edited',
        markdownFrom: from,
        markdownTo: to,
        locations: [{ pageIndex: 0, bbox: [1, 1, 2, 2] }],
    }, {
        type: 'after',
        markdownFrom: to,
        markdownTo: baseDocument.markdown.length,
        locations: [],
        locationRanges: [{
            markdownFrom: to,
            markdownTo: baseDocument.markdown.length,
            location: { pageIndex: 1, bbox: [0, 0, 1, 1] },
        }],
    }];
    const session = await openMarkdownRevisionSession({
        baseDocument,
        store: createMemoryStore(),
    });
    const block = session.snapshot().editableBlocks.find(candidate => (
        candidate.from === from
    ));

    const corrected = await session.commit({
        blockID: block.id,
        replacementMarkdown: 'A much shorter correction.',
    });
    const replacementTo = from + 'A much shorter correction.'.length;

    assert.equal(corrected.sourceMap[0].markdownTo, from);
    assert.equal(corrected.sourceMap[0].locationRanges[0].markdownTo, from);
    assert.equal(corrected.sourceMap[1].markdownFrom, from);
    assert.equal(corrected.sourceMap[1].markdownTo, replacementTo);
    assert.equal(corrected.sourceMap[2].markdownFrom, replacementTo);
    assert.equal(
        corrected.sourceMap[2].locationRanges[0].markdownFrom,
        replacementTo
    );
});

test('restores all corrections without changing the immutable base', async () => {
    const store = createMemoryStore();
    const baseDocument = createBaseDocument();
    const session = await openMarkdownRevisionSession({ baseDocument, store });
    const [heading, paragraph] = session.snapshot().editableBlocks;
    await session.commit({
        blockID: heading.id,
        replacementMarkdown: '## Corrected study',
    });
    await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'Corrected paragraph.',
    });

    const restored = await session.restoreAll();

    assert.equal(restored.markdown, baseDocument.markdown);
    assert.equal(restored.correctionCount, 0);
});

test('edits prose in a formula block while preserving the formula', async () => {
    const baseDocument = {
        ...createBaseDocument(),
        markdown: 'The value is $E = mc^2$ for 5O participants.',
        sourceMap: [],
    };
    const session = await openMarkdownRevisionSession({
        baseDocument,
        store: createMemoryStore(),
    });
    const block = session.snapshot().editableBlocks[0];
    const formulaFrom = baseDocument.markdown.indexOf('$E = mc^2$');

    assert.equal(block.markdown, baseDocument.markdown);
    assert.deepEqual(block.protectedRanges, [{
        from: formulaFrom,
        to: formulaFrom + '$E = mc^2$'.length,
    }]);

    const corrected = await session.commit({
        blockID: block.id,
        replacementMarkdown: 'The value is $E = mc^2$ for 50 participants.',
    });

    assert.equal(
        corrected.markdown,
        'The value is $E = mc^2$ for 50 participants.'
    );
});

test('rejects formula changes made through the revision session', async () => {
    const baseDocument = {
        ...createBaseDocument(),
        markdown: 'The value is $E = mc^2$ for 5O participants.',
        sourceMap: [],
    };
    const session = await openMarkdownRevisionSession({
        baseDocument,
        store: createMemoryStore(),
    });
    const block = session.snapshot().editableBlocks[0];

    await assert.rejects(session.commit({
        blockID: block.id,
        replacementMarkdown: 'The value is $E = mc^3$ for 50 participants.',
    }), /Formulas cannot be changed/);
    await assert.rejects(session.commit({
        blockID: block.id,
        replacementMarkdown: 'The value is 50 participants.',
    }), /Formulas cannot be changed/);

    const plainDocument = {
        ...baseDocument,
        markdown: 'The value is 5O participants.',
    };
    const plainSession = await openMarkdownRevisionSession({
        baseDocument: plainDocument,
        store: createMemoryStore(),
    });
    await assert.rejects(plainSession.commit({
        blockID: plainSession.snapshot().editableBlocks[0].id,
        replacementMarkdown: 'The value is $E = mc^2$ for 50 participants.',
    }), /Formulas cannot be added/);
});

test('keeps a formula-only block out of correction editing', async () => {
    const formula = '$E = mc^2$';
    const plain = 'Plain recognition text.';
    const baseDocument = {
        ...createBaseDocument(),
        markdown: [formula, plain].join('\n\n'),
        sourceMap: [],
    };
    const session = await openMarkdownRevisionSession({
        baseDocument,
        store: createMemoryStore(),
    });

    assert.deepEqual(
        session.snapshot().editableBlocks.map(block => block.markdown),
        [plain]
    );
});

test('adds protected formula blocks when reopening a legacy revision', async () => {
    const store = createMemoryStore();
    const heading = '# Study';
    const formula = 'The value is $E = mc^2$.';
    const conclusion = 'Conclusion.';
    const markdown = [heading, formula, conclusion].join('\n\n');
    const conclusionFrom = markdown.indexOf(conclusion);
    const conclusionID = [
        'block-1-',
        conclusionFrom,
        '-',
        conclusionFrom + conclusion.length,
        '-paragraph',
    ].join('');
    const baseDocument = {
        ...createBaseDocument(),
        markdown,
        sourceMap: [],
    };
    store.setSaved({
        schemaVersion: 1,
        base: baseDocument,
        blocks: [{
            id: `block-0-0-${heading.length}-heading`,
            type: 'heading',
            baseFrom: 0,
            baseTo: heading.length,
            originalMarkdown: heading,
        }, {
            id: conclusionID,
            type: 'paragraph',
            baseFrom: conclusionFrom,
            baseTo: conclusionFrom + conclusion.length,
            originalMarkdown: conclusion,
        }],
        corrections: [{
            blockID: conclusionID,
            originalMarkdown: conclusion,
            replacementMarkdown: 'Finding.',
            updatedAt: 1_786_320_000_000,
        }],
    });

    const session = await openMarkdownRevisionSession({ baseDocument, store });
    const snapshot = session.snapshot();

    assert.equal(snapshot.markdown, [heading, formula, 'Finding.'].join('\n\n'));
    assert.equal(snapshot.correctionCount, 1);
    assert.ok(snapshot.editableBlocks.some(block => (
        block.markdown === formula && block.protectedRanges?.length === 1
    )));

    const tampered = store.getSaved();
    const formulaFrom = markdown.indexOf(formula);
    tampered.corrections = [{
        blockID: [
            'formula-block-',
            formulaFrom,
            '-',
            formulaFrom + formula.length,
            '-paragraph',
        ].join(''),
        originalMarkdown: formula,
        replacementMarkdown: 'Measured $E = mc^2$.',
        updatedAt: 1_786_320_000_001,
    }];
    store.setSaved(tampered);

    await assert.rejects(
        () => openMarkdownRevisionSession({ baseDocument, store }),
        /Invalid saved Markdown correction/
    );
});

test('does not install a revision session that finishes opening after close', async () => {
    let resolveOpen;
    let destroyed = 0;
    const registry = createMarkdownRevisionSessionRegistry({
        openSession: () => new Promise(resolve => {
            resolveOpen = resolve;
        }),
    });
    const opening = registry.open(42, createBaseDocument());
    await Promise.resolve();

    await registry.close(42);
    resolveOpen({
        destroy: async () => { destroyed++; },
    });

    await assert.rejects(opening, error => error?.name === 'AbortError');
    assert.equal(registry.get(42), undefined);
    assert.equal(destroyed, 1);
});

test('destroys open and pending revision sessions during shutdown', async () => {
    let resolvePending;
    const destroyed = [];
    const registry = createMarkdownRevisionSessionRegistry({
        openSession: ({ baseDocument }) => baseDocument.itemID === 42
            ? Promise.resolve({
                destroy: async () => destroyed.push(42),
            })
            : new Promise(resolve => { resolvePending = resolve; }),
    });
    await registry.open(42, createBaseDocument());
    const pending = registry.open(43, {
        ...createBaseDocument(),
        itemID: 43,
    });
    await Promise.resolve();

    await registry.destroyAll();
    resolvePending({
        destroy: async () => destroyed.push(43),
    });

    await assert.rejects(pending, error => error?.name === 'AbortError');
    assert.deepEqual(destroyed.sort(), [42, 43]);
    assert.equal(registry.get(42), undefined);
    assert.equal(registry.get(43), undefined);
});

test('shifts chromeRanges with unrelated corrections and drops overlapping ones', async () => {
    const heading = '# Study';
    const paragraph = 'The study included 5O participants.';
    const chrome = '12';
    const conclusion = 'Conclusion.';
    const markdown = [heading, paragraph, chrome, conclusion].join('\n\n');
    const paragraphFrom = markdown.indexOf(paragraph);
    const chromeFrom = markdown.indexOf(chrome);
    const conclusionFrom = markdown.indexOf(conclusion);
    const baseDocument = {
        itemID: 42,
        cacheKey: CACHE_KEY,
        markdown,
        chromeRanges: [{ from: chromeFrom, to: chromeFrom + chrome.length }],
        sourceMap: [{
            type: 'title',
            markdownFrom: 0,
            markdownTo: heading.length,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 180] }],
        }, {
            type: 'text',
            markdownFrom: paragraphFrom,
            markdownTo: paragraphFrom + paragraph.length,
            locations: [{ pageIndex: 0, bbox: [100, 200, 900, 300] }],
        }, {
            type: 'text',
            markdownFrom: conclusionFrom,
            markdownTo: conclusionFrom + conclusion.length,
            locations: [{ pageIndex: 1, bbox: [100, 100, 900, 180] }],
        }],
        assets: [],
        assetBasePath: '',
        extractedPages: 2,
        totalPages: 2,
    };
    const session = await openMarkdownRevisionSession({
        baseDocument,
        store: createMemoryStore(),
    });
    const paragraphBlock = session.snapshot().editableBlocks.find(block => (
        block.originalMarkdown.includes('5O participants')
    ));
    const replacement = 'The study included fifty participants.';
    const shifted = await session.commit({
        blockID: paragraphBlock.id,
        replacementMarkdown: replacement,
    });
    const delta = replacement.length - paragraph.length;
    assert.deepEqual(shifted.chromeRanges, [{
        from: chromeFrom + delta,
        to: chromeFrom + chrome.length + delta,
    }]);

    const overlapSession = await openMarkdownRevisionSession({
        baseDocument,
        store: createMemoryStore(),
    });
    const chromeBlock = overlapSession.snapshot().editableBlocks.find(block => (
        block.originalMarkdown.trim() === '12'
    ));
    const dropped = await overlapSession.commit({
        blockID: chromeBlock.id,
        replacementMarkdown: 'page',
    });
    assert.deepEqual(dropped.chromeRanges, []);
});
