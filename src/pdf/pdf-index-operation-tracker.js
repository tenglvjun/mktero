export class PDFIndexOperationTracker {
    constructor() {
        this.operations = new Map();
    }

    start(itemID, controller) {
        validateItemID(itemID);
        validateController(controller);
        this.abort(itemID);
        this.operations.set(itemID, {
            controller,
            conversionFinished: false,
            indexTask: null,
        });
    }

    track(itemID, signal, task) {
        const operation = this.operations.get(itemID);
        if (!operation || operation.controller.signal !== signal) return task;
        const pending = Promise.resolve(task);
        operation.indexTask = pending;
        void pending.finally(() => {
            if (operation.indexTask === pending) operation.indexTask = null;
            this.#releaseCompleted(itemID, operation);
        }).catch(() => {});
        return pending;
    }

    finish(itemID, controller) {
        const operation = this.operations.get(itemID);
        if (!operation || operation.controller !== controller) return;
        operation.conversionFinished = true;
        this.#releaseCompleted(itemID, operation);
    }

    abort(itemID) {
        const operation = this.operations.get(itemID);
        if (!operation) return;
        this.operations.delete(itemID);
        operation.controller.abort();
    }

    abortAll() {
        for (const operation of this.operations.values()) {
            operation.controller.abort();
        }
        this.operations.clear();
    }

    #releaseCompleted(itemID, operation) {
        if (this.operations.get(itemID) === operation
            && operation.conversionFinished
            && !operation.indexTask) {
            this.operations.delete(itemID);
        }
    }
}

function validateItemID(itemID) {
    if (!Number.isSafeInteger(itemID) || itemID <= 0) {
        throw new TypeError('A PDF item ID is required');
    }
}

function validateController(controller) {
    if (!controller?.signal || typeof controller.abort !== 'function') {
        throw new TypeError('An AbortController is required');
    }
}
