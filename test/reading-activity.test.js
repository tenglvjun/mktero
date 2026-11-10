import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    MAX_READING_ACTIVITY_COUNTER,
    MAX_TRACKED_DOCUMENTS,
    createReadingActivityCounter,
    isAcceptableReadingActivityDay,
    readingActivityCountersFromPayload,
    readingActivityDayKey,
    shouldReportReadingActivity,
} from '../src/account/reading-activity.js';

const DAY = Date.UTC(2026, 10, 9, 12, 0, 0);

function clockAt(instant) {
    return () => instant;
}

function emptyPayload(day) {
    return {
        day,
        readers_opened: 0,
        documents_read: 0,
        readers_scrolled: 0,
        deep_reads: 0,
        annotations_created: 0,
        exports: 0,
        translations: 0,
    };
}

test('reports the UTC day, not the local one', () => {
    // 23:30 UTC on 9 November is already 10 November in UTC+8. The counter must
    // file it under the day the server will accept, which is the UTC one.
    const counter = createReadingActivityCounter({
        now: clockAt(Date.UTC(2026, 10, 9, 23, 30)),
    });
    counter.opened({ itemID: 'A' });
    assert.equal(counter.take().day, '2026-11-09');
});

test('counts every reader tab, including a reopened paper', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY) });
    counter.opened({ itemID: 'A' });
    counter.opened({ itemID: 'A' });
    counter.opened({ itemID: 'B' });
    const payload = counter.take();
    assert.equal(payload.readers_opened, 3);
    // The document counter is latched, so two opens of A are one document.
    assert.equal(payload.documents_read, 2);
});

test('ignores a document call without an identifier instead of counting it', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY) });
    counter.opened({});
    counter.scrolled({});
    counter.deepRead({});
    const payload = counter.take();
    assert.equal(payload.readers_opened, 1);
    assert.equal(payload.documents_read, 0, 'an unattributable document must not be counted');
    assert.equal(payload.readers_scrolled, 0);
    assert.equal(payload.deep_reads, 0);
});

test('latches scroll and deep read per document so scrolling back up cannot erase them', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY) });
    counter.opened({ itemID: 'A' });
    counter.scrolled({ itemID: 'A' });
    counter.deepRead({ itemID: 'A' });
    // The reader scrolls back to the top and the position save reports offset 0.
    // This module never sees the offset, only the milestones, so a repeat call is
    // the only way back and it must not decrement.
    counter.scrolled({ itemID: 'A' });
    counter.deepRead({ itemID: 'A' });
    const payload = counter.take();
    assert.equal(payload.readers_scrolled, 1);
    assert.equal(payload.deep_reads, 1);
});

test('tracks scroll and deep read independently of opened', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY) });
    // A restored session can report a position before opened() runs; both must
    // still count.
    counter.scrolled({ itemID: 'A' });
    counter.deepRead({ itemID: 'A' });
    counter.deepRead({ itemID: 'B' });
    const payload = counter.take();
    assert.equal(payload.readers_scrolled, 1);
    assert.equal(payload.deep_reads, 2);
    // Two documents reached a milestone but only one was attributed as read via
    // opened, and that is fine: the counters are independent signals.
    assert.equal(payload.documents_read, 0);
});

test('counts annotations, exports, and translations without a document', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY) });
    counter.annotationCreated();
    counter.annotationCreated();
    counter.exported();
    counter.translated();
    const payload = counter.take();
    assert.equal(payload.annotations_created, 2);
    assert.equal(payload.exports, 1);
    assert.equal(payload.translations, 1);
});

test('pending is false for an idle session so no empty request is sent', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY) });
    assert.equal(counter.pending(), false);
    assert.equal(counter.take(), null, 'take must not produce an all-zero payload');
    assert.equal(counter.pending(), false);
});

test('take resets the counters', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY) });
    counter.opened({ itemID: 'A' });
    assert.deepEqual(counter.take(), { ...emptyPayload('2026-11-09'), readers_opened: 1, documents_read: 1 });
    assert.equal(counter.pending(), false);
    assert.equal(counter.take(), null);
});

