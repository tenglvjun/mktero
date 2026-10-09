const DEFAULT_QUEUE_ID = 'mktero-prepare';
const STYLE_RETRY_MS = 0;
// openDialog returns before the XUL document exists. A single 0ms turn is
// not enough to see progress-queue-root, so custom queues keep looking.
const CLAIM_RETRY_MS = 50;
const CLAIM_ATTEMPTS = 40;
const cancelListeners = new Map();

export function createZoteroConversionProgress({
    zotero,
    services = globalThis.Services,
    title = 'Preparing Markdown',
    onCancel = null,
    schedule = defaultSchedule,
    queueID = DEFAULT_QUEUE_ID,
} = {}) {
    const queues = zotero?.ProgressQueues;
    const statuses = zotero?.ProgressQueue;
    if (typeof queues?.create !== 'function'
        || typeof queues.get !== 'function'
        || !statuses) {
        return null;
    }

    let queue = queues.get(queueID);
    if (!queue) {
        queue = queues.create({
            id: queueID,
            // The dialog resolves these through Zotero's own string bundle.
            title: 'general.processing',
            columns: ['itemFields.title', 'general.processing'],
        });
    }
    bindCancelListener(queue, onCancel);

    const dialog = queue.getDialog?.();
    return {
        statuses: {
            queued: statuses.ROW_QUEUED,
            processing: statuses.ROW_PROCESSING,
            failed: statuses.ROW_FAILED,
            succeeded: statuses.ROW_SUCCEEDED,
        },
        add(itemID, itemTitle) {
            queue.addRow({
                id: itemID,
                getDisplayTitle: () => itemTitle || 'PDF',
            });
        },
        update(itemID, status, message) {
            queue.updateRow(itemID, status, message || '');
        },
        remove(itemID) {
            queue.deleteRow?.(itemID);
        },
        setStatus(message) {
            dialog?.setStatus?.(message || '');
        },
        open() {
            const before = listProgressWindows(services);
            dialog?.open?.();
            bindQueueWindow({
                services,
                before,
                queueID,
                title,
                schedule,
            });
        },
        cancel() {
            try {
                queue.cancel();
            }
            catch {
                // Shutdown still aborts the batch if the dialog is already gone.
            }
        },
    };
}

export function signalProgressAlreadyRunning({
    running = false,
    progress = null,
    message = '',
    ensureProgress = null,
} = {}) {
    if (!running) {
        return { ignored: false, signaled: false, createdProgress: false };
    }
    // The first batch owns the controller before resolveVault, and the
    // progress object is created only after a vault is chosen. A second
    // batch in that gap must still open a status line.
    const createdProgress = !progress;
    const target = progress || (
        typeof ensureProgress === 'function' ? ensureProgress() : null
    );
    if (target) {
        target.setStatus?.(message || '');
        if (createdProgress) target.open?.();
    }
    return {
        ignored: true,
        signaled: Boolean(target),
        createdProgress,
    };
}

export function installZoteroConversionProgressButton({
    zotero,
    window,
    services = globalThis.Services,
    title = 'Preparing Markdown',
    iconURL = '',
    queueID = DEFAULT_QUEUE_ID,
    schedule = defaultSchedule,
} = {}) {
    const document = window?.document;
    const box = document?.getElementById?.('zotero-pq-buttons');
    const buttonID = `zotero-tb-pq-${queueID}`;
    const queue = zotero?.ProgressQueues?.get?.(queueID);
    if (!box || !queue || typeof queue.addListener !== 'function') return null;

    document.getElementById(buttonID)?.remove();
    const button = document.createXULElement?.('toolbarbutton')
        || document.createElement('toolbarbutton');
    button.id = buttonID;
    button.setAttribute('tooltiptext', title);
    button.setAttribute('aria-label', title);
    if (iconURL) button.setAttribute('image', iconURL);
    const openDialog = () => {
        const dialog = zotero.ProgressQueues.get(queueID)?.getDialog?.();
        const before = listProgressWindows(services);
        dialog?.open?.();
        bindQueueWindow({
            services,
            before,
            queueID,
            title,
            schedule,
        });
    };
    const show = () => {
        button.hidden = false;
    };
    const hide = () => {
        button.hidden = true;
    };
    button.addEventListener('command', openDialog);
    queue.addListener('nonempty', show);
    queue.addListener('empty', hide);
    button.hidden = Number(queue.getTotal?.() || 0) < 1;
    box.appendChild(button);

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        queue.removeListener?.('nonempty', show);
        queue.removeListener?.('empty', hide);
        button.removeEventListener('command', openDialog);
        button.remove();
    };
}

