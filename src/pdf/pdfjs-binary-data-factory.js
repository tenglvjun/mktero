// PDF.js 6 reads cMap, standard-font and WASM data through a BinaryDataFactory.
// The extension ships inside an XPI (jar:) URL that neither the worker nor the
// sandbox can fetch, so we feed PDF.js bytes read by the runtime instead.
export function createBinaryDataFactory(readBinaryAsset) {
    if (typeof readBinaryAsset !== 'function') {
        throw new TypeError('A binary asset reader is required');
    }
    return class MkteroBinaryDataFactory {
        // PDF.js constructs the factory with the URL options; ignoring them and
        // using the injected reader keeps the jar/file difference out of PDF.js.
        constructor() {}

        async fetch({ kind, filename }) {
            const data = await readBinaryAsset(kind, filename);
            if (!data || !data.length) {
                throw new Error(`Unable to load ${kind} data: ${filename}`);
            }
            return data instanceof Uint8Array ? data : new Uint8Array(data);
        }
    };
}
