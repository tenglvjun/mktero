import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ACTIVITY_WINDOW_DAYS,
    activityCellTitle,
    activityLevel,
    activitySummaryText,
    buildActivityGrid,
    formatMemberSince,
    formatStreakLabel,
} from '../src/ui/account-activity.js';

test('maps a day count onto five heat levels', () => {
    assert.equal(activityLevel(0), 0);
    assert.equal(activityLevel(1), 1);
    assert.equal(activityLevel(2), 2);
    assert.equal(activityLevel(3), 3);
    assert.equal(activityLevel(4), 3);
    assert.equal(activityLevel(5), 4);
    assert.equal(activityLevel(100), 4);
});

test('treats missing and malformed counts as no activity', () => {
    for (const value of [undefined, null, NaN, -1, 'nope', {}]) {
        assert.equal(activityLevel(value), 0);
    }
});

test('pads the grid so the first column starts on Sunday', () => {
    // 2026-09-30 is a Wednesday, so the week needs three leading pads.
    const grid = buildActivityGrid([
        { date: '2026-09-30', count: 1 },
    ]);
    assert.equal(grid.cells.length, 4);
    assert.equal(grid.cells[0].pad, true);
    assert.equal(grid.cells[2].pad, true);
    assert.equal(grid.cells[3].pad, false);
    assert.equal(grid.cells[3].level, 1);
    assert.equal(grid.weeks, 1);
});

test('adds no padding when the window already starts on Sunday', () => {
    // 2026-09-27 is a Sunday.
    const grid = buildActivityGrid([
        { date: '2026-09-27', count: 0 },
        { date: '2026-09-28', count: 5 },
    ]);
    assert.equal(grid.cells.length, 2);
    assert.equal(grid.cells[0].pad, false);
    assert.equal(grid.cells[0].level, 0);
    assert.equal(grid.cells[1].level, 4);
});

test('sorts out-of-order days and sums the window total', () => {
    const grid = buildActivityGrid([
        { date: '2026-09-29', count: 3 },
        { date: '2026-09-27', count: 1 },
        { date: '2026-09-28', count: 2 },
    ]);
    assert.deepEqual(
        grid.cells.filter(cell => !cell.pad).map(cell => cell.date),
        ['2026-09-27', '2026-09-28', '2026-09-29']
    );
    assert.equal(grid.total, 6);
    assert.equal(grid.weeks, 1);
});

test('returns an empty grid for missing, empty, or unusable days', () => {
    for (const days of [undefined, null, [], 'nope', [{ date: '' }], [{}]]) {
        const grid = buildActivityGrid(days);
        assert.deepEqual(grid.cells, []);
        assert.equal(grid.weeks, 0);
        assert.equal(grid.total, 0);
    }
});

test('never reports a negative or fractional total', () => {
    const grid = buildActivityGrid([
        { date: '2026-09-27', count: -5 },
        { date: '2026-09-28', count: 2.7 },
    ]);
    assert.equal(grid.total, 2);
});

test('covers a full year so the grid can span 53 columns', () => {
    assert.equal(ACTIVITY_WINDOW_DAYS, 371);
});

test('fills the summary template with the localized total', () => {
    assert.equal(
        activitySummaryText('{total} conversions in the last year', { total: 42 }),
        '42 conversions in the last year'
    );
    assert.equal(
        activitySummaryText('最近一年共 {total} 次转换', { total: 1234, language: 'zh-CN' }),
        '最近一年共 1,234 次转换'
    );
    assert.equal(activitySummaryText('{total} total', { total: 0 }), '0 total');
    assert.equal(activitySummaryText('{total} total', { total: -3 }), '0 total');
    assert.equal(activitySummaryText('', { total: 1 }), '');
});

test('formats streak labels with the singular and plural forms', () => {
    assert.equal(
        formatStreakLabel(1, { one: '{count} day', other: '{count} days' }),
        '1 day'
    );
    assert.equal(
        formatStreakLabel(3, { one: '{count} day', other: '{count} days' }),
        '3 days'
    );
    assert.equal(
        formatStreakLabel(0, { one: '{count} day', other: '{count} days' }),
        '0 days'
    );
});

test('renders the member-since date in the requested language', () => {
    const english = formatMemberSince('2026-09-01T00:00:00Z', 'en');
    assert.match(english, /2026/);
    assert.match(english, /Sep/);
    assert.match(formatMemberSince('2026-09-01T00:00:00Z', 'zh-CN'), /2026/);
});

test('falls back for an unusable registration date', () => {
    assert.equal(formatMemberSince('', 'en'), '');
    assert.equal(formatMemberSince(undefined, 'en'), '');
    assert.equal(formatMemberSince('not-a-date', 'en'), 'not-a-date');
});

test('titles a heat-map cell with its date and count', () => {
    assert.equal(
        activityCellTitle({ date: '2026-09-29', count: 3 }),
        '2026-09-29: 3'
    );
    assert.equal(activityCellTitle({ pad: true, date: '', count: 0 }), '');
    assert.equal(activityCellTitle(null), '');
});
