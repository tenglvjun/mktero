const QUEUE_ID = 'mktero-prepare';
const BUTTON_ID = `zotero-tb-pq-${QUEUE_ID}`;
const STYLE_RETRY_MS = 0;
const cancelListeners = new Map();

export function createZoteroConversionProgress({
    zotero,
    services = globalThis.Services,
    title = 'Preparing Markdown',
    onCancel = null,
    schedule = defaultSchedule,
} = {}) {
    const queues = zotero?.ProgressQueues;
    const statuses = zotero?.ProgressQueue;
    if (typeof queues?.create !== 'function'
        || typeof queues.get !== 'function'
        || !statuses) {
        return null;
    }

    let queue = queues.get(QUEUE_ID);
    if (!queue) {
        queue = queues.create({
            id: QUEUE_ID,
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
            const applyTitle = () => retitle(services, title);
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
} = {}) {
    const document = window?.document;
    const box = document?.getElementById?.('zotero-pq-buttons');
    const queue = zotero?.ProgressQueues?.get?.(QUEUE_ID);
    if (!box || !queue || typeof queue.addListener !== 'function') return null;

    document.getElementById(BUTTON_ID)?.remove();
    const button = document.createXULElement?.('toolbarbutton')
        || document.createElement('toolbarbutton');
    button.id = BUTTON_ID;
    button.setAttribute('tooltiptext', title);
    button.setAttribute('aria-label', title);
    if (iconURL) button.setAttribute('image', iconURL);
    const openDialog = () => {
        zotero.ProgressQueues.get(QUEUE_ID)?.getDialog?.()?.open?.();
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

function retitle(services, title) {
    if (!title || typeof services?.wm?.getEnumerator !== 'function') return;
    try {
        const windows = services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
            const win = windows.getNext();
            const root = win?.document?.getElementById?.('progress-queue-root');
            if (!root) continue;
            win.document.title = title;
        }
    }
    catch {
        // A missing window manager must not affect preparation.
    }
}

function defaultSchedule(callback, delay) {
    const timer = globalThis.setTimeout;
    if (typeof timer === 'function') timer(callback, delay);
    else callback();
}
