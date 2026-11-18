export class TranslationRequestTracker {
    constructor({ createAbortController }) {
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        this.createAbortController = createAbortController;
        this.requests = new Map();
        this.queues = new WeakMap();
    }

    async run(documentID, blockID, operation) {
        validateIdentifier(documentID, 'A translation document ID is required');
        validateIdentifier(blockID, 'A translation block ID is required');
        if (typeof operation !== 'function') {
            throw new TypeError('A translation operation is required');
        }
        this.cancelBlock(documentID, blockID);
        const controller = this.createAbortController();
        validateController(controller);
        const requests = this.#requestsForDocument(documentID);
        requests.set(blockID, controller);
        try {
            return await operation(controller.signal);
        }
        finally {
            if (requests.get(blockID) === controller) requests.delete(blockID);
            if (!requests.size && this.requests.get(documentID) === requests) {
                this.requests.delete(documentID);
            }
        }
    }

    cancelBlock(documentID, blockID) {
        const requests = this.requests.get(documentID);
        const controller = requests?.get(blockID);
        if (!controller) return false;
        requests.delete(blockID);
        controller.abort();
        if (!requests.size) this.requests.delete(documentID);
        return true;
    }

    // Each upgrade replaces a document-sized record. Read its baseline only
    // after the preceding upgrade commits, while sharing duplicate clicks.
    enqueue(documentID, group, itemID, operation, signal) {
        validateIdentifier(itemID, 'A translation block ID is required');
        const requests = this.#requestsForDocument(documentID);
        let controller = requests.get(group);
        if (!controller) {
            controller = this.createAbortController();
            validateController(controller);
            requests.set(group, controller);
            this.queues.set(controller, { items: new Map(), tail: Promise.resolve() });
        }
        const queue = this.queues.get(controller);
        if (!queue) throw new Error('Translation request group is already in use');
        if (queue.items.has(itemID)) return queue.items.get(itemID);
        const item = this.createAbortController();
        const abort = () => item.abort();
        for (const input of [controller.signal, signal]) {
            if (input?.aborted) abort();
            else input?.addEventListener('abort', abort, { once: true });
        }
        const result = queue.tail.then(() => {
            if (item.signal.aborted) {
                throw Object.assign(new Error('Translation canceled'), { name: 'AbortError' });
            }
            return operation(item.signal);
        }).finally(() => {
            controller.signal.removeEventListener('abort', abort);
            signal?.removeEventListener('abort', abort);
            queue.items.delete(itemID);
            if (!queue.items.size && requests.get(group) === controller) {
                requests.delete(group);
                if (!requests.size && this.requests.get(documentID) === requests) {
                    this.requests.delete(documentID);
                }
            }
        });
        queue.items.set(itemID, result);
        queue.tail = result.catch(() => {});
        return result;
    }

    cancelDocument(documentID) {
        const requests = this.requests.get(documentID);
        if (!requests) return false;
        this.requests.delete(documentID);
        for (const controller of requests.values()) controller.abort();
        requests.clear();
        return true;
    }

    abortAll() {
        const requestsByDocument = this.requests;
        this.requests = new Map();
        for (const requests of requestsByDocument.values()) {
            for (const controller of requests.values()) controller.abort();
            requests.clear();
        }
    }

    #requestsForDocument(documentID) {
        let requests = this.requests.get(documentID);
        if (!requests) {
            requests = new Map();
            this.requests.set(documentID, requests);
        }
        return requests;
    }
}

function validateIdentifier(value, message) {
    if (value === null || value === undefined || String(value) === '') {
        throw new TypeError(message);
    }
}

function validateController(controller) {
    if (!controller?.signal || typeof controller.abort !== 'function') {
        throw new TypeError('An AbortController is required');
    }
}
