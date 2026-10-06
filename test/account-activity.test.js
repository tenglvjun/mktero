import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatActivityPeriodLabels,
    formatMemberSince,
} from '../src/ui/account-activity.js';

test('formats the current month and day as dates', () => {
    const labels = formatActivityPeriodLabels(new Date('2026-10-06T15:00:00Z'), 'en-US');
    assert.match(labels.month, /October/);
    assert.match(labels.month, /2026/);
    assert.match(labels.today, /October/);
    assert.match(labels.today, /6/);
    assert.match(labels.today, /2026/);
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