test('an increment after midnight parks the previous day instead of merging into a new one', () => {
    let now = Date.UTC(2026, 10, 9, 23, 59);
    const counter = createReadingActivityCounter({ now: () => now });
    counter.opened({ itemID: 'A' });
    counter.scrolled({ itemID: 'A' });

    // The reporter has not flushed yet when the clock crosses midnight. The
    // midnight increment must not be folded into the previous day's totals.
    now = Date.UTC(2026, 10, 10, 0, 1);
    counter.opened({ itemID: 'B' });

    const first = counter.take();
    assert.equal(first.day, '2026-11-09', 'the parked day is reported first');
    assert.equal(first.readers_opened, 1, 'the tab opened after midnight belongs to the new day');
    assert.equal(first.documents_read, 1);
    assert.equal(first.readers_scrolled, 1);

    // The new day is still pending and carries only what happened after midnight.
    assert.equal(counter.pending(), true);
    assert.equal(counter.currentDay(), '2026-11-10');
    const second = counter.take();
    assert.equal(second.day, '2026-11-10');
    assert.equal(second.readers_opened, 1);
    assert.equal(second.documents_read, 1);
    assert.equal(second.readers_scrolled, 0);
    assert.equal(counter.take(), null);
});

test('a document latched before midnight counts again on the next day', () => {
    let now = Date.UTC(2026, 10, 9, 23, 0);
    const counter = createReadingActivityCounter({ now: () => now });
    counter.opened({ itemID: 'A' });
    counter.scrolled({ itemID: 'A' });
    assert.equal(counter.take().documents_read, 1);

    now = Date.UTC(2026, 10, 10, 9, 0);
    counter.opened({ itemID: 'A' });
    counter.scrolled({ itemID: 'A' });
    const next = counter.take();
    assert.equal(next.day, '2026-11-10');
    assert.equal(next.documents_read, 1, 'a reading day, not a distinct-paper count');
    assert.equal(next.readers_scrolled, 1);
});

test('clamps each counter at the server bound', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY), maxCounter: 3 });
    for (let index = 0; index < 10; index += 1) counter.annotationCreated();
    assert.equal(counter.take().annotations_created, 3);
});

test('the shipped clamp matches the server limit', () => {
    assert.equal(MAX_READING_ACTIVITY_COUNTER, 10000);
});

test('stops attributing new documents past the tracking budget but keeps counting tabs', () => {
    const counter = createReadingActivityCounter({ now: clockAt(DAY), maxDocuments: 2 });
    counter.opened({ itemID: 'A' });
    counter.opened({ itemID: 'B' });
    counter.opened({ itemID: 'C' });
    const payload = counter.take();
    assert.equal(payload.readers_opened, 3, 'tabs are still counted');
    assert.equal(payload.documents_read, 2, 'the document budget is respected');

    // A document already tracked keeps working after the budget is spent.
    const second = createReadingActivityCounter({ now: clockAt(DAY), maxDocuments: 1 });
    second.opened({ itemID: 'A' });
    second.scrolled({ itemID: 'A' });
    second.opened({ itemID: 'B' });
    const replay = second.take();
    assert.equal(replay.readers_scrolled, 1);
});

test('a batch held too long is dropped instead of reported under a wrong day', () => {
    let now = Date.UTC(2026, 10, 1, 12, 0);
    const counter = createReadingActivityCounter({ now: () => now });
    counter.opened({ itemID: 'A' });

    // The reporter never ran for a week. The service would reject the old day, so
    // the batch is discarded rather than retried forever or re-dated.
    now = Date.UTC(2026, 10, 8, 12, 0);
    assert.equal(counter.take(), null);
    assert.equal(counter.pending(), false);
    assert.equal(counter.currentDay(), '2026-11-08');
});

test('yesterday is still acceptable, which is what a flush just after midnight carries', () => {
    let now = Date.UTC(2026, 10, 9, 23, 50);
    const counter = createReadingActivityCounter({ now: () => now });
    counter.opened({ itemID: 'A' });
    now = Date.UTC(2026, 10, 10, 0, 5);
    const payload = counter.take();
    assert.equal(payload.day, '2026-11-09');
    assert.equal(isAcceptableReadingActivityDay(payload.day, () => now), true);
});

