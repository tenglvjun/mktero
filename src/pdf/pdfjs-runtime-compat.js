// PDF.js 6 assumes these APIs even in its legacy build; Zotero 7 uses Firefox 115.
export function installPDFJSPromiseCapability(PromiseType = globalThis.Promise) {
    if (typeof PromiseType.withResolvers === 'function') return;
    Object.defineProperty(PromiseType, 'withResolvers', {
        configurable: true,
        writable: true,
        value: function withResolvers() {
            let resolve;
            let reject;
            const promise = new this((onResolve, onReject) => {
                resolve = onResolve;
                reject = onReject;
            });
            return { promise, resolve, reject };
        },
    });
}

installPDFJSPromiseCapability();

export function installPDFJSArrayBufferTransfer(BufferType = globalThis.ArrayBuffer) {
    if (typeof BufferType.prototype.transferToFixedLength === 'function') return;
    const byteLength = Object.getOwnPropertyDescriptor(BufferType.prototype, 'byteLength').get;
    Object.defineProperty(BufferType.prototype, 'transferToFixedLength', {
        configurable: true,
        writable: true,
        value: function transferToFixedLength(newLength) {
            const currentLength = byteLength.call(this);
            const numericLength = newLength === undefined ? currentLength : +newLength;
            const length = Number.isNaN(numericLength) ? 0 : Math.trunc(numericLength);
            if (!Number.isSafeInteger(length) || length < 0) throw new RangeError('Invalid buffer length');
            const source = new Uint8Array(this);
            const result = new BufferType(length);
            new Uint8Array(result).set(source.subarray(0, length));
            globalThis.structuredClone(this, { transfer: [this] });
            return result;
        },
    });
}

installPDFJSArrayBufferTransfer();
