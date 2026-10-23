// Windows allows one process at a time to open the clipboard. Firefox tries
// OleSetClipboard three times over about 9 ms, then reports success even when
// every try failed (widget/windows/nsClipboard.cpp). A copy made while another
// program holds the clipboard therefore leaves the previous content in place
// with no error, and the reader has to press Ctrl+C again. This reads the
// clipboard back after a copy and writes the copied text again until the
// clipboard holds it, or reports a failure the reader can see.

// Each check reads the clipboard and, on a miss, writes it again. A program
// that holds the clipboard most of the time leaves short free windows, so the
// checks are frequent at first and the whole run stays near two seconds.
export const VERIFY_DELAYS_MS = Object.freeze([40, 80, 120, 160, 240, 320, 480, 640]);

export const COPY_DELIVERED = 'delivered';
export const COPY_REPAIRED = 'repaired';
export const COPY_FAILED = 'failed';
export const COPY_CANCELLED = 'cancelled';
export const COPY_SKIPPED = 'skipped';

const UNREADABLE = Symbol('unreadable');

export function createCopyDelivery({
    readText,
    writeText,
    setTimeout,
    clearTimeout,
    isActive = () => true,
    verifyDelays = VERIFY_DELAYS_MS,
}) {
    if (typeof readText !== 'function' || typeof writeText !== 'function') {
        throw new TypeError('Copy delivery needs clipboard read and write');
    }
    if (typeof setTimeout !== 'function') {
        throw new TypeError('Copy delivery needs a timer');
    }
    let generation = 0;
    let pendingWait = null;

    const cancel = () => {
        generation += 1;
        const wait = pendingWait;
        pendingWait = null;
        if (!wait) return;
        try {
            clearTimeout?.(wait.timer);
        }
        catch {
            // An unloading Zotero window's timer functions can throw. The
            // wait is released below either way, and a late timer finds the
            // delivery stale.
        }
        wait.resolve();
    };

    const wait = delay => new Promise(resolve => {
        const entry = { resolve, timer: null };
        entry.timer = setTimeout(() => {
            if (pendingWait === entry) pendingWait = null;
            resolve();
        }, delay);
        pendingWait = entry;
    });

    // Firefox reports a clipboard that another program holds as one with no
    // text (null), the same as a miss, so the copy is written again. A read
    // that throws means the clipboard service itself is unavailable; that
    // says nothing about the copy, and writing would not help either.
    const read = async () => {
        try {
            const value = await readText();
            return typeof value === 'string' ? value : null;
        }
        catch {
            return UNREADABLE;
        }
    };

    const write = async text => {
        try {
            await writeText(text);
            return true;
        }
        catch {
            return false;
        }
    };

    // `exact` is true when the copy handler supplied the text itself, so the
    // clipboard must hold exactly that. Text Firefox serialized from a DOM
    // selection is compared with collapsed whitespace instead.
    const deliver = async ({ text, exact = false, writeFirst = false } = {}) => {
        cancel();
        if (typeof text !== 'string' || !text.trim()) return COPY_SKIPPED;
        const current = generation;
        const stale = () => current !== generation || !isActive();
        let rewritten = false;
        if (writeFirst) {
            if (stale()) return COPY_CANCELLED;
            rewritten = await write(text);
        }
        for (let index = 0; index < verifyDelays.length; index += 1) {
            await wait(verifyDelays[index]);
            if (stale()) return COPY_CANCELLED;
            const observed = await read();
            if (stale()) return COPY_CANCELLED;
            if (observed !== UNREADABLE
                && clipboardTextMatches(observed, text, { exact })) {
                return rewritten ? COPY_REPAIRED : COPY_DELIVERED;
            }
            const last = index === verifyDelays.length - 1;
            if (observed === UNREADABLE || last) continue;
            rewritten = await write(text) || rewritten;
        }
        return COPY_FAILED;
    };

    return { deliver, cancel };
}

export function clipboardTextMatches(observed, expected, { exact = false } = {}) {
    if (typeof observed !== 'string' || typeof expected !== 'string') {
        return false;
    }
    if (exact) return normalizeLineBreaks(observed) === normalizeLineBreaks(expected);
    return collapseWhitespace(observed) === collapseWhitespace(expected);
}

function normalizeLineBreaks(value) {
    return value.replace(/\r\n?/g, '\n');
}

function collapseWhitespace(value) {
    return value.replace(/\s+/g, ' ').trim();
}