test('isAcceptableReadingActivityDay rejects today-plus-one and anything older than yesterday', () => {
    const now = Date.UTC(2026, 10, 9, 12, 0);
    assert.equal(isAcceptableReadingActivityDay('2026-11-09', () => now), true);
    assert.equal(isAcceptableReadingActivityDay('2026-11-08', () => now), true);
    assert.equal(isAcceptableReadingActivityDay('2026-11-07', () => now), false);
    assert.equal(isAcceptableReadingActivityDay('2026-11-10', () => now), false);
    assert.equal(isAcceptableReadingActivityDay('not-a-day', () => now), false);
    assert.equal(isAcceptableReadingActivityDay('', () => now), false);
});

test('readingActivityDayKey uses the UTC calendar day', () => {
    assert.equal(readingActivityDayKey(Date.UTC(2026, 0, 1, 0, 0, 0)), '2026-01-01');
    // 00:30 local in UTC+8 is the previous UTC day.
    assert.equal(readingActivityDayKey(Date.UTC(2026, 0, 1, 23, 30)), '2026-01-01');
    assert.equal(readingActivityDayKey(Date.UTC(2026, 0, 2, 0, 30)), '2026-01-02');
});

test('countersFromPayload trims anything the service would reject', () => {
    const trimmed = readingActivityCountersFromPayload({
        day: '2026-11-09',
        readers_opened: 4.9,
        documents_read: -2,
        readers_scrolled: '3',
        deep_reads: Number.NaN,
        annotations_created: 1e9,
        exports: undefined,
        translations: 0,
        // A field the server does not accept must not survive the trim.
        paper_key: 'ABCD1234',
    });
    assert.deepEqual(trimmed, {
        day: '2026-11-09',
        readers_opened: 4,
        documents_read: 0,
        readers_scrolled: 3,
        deep_reads: 0,
        annotations_created: MAX_READING_ACTIVITY_COUNTER,
        exports: 0,
        translations: 0,
    });
});

test('countersFromPayload refuses a payload without a usable day', () => {
    assert.equal(readingActivityCountersFromPayload(null), null);
    assert.equal(readingActivityCountersFromPayload({ readers_opened: 1 }), null);
    assert.equal(readingActivityCountersFromPayload({ day: '09/11/2026', readers_opened: 1 }), null);
});

test('the tracking budget defaults to a bounded value', () => {
    assert.equal(MAX_TRACKED_DOCUMENTS, 500);
    const counter = createReadingActivityCounter({ now: clockAt(DAY) });
    for (let index = 0; index < MAX_TRACKED_DOCUMENTS + 50; index += 1) {
        counter.opened({ itemID: `item-${index}` });
    }
    const payload = counter.take();
    assert.equal(payload.readers_opened, MAX_TRACKED_DOCUMENTS + 50);
    assert.equal(payload.documents_read, MAX_TRACKED_DOCUMENTS);
});

// Reporting requires both a session and the hosted converter. A reader who
// switched to their own MinerU or Mistral key did so to stop sending data to
// Mktero, and reading counts are still data about them.
test('reports only with a session and the hosted converter selected', () => {
    assert.equal(shouldReportReadingActivity({ signedIn: true, provider: 'mktero' }), true);
    assert.equal(shouldReportReadingActivity({ signedIn: false, provider: 'mktero' }), false);
    for (const provider of ['mineru', 'mistral', '']) {
        assert.equal(
            shouldReportReadingActivity({ signedIn: true, provider }),
            false,
            `${provider || 'an empty provider'} must not report`
        );
    }
});

test('an unset or unknown provider is treated as not the hosted converter', () => {
    assert.equal(shouldReportReadingActivity({ signedIn: true, provider: undefined }), false);
    assert.equal(shouldReportReadingActivity({ signedIn: true, provider: null }), false);
    assert.equal(shouldReportReadingActivity({ signedIn: true, provider: 'MKTREO' }), false);
    assert.equal(shouldReportReadingActivity({ signedIn: true, provider: ' mktero ' }), true);
    assert.equal(shouldReportReadingActivity({}), false);
});
