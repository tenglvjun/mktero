export class TranslationRequestTracker {
    constructor({ createAbortController }) {
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        this.createAbortController = createAbortController;
        this.requests = new Map();
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