function bindCancelListener(queue, onCancel) {
    const previous = cancelListeners.get(queue);
    if (previous && typeof queue.removeListener === 'function') {
        queue.removeListener('cancel', previous);
        cancelListeners.delete(queue);
    }
    if (typeof onCancel !== 'function' || typeof queue.addListener !== 'function') {
        return;
    }
    const listener = () => {
        try {
            onCancel();
        }
        catch {
            // Cancelling the window must not throw back into Zotero.
        }
    };
    cancelListeners.set(queue, listener);
    queue.addListener('cancel', listener);
}

function bindQueueWindow(state) {
    const attempt = state.attempt || 0;
    markOwnedProgressWindows(state.services, state.before, state.queueID);
    retitle(state.services, state.title, state.queueID);
    const claimed = state.queueID === DEFAULT_QUEUE_ID
        || hasClaimedWindow(state.services, state.queueID);
    const next = nextClaimAttempt(state, attempt, claimed);
    if (!next) return;
    state.schedule(() => bindQueueWindow(next), next.delay);
}

function nextClaimAttempt(state, attempt, claimed) {
    if (state.queueID === DEFAULT_QUEUE_ID) {
        if (attempt >= 1) return null;
        return { ...state, attempt: attempt + 1, delay: STYLE_RETRY_MS };
    }
    if (claimed) {
        // onload sets the localized processing title and can run after the
        // first successful claim. Reapply once, then stop.
        if (state.reapplied) return null;
        return {
            ...state,
            attempt: attempt + 1,
            reapplied: true,
            delay: STYLE_RETRY_MS,
        };
    }
    if (attempt >= CLAIM_ATTEMPTS - 1) return null;
    return {
        ...state,
        attempt: attempt + 1,
        delay: CLAIM_RETRY_MS,
    };
}

function listProgressWindows(services) {
    const found = [];
    if (typeof services?.wm?.getEnumerator !== 'function') return found;
    let windows;
    try {
        windows = services.wm.getEnumerator(null);
    }
    catch {
        return found;
    }
    try {
        while (windows.hasMoreElements()) {
            try {
                const win = windows.getNext();
                const root = win?.document?.getElementById?.('progress-queue-root');
                if (root) found.push({ win, root });
            }
            catch {
                // openDialog can enumerate a window before its document exists.
            }
        }
    }
    catch {
        // A missing window manager must not affect preparation.
    }
    return found;
}

function markOwnedProgressWindows(services, before, queueID) {
    if (queueID === DEFAULT_QUEUE_ID) return;
    const seen = new Set((before || []).map(entry => entry.win));
    const entries = listProgressWindows(services);
    for (const entry of entries) {
        if (progressWindowOwner(entry.win, entry.root) === queueID) {
            markRoot(entry.root, queueID);
        }
    }
    // A dialog that has not loaded window.arguments yet can only be claimed
    // when it is the single new progress window. Guessing among several new
    // windows would let preparation and export mark each other.
    const unmarkedNew = entries.filter(entry => (
        !seen.has(entry.win) && !progressWindowOwner(entry.win, entry.root)
    ));
    if (unmarkedNew.length === 1) markRoot(unmarkedNew[0].root, queueID);
}

function hasClaimedWindow(services, queueID) {
    return listProgressWindows(services).some(entry => (
        progressWindowOwner(entry.win, entry.root) === queueID
        && entry.root?.getAttribute?.('data-mktero-queue') === queueID
    ));
}

function progressWindowOwner(win, root) {
    if (typeof root?.getAttribute === 'function') {
        const marked = root.getAttribute('data-mktero-queue') || '';
        if (marked) return marked;
    }
    try {
        const id = win?.arguments?.[0]?.progressQueue?.getID?.();
        return typeof id === 'string' ? id : '';
    }
    catch {
        return '';
    }
}

function markRoot(root, queueID) {
    if (typeof root?.setAttribute !== 'function') return;
    const marked = root.getAttribute?.('data-mktero-queue') || '';
    if (marked && marked !== queueID) return;
    root.setAttribute('data-mktero-queue', queueID);
}

function retitle(services, title, queueID = DEFAULT_QUEUE_ID) {
    if (!title) return;
    // A window already claimed by another queue, or whose dialog arguments
    // name another queue, must keep its own title. Unmarked windows with no
    // queue id stay with the original prepare queue.
    for (const { win, root } of listProgressWindows(services)) {
        const owner = progressWindowOwner(win, root);
        if (owner && owner !== queueID) continue;
        if (!owner && queueID !== DEFAULT_QUEUE_ID) continue;
        if (queueID !== DEFAULT_QUEUE_ID) markRoot(root, queueID);
        win.document.title = title;
    }
}

function defaultSchedule(callback, delay) {
    const timer = globalThis.setTimeout;
    if (typeof timer === 'function') timer(callback, delay);
    else callback();
}
