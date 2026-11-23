import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizePdfOutline,
    readPdfOutline,
    validatePdfOutline,
} from '../src/pdf/pdf-outline.js';

test('keeps nested PDF bookmark titles and drops destinations', () => {
    assert.deepEqual(
        normalizePdfOutline([
            {
                title: '  Introduction  ',
                dest: ['page', 1],
                url: 'https://example.com',
                items: [{ title: 'Methods', dest: 'methods', items: [] }],
            },
        ]),
        [{
            title: 'Introduction',
            items: [{ title: 'Methods', items: [] }],
        }]
    );
});

test('verifies native heading text near its bookmark and ignores an unrelated target', async () => {
    const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
    const items = [
        { text: '1', transform: [16, 0, 0, 16, 65, 700], width: 8 },
        { text: 'Introduction', transform: [16, 0, 0, 16, 78, 700], width: 95 },
        { text: 'Results', transform: [16, 0, 0, 16, 65, 550], width: 75 },
    ];
    const target = [0, { name: 'XYZ' }, 65, 715];
    const outline = await readPdfOutline({
        getOutline: () => [
            { title: 'Introduction', dest: 'intro', items: [] },
            { title: 'Results', dest: target, items: [] },
        ],
        getDestination: () => target,
    }, [{ viewport, items }]);

    assert.equal(outline[0].heading.text, '1 Introduction');
    assert.equal(outline[0].heading.pageIndex, 0);
    assert.equal(outline[1].heading, undefined);
    assert.doesNotThrow(() => validatePdfOutline(outline, 1));
    assert.throws(() => validatePdfOutline(outline, 0));
});

test('promotes untitled PDF bookmarks and ignores empty trees', () => {
    assert.deepEqual(
        normalizePdfOutline([
            { title: '  ', items: [{ title: 'Results', items: [] }] },
            { title: '', items: [] },
        ]),
        [{ title: 'Results', items: [] }]
    );
    assert.deepEqual(normalizePdfOutline(null), []);
});

test('rejects a malformed PDF outline while allowing a missing one', () => {
    assert.equal(validatePdfOutline(undefined), undefined);
    assert.throws(() => validatePdfOutline({ title: 'Introduction' }));
    assert.throws(() => validatePdfOutline([{ title: '', items: [] }]));
});
