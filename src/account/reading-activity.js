// Daily reading-activity counters sent to the Mktero service.
//
// This module accumulates only totals. It never records which paper was read,
// when each action happened, or any text from the document: the payload is seven
// integers and one UTC day. That is a product decision, not an implementation
// shortcut, so anything richer belongs in a different module with a different
// privacy review.
//
// Counts are held in memory and lost on a crash, which is deliberate. Persisting
// them would create a second on-disk reading history with its own retention and
// deletion story, and the counts are a sample rather than a ledger.
//
// Counts never merge across a UTC day. An increment whose clock has crossed
// midnight first parks the previous day's totals in a single held slot and starts
// a fresh set for the new day, so a reader who scrolls at 23:59 and again at
// 00:01 produces two flushes that report the right day each instead of one
// combined total filed under the wrong date. Only one day can be held: if a
// reporter stalls for longer than that, the older totals are dropped because the
// service would reject the day anyway.

// The client clamps at the same bound the server enforces, so a reader is never
// told one number locally while the service is told another.
export const MAX_READING_ACTIVITY_COUNTER = 10000;

// A pathological batch could open thousands of documents in one day. Beyond this
// many distinct identifiers the per-document sets stop growing: the document
// counters stop climbing while the tab counter keeps counting, so the totals stay
// finite without under-reporting opens.
export const MAX_TRACKED_DOCUMENTS = 500;

// The counters latched per document: once a document satisfies the condition it
// stays satisfied for the rest of that UTC day. Latching is what makes these
// "furthest reached" measures instead of "currently at" measures, so scrolling
// back to the top cannot erase a read.
const LATCHED_COUNTERS = Object.freeze(['documents_read', 'readers_scrolled', 'deep_reads']);

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// createReadingActivityCounter accumulates one Zotero session's reading totals.
//
// now is injected so a test can drive the UTC day directly.
export function createReadingActivityCounter({
    now = Date.now,
    maxDocuments = MAX_TRACKED_DOCUMENTS,
    maxCounter = MAX_READING_ACTIVITY_COUNTER,
} = {}) {
    if (typeof now !== 'function') {
        throw new TypeError('A clock function is required');
    }
    const documentLimit = normalizeLimit(maxDocuments);
    const counterLimit = normalizeLimit(maxCounter);

    // The UTC day the counts in hand belong to, and one parked day waiting for
    // its flush. The parked slot exists because a reporter runs on a timer: the
    // increment that crosses midnight may arrive before the flush that closes the
    // previous day, and the two must not be merged.
    let day = utcDayKey(now());
    let counts = emptyCounts();
    let held = null;
    // One set per latched counter, holding the documents that already satisfied
    // it today.
    const latched = new Map(LATCHED_COUNTERS.map(name => [name, new Set()]));
    // Every document seen today, used only to enforce the tracking budget.
    let trackedDocuments = new Set();

    return {
        // A reader tab was created. Every open counts, including reopening the
        // same paper, because the tab is the unit.
        opened({ itemID = '' } = {}) {
            roll();
            counts.readers_opened = bump(counts.readers_opened, 1);
            latch('documents_read', itemID);
        },

        // The document produced a non-zero reading offset. This is what
        // separates "opened and read a little" from "opened and closed".
        scrolled({ itemID = '' } = {}) {
            roll();
            latch('readers_scrolled', itemID);
        },

        // The furthest offset reached at least half of the document. Called on
        // every position save, so it must stay cheap and idempotent.
        deepRead({ itemID = '' } = {}) {
            roll();
            latch('deep_reads', itemID);
        },

        annotationCreated() {
            roll();
            counts.annotations_created = bump(counts.annotations_created, 1);
        },

        exported() {
            roll();
            counts.exports = bump(counts.exports, 1);
        },

        translated() {
            roll();
            counts.translations = bump(counts.translations, 1);
        },

        // True when a flush would carry something. A reporter checks this before
        // opening a request, so an idle session sends nothing at all. It never
        // moves the day: only take() does that.
        pending() {
            return held !== null || hasCounts();
        },

        // The UTC day the held counts belong to.
        currentDay() {
            return day;
        },

        // take returns the accumulated totals tagged with the day they belong to,
        // then starts a fresh set for the current UTC day. It returns null when
        // there is nothing to send.
        //
        // Counts older than yesterday are dropped instead of returned: the
        // service accepts only today and yesterday, so a batch held across a
        // longer outage could never be accepted and a reporter that kept it would
        // retry it forever.
        take() {
            roll();
            const current = utcDayKey(now());
            if (held) {
                const parked = held;
                held = null;
                return isOlderThanYesterday(parked.day, current) ? null : parked;
            }
            if (!hasCounts()) return null;
            const payload = { day, ...counts };
            resetCounts();
            return payload;
        },

        // What take() would send, without consuming it.
        snapshot() {
            roll();
            if (held) return { ...held };
            return { day, ...counts };
        },
    };

    function hasCounts() {
        for (const value of Object.values(counts)) {
            if (value > 0) return true;
        }
        return false;
    }

    // roll parks the current totals when the clock has crossed a UTC day, then
    // starts a fresh set for the new day. Parking rather than merging is what
    // keeps one flush from reporting two days at once.
    function roll() {
        const current = utcDayKey(now());
        if (current === day) return;
        if (hasCounts()) {
            // Only one day can wait. An older parked batch is discarded: it can no
            // longer be accepted, so keeping it would only block this one.
            held = { day, ...counts };
        }
        resetCounts();
        day = current;
    }

    function resetCounts() {
        counts = emptyCounts();
        for (const set of latched.values()) set.clear();
        trackedDocuments = new Set();
    }

    // latch records a document for one counter. The identifier is required: a
    // call without one cannot be attributed to a document, so it is ignored
    // rather than counted, and the caller's bug shows up as a missing increment
    // instead of an inflated document count.
    function latch(name, itemID) {
        const key = normalizeItemID(itemID);
        if (!key) return;
        const set = latched.get(name);
        if (set.has(key)) return;
        if (trackedDocuments.size >= documentLimit && !trackedDocuments.has(key)) {
            // Over the budget: stop attributing new documents. The tab counter
            // above still reflects the open.
            return;
        }
        trackedDocuments.add(key);
        set.add(key);
        counts[name] = bump(counts[name], 1);
    }

    function bump(value, amount) {
        const next = value + amount;
        return next > counterLimit ? counterLimit : next;
    }
}

