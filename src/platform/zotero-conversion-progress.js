const DEFAULT_QUEUE_ID = 'mktero-prepare';
const STYLE_RETRY_MS = 0;
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
            const applyTitle = () => {
                markNewProgressWindows(services, before, queueID);
                retitle(services, title, queueID);
            };
            applyTitle();
            schedule(applyTitle, STYLE_RETRY_MS);
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

export function installZoteroConversionProgressButton({
    zotero,
    window,
    title = 'Preparing Markdown',
    iconURL = '',
    queueID = DEFAULT_QUEUE_ID,
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
        zotero.ProgressQueues.get(queueID)?.getDialog?.()?.open?.();
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

function listProgressWindows(services) {
    const found = [];
    if (typeof services?.wm?.getEnumerator !== 'function') return found;
    try {
        const windows = services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            const win = windows.getNext();
            const root = win?.document?.getElementById?.('progress-queue-root');
            if (root) found.push({ win, root });
        }
    }
    catch {
        // A missing window manager must not affect preparation.
    }
    return found;
}

function markNewProgressWindows(services, before, queueID) {
    const seen = new Set((before || []).map(entry => entry.win));
    for (const entry of listProgressWindows(services)) {
        if (seen.has(entry.win)) continue;
        if (typeof entry.root?.setAttribute !== 'function') continue;
        if (entry.root.getAttribute?.('data-mktero-queue')) continue;
        entry.root.setAttribute('data-mktero-queue', queueID);
    }
}

function retitle(services, title, queueID = DEFAULT_QUEUE_ID) {
    if (!title) return;
    // A window already claimed by another queue must keep its own title.
    // Unmarked windows stay with the original prepare queue.
    for (const { win, root } of listProgressWindows(services)) {
        const marked = typeof root?.getAttribute === 'function'
            ? root.getAttribute('data-mktero-queue') || ''
            : '';
        if (marked && marked !== queueID) continue;
        if (!marked && queueID !== DEFAULT_QUEUE_ID) continue;
        win.document.title = title;
    }
}

function defaultSchedule(callback, delay) {
    const timer = globalThis.setTimeout;
    if (typeof timer === 'function') timer(callback, delay);
    else callback();
}
