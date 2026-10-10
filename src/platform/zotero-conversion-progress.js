const DEFAULT_QUEUE_ID = 'mktero-prepare';
const STYLE_RETRY_MS = 0;
// openDialog returns before the XUL document exists. A single 0ms turn is
// not enough to see progress-queue-root, so custom queues keep looking.
const CLAIM_RETRY_MS = 50;
const CLAIM_ATTEMPTS = 40;
const cancelListeners = new Map();
const appliedTitles = new WeakMap();

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
            dialog?.open?.();
            bindQueueWindow({
                services,
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

export function resolveAbandonedExportProgressStatus({
    rowsOpened = false,
    progressExisted = false,
    alreadyRunningSignaled = false,
    previousStatus = '',
} = {}) {
    if (rowsOpened) return null;
    // A second click during vault selection overwrites the status before this
    // batch owns any rows. Restore the previous summary when one existed.
    // Clear the notice otherwise. Do not clear a summary this batch did not
    // overwrite, including when a progress object was left by an earlier batch.
    if (alreadyRunningSignaled) return previousStatus || '';
    if (!progressExisted) return '';
    return null;
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
    let active = true;
    let cancelScheduledClaim = () => {};
    const scheduleClaim = (callback, delay) => {
        if (!active) return;
        const cancel = schedule(() => {
            if (!active) return;
            callback();
        }, delay);
        cancelScheduledClaim = typeof cancel === 'function' ? cancel : () => {};
    };
    const openDialog = () => {
        if (!active) return;
        const dialog = zotero.ProgressQueues.get(queueID)?.getDialog?.();
        dialog?.open?.();
        bindQueueWindow({
            services,
            queueID,
            title,
            schedule: scheduleClaim,
            active: () => active,
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

    return () => {
        if (!active) return;
        active = false;
        cancelScheduledClaim();
        cancelScheduledClaim = () => {};
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
    if (typeof state.active === 'function' && !state.active()) return;
    const attempt = state.attempt || 0;
    reconcileProgressMarks(state.services);
    markOwnedProgressWindows(state.services, state.queueID);
    retitle(state.services, state.title, state.queueID);
    const claimed = state.queueID === DEFAULT_QUEUE_ID
        || hasConfirmedQueueWindow(state.services, state.queueID);
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

function markOwnedProgressWindows(services, queueID) {
    if (queueID === DEFAULT_QUEUE_ID) return;
    // Do not guess from "the only new window". A prepare dialog can appear
    // before window.arguments is readable, and a wrong mark makes the prepare
    // queue skip it. Claim only a dialog whose queue id matches.
    for (const entry of listProgressWindows(services)) {
        if (progressWindowQueueID(entry.win) !== queueID) continue;
        correctRootMark(entry.root, queueID);
    }
}

function reconcileProgressMarks(services) {
    for (const entry of listProgressWindows(services)) {
        const real = progressWindowQueueID(entry.win);
        if (!real) continue;
        const marked = markedQueueID(entry.root);
        if (!marked || marked === real) continue;
        correctRootMark(entry.root, real);
        restoreAppliedTitle(entry.win, marked);
    }
}

function hasConfirmedQueueWindow(services, queueID) {
    return listProgressWindows(services).some(entry => (
        progressWindowQueueID(entry.win) === queueID
        && markedQueueID(entry.root) === queueID
    ));
}

function progressWindowOwner(win, root) {
    // A later readable getID() corrects a speculative data-mktero-queue mark.
    const real = progressWindowQueueID(win);
    if (real) return real;
    return markedQueueID(root);
}

function progressWindowQueueID(win) {
    try {
        const id = win?.arguments?.[0]?.progressQueue?.getID?.();
        return typeof id === 'string' ? id : '';
    }
    catch {
        return '';
    }
}

function markedQueueID(root) {
    if (typeof root?.getAttribute !== 'function') return '';
    return root.getAttribute('data-mktero-queue') || '';
}

function correctRootMark(root, queueID) {
    if (!queueID || typeof root?.setAttribute !== 'function') return;
    if (markedQueueID(root) === queueID) return;
    root.setAttribute('data-mktero-queue', queueID);
}

function retitle(services, title, queueID = DEFAULT_QUEUE_ID) {
    if (!title) return;
    // A window already claimed by another queue, or whose dialog arguments
    // name another queue, must keep its own title. Unmarked windows with no
    // queue id stay with the original prepare queue.
    for (const { win, root } of listProgressWindows(services)) {
        const owner = progressWindowOwner(win, root);
        if (owner && owner !== queueID) {
            restoreAppliedTitle(win, queueID);
            continue;
        }
        if (!owner && queueID !== DEFAULT_QUEUE_ID) continue;
        if (queueID !== DEFAULT_QUEUE_ID) correctRootMark(root, queueID);
        applyWindowTitle(win, queueID, title);
    }
}

function applyWindowTitle(win, queueID, title) {
    if (!win?.document) return;
    if (win.document.title === title) return;
    if (!appliedTitles.has(win)) {
        appliedTitles.set(win, {
            queueID,
            title,
            previous: win.document.title,
        });
    }
    win.document.title = title;
}

function restoreAppliedTitle(win, queueID) {
    const applied = appliedTitles.get(win);
    if (!applied || applied.queueID !== queueID) return;
    if (win?.document && win.document.title === applied.title) {
        win.document.title = applied.previous;
    }
    appliedTitles.delete(win);
}

function defaultSchedule(callback, delay) {
    const timer = globalThis.setTimeout;
    if (typeof timer !== 'function') {
        callback();
        return () => {};
    }
    const id = timer(callback, delay);
    return () => {
        globalThis.clearTimeout?.(id);
    };
}
