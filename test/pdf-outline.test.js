import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizePdfOutline,
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
