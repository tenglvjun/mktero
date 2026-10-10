import test from 'node:test';
import assert from 'node:assert/strict';
import { ZOTERO_ANNOTATION_COLORS } from '../src/core/pdf-annotation.js';
import {
    createEmptyNoteListFilter,
    filterNoteList,
    findActiveNoteOffset,
    reconcileNoteListFilter,
} from '../src/ui/note-list-filter.js';

const PALETTE_COLORS = ZOTERO_ANNOTATION_COLORS.map(color => color.value);

function entry(annotation) {
    return { annotation, matched: true };
}

const yellow = entry({
    id: 'y',
    text: 'Loss function',
    comment: '',
    color: '#ffd400',
    pageLabel: '2',
});
const red = entry({
    id: 'r',
    text: 'The ablation is reported later.',
    comment: 'Check this claim',
    color: '#FF6666',
    pageLabel: '9',
});
const green = entry({
    id: 'g',
    text: 'Method',
    comment: '   ',
    color: 'not-a-color',
    pageLabel: '1',
});

test('returns every note in the given order when the filter is empty', () => {
    const entries = [red, yellow];
    const result = filterNoteList(entries, createEmptyNoteListFilter());

    assert.deepEqual(result.entries, entries);
    assert.equal(result.totalCount, 2);
    assert.equal(result.shownCount, 2);
    assert.equal(result.showSearch, true);
    assert.equal(result.queryActive, false);
    assert.equal(result.filterActive, false);
    assert.equal(result.showColorFilter, true);
    assert.deepEqual(result.populationColors, ['#ffd400', '#ff6666']);
    assert.deepEqual(result.colors.map(color => color.value), PALETTE_COLORS);
    assert.equal(result.colors.find(color => color.value === '#ffd400').count, 1);
    assert.equal(result.colors.find(color => color.value === '#ff6666').count, 1);
    assert.equal(result.colors.find(color => color.value === '#5fb236').count, 0);
});

test('hides search and color chips when there are no notes', () => {
    const result = filterNoteList([], createEmptyNoteListFilter());

    assert.deepEqual(result.entries, []);
    assert.equal(result.showSearch, false);
    assert.equal(result.showColorFilter, false);
    assert.equal(result.showCommentsToggle, false);
});

test('offers every palette color even when the paper uses only yellow', () => {
    const result = filterNoteList([yellow, green], createEmptyNoteListFilter());

    assert.equal(result.showColorFilter, true);
    assert.deepEqual(result.populationColors, ['#ffd400']);
    assert.deepEqual(result.colors.map(color => color.value), PALETTE_COLORS);
    assert.equal(result.colors.find(color => color.value === '#ffd400').count, 2);
    assert.equal(result.colors.every(color => (
        color.value === '#ffd400' || color.count === 0
    )), true);
});

test('matches quote or comment literally and case-insensitively', () => {
    const result = filterNoteList([yellow, red], {
        query: '  CHECK   this ',
        colors: [],
        commentsOnly: false,
    });

    assert.deepEqual(result.entries, [red]);
    assert.equal(result.queryActive, true);
    assert.equal(result.filterActive, true);
    assert.equal(result.shownCount, 1);
    assert.equal(result.totalCount, 2);
});

test('does not treat the query as a regular expression or as a page label', () => {
    const dotted = entry({
        id: 'd',
        text: 'a.b',
        comment: '',
        color: '#2ea8e5',
    });
    const page = entry({
        id: 'p',
        text: 'Body',
        comment: '',
        color: '#5fb236',
        pageLabel: '12',
    });

    assert.deepEqual(
        filterNoteList([dotted], {
            query: 'a.b',
            colors: [],
            commentsOnly: false,
        }).entries,
        [dotted]
    );
    assert.deepEqual(
        filterNoteList([dotted], {
            query: 'axb',
            colors: [],
            commentsOnly: false,
        }).entries,
        []
    );
    assert.deepEqual(
        filterNoteList([page], {
            query: '12',
            colors: [],
            commentsOnly: false,
        }).entries,
        []
    );
    assert.deepEqual(
        filterNoteList([red], {
            query: 'red',
            colors: [],
            commentsOnly: false,
        }).entries,
        []
    );
});

test('filters by any selected color and counts colors before that selection', () => {
    const result = filterNoteList([yellow, red, green], {
        query: '',
        colors: ['#ff6666', '#ff6666', 'nope'],
        commentsOnly: false,
    });

    assert.deepEqual(result.entries, [red]);
    assert.equal(result.colors.find(color => color.value === '#ff6666').count, 1);
    assert.equal(result.colors.find(color => color.value === '#ffd400').count, 2);
    assert.equal(result.colors.find(color => color.value === '#ff6666').selected, true);
    assert.equal(result.colors.find(color => color.value === '#ffd400').selected, false);
    assert.equal(result.colors.find(color => color.value === '#ff6666').name, 'red');
});

test('keeps color chips visible while a query leaves one color', () => {
    const result = filterNoteList([yellow, red], {
        query: 'ablation',
        colors: ['#ffd400'],
        commentsOnly: false,
    });

    assert.equal(result.showColorFilter, true);
    assert.deepEqual(result.entries, []);
    assert.equal(result.colors.find(color => color.value === '#ff6666').count, 1);
    assert.equal(result.colors.find(color => color.value === '#ffd400').count, 0);
});

test('comments-only ignores blank comments and keeps the toggle while it is on', () => {
    const commented = filterNoteList([yellow, red, green], {
        query: '',
        colors: [],
        commentsOnly: false,
    });
    assert.equal(commented.commentCount, 1);
    assert.equal(commented.showCommentsToggle, true);

    const only = filterNoteList([yellow, red, green], {
        query: '',
        colors: [],
        commentsOnly: true,
    });
    assert.deepEqual(only.entries, [red]);
    assert.equal(only.showCommentsToggle, true);

    const none = filterNoteList([yellow], {
        query: '',
        colors: [],
        commentsOnly: true,
    });
    assert.equal(none.showCommentsToggle, true);
    assert.deepEqual(none.entries, []);
});

test('does not offer comments-only when every note has a comment', () => {
    const result = filterNoteList([
        entry({ id: 'a', text: 'A', comment: 'one', color: '#ffd400' }),
        entry({ id: 'b', text: 'B', comment: 'two', color: '#ff6666' }),
    ], createEmptyNoteListFilter());

    assert.equal(result.showCommentsToggle, false);
});

test('reconcile drops selected colors that are no longer in the paper', () => {
    const result = filterNoteList([yellow], createEmptyNoteListFilter());
    const next = reconcileNoteListFilter({
        query: ' loss ',
        colors: ['#ff6666', '#ffd400'],
        commentsOnly: true,
    }, result);

    assert.deepEqual(next, {
        query: ' loss ',
        colors: ['#ffd400'],
        commentsOnly: true,
    });
});

test('does not mutate the entries or the filter object', () => {
    const entries = [yellow, red];
    const filter = { query: 'check', colors: ['#ff6666'], commentsOnly: false };
    const snapshot = structuredClone({ entries, filter });

    filterNoteList(entries, filter);

    assert.deepEqual({ entries, filter }, snapshot);
});

test('finds the last note offset at or before the reading offset', () => {
    assert.equal(findActiveNoteOffset([5, 5, 20], 10), 5);
    assert.equal(findActiveNoteOffset([5, 20], 4), null);
    assert.equal(findActiveNoteOffset([5, 20], 20), 20);
    assert.equal(findActiveNoteOffset([], 0), null);
});