// shouldReportReadingActivity decides whether the counters may be sent at all.
//
// Two conditions, both required:
//
//   - An account session exists, because the endpoint is authenticated and the
//     counters are attached to that account.
//   - The hosted converter is the selected provider. A reader who switched to
//     their own MinerU or Mistral service did so to stop sending data to Mktero,
//     and reading counts are still data about them. Respecting that choice is
//     the whole point of the check: without it, "I use my own OCR key" would
//     quietly stop being true.
//
// Reading a paper whose PDF already came from MinerU is not the case this
// rejects: those counts were collected while the hosted converter was selected,
// and they are flushed on shutdown.
export function shouldReportReadingActivity({ signedIn, provider }) {
    return Boolean(signedIn) && String(provider || '').trim() === 'mktero';
}

// readingActivityCountersFromPayload trims a payload to exactly the fields the
// server accepts. It exists so a caller cannot widen the wire format by spreading
// a richer object into the request body.
export function readingActivityCountersFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const day = normalizeDayKey(payload.day);
    if (!day) return null;
    return {
        day,
        readers_opened: normalizeCounter(payload.readers_opened),
        documents_read: normalizeCounter(payload.documents_read),
        readers_scrolled: normalizeCounter(payload.readers_scrolled),
        deep_reads: normalizeCounter(payload.deep_reads),
        annotations_created: normalizeCounter(payload.annotations_created),
        exports: normalizeCounter(payload.exports),
        translations: normalizeCounter(payload.translations),
    };
}

// readingActivityDayKey converts an instant to the UTC day key the wire uses. The
// day comes from the UTC representation, so a machine in UTC+8 reports the same
// day the server does for the same instant.
export function readingActivityDayKey(instant) {
    return utcDayKey(instant);
}

// isAcceptableReadingActivityDay reports whether the service would accept the
// day: today or yesterday in UTC. The reporter uses it to drop a batch the server
// is certain to reject.
export function isAcceptableReadingActivityDay(dayKey, now = Date.now()) {
    const day = normalizeDayKey(dayKey);
    if (!day) return false;
    const current = utcDayKey(typeof now === 'function' ? now() : now);
    // A future day is rejected outright. Comparing only "not older than
    // yesterday" would accept one, and a client with a fast clock could then write
    // a day the operator has not reached yet.
    if (day > current) return false;
    return day === current || !isOlderThanYesterday(day, current);
}

function isOlderThanYesterday(dayKey, currentKey) {
    const yesterday = shiftDayKey(currentKey, -1);
    return dayKey < yesterday;
}

function shiftDayKey(dayKey, offsetDays) {
    const [year, month, dayOfMonth] = dayKey.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
    date.setUTCDate(date.getUTCDate() + offsetDays);
    return utcDayKey(date);
}

function utcDayKey(instant) {
    const date = instant instanceof Date ? instant : new Date(Number(instant));
    if (Number.isNaN(date.getTime())) {
        throw new TypeError('A valid instant is required');
    }
    const year = String(date.getUTCFullYear()).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${dayOfMonth}`;
}

function normalizeDayKey(value) {
    const text = String(value || '').trim();
    return DAY_KEY_PATTERN.test(text) ? text : '';
}

function normalizeCounter(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    const integer = Math.floor(number);
    return integer > MAX_READING_ACTIVITY_COUNTER
        ? MAX_READING_ACTIVITY_COUNTER
        : integer;
}

function normalizeItemID(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

function normalizeLimit(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 1) return MAX_TRACKED_DOCUMENTS;
    return Math.floor(number);
}

function emptyCounts() {
    return {
        readers_opened: 0,
        documents_read: 0,
        readers_scrolled: 0,
        deep_reads: 0,
        annotations_created: 0,
        exports: 0,
        translations: 0,
    };
}
