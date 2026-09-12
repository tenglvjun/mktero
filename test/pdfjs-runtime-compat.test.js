import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installPDFJSPromiseCapability, installPDFJSArrayBufferTransfer } from '../src/pdf/pdfjs-runtime-compat.js';

test('reads actual PDF font operators with the Firefox 115 buffer fallback', async () => {
    const original = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transferToFixedLength');
    delete ArrayBuffer.prototype.transferToFixedLength;
    installPDFJSArrayBufferTransfer();
    try {
        const source = Uint8Array.of(1, 2, 3).buffer;
        assert.deepEqual([...new Uint8Array(source.transferToFixedLength(2))], [1, 2]);
        assert.equal(source.byteLength, 0);
        assert.throws(() => source.transferToFixedLength(), TypeError);
        assert.throws(() => new ArrayBuffer(1).transferToFixedLength(-1), RangeError);
        assert.deepEqual([...new Uint8Array(Uint8Array.of(1).buffer.transferToFixedLength(3))], [1, 0, 0]);
        await import('../src/pdf/pdfjs-bootstrap-environment.js');
        const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const task = getDocument({ data: new Uint8Array(await readFile(
            new URL('./fixtures/figures/compound-figures.pdf', import.meta.url)
        )), verbosity: 0 });
        try {
            const pdf = await task.promise;
            const ops = await (await pdf.getPage(1)).getOperatorList();
            assert.ok(ops.fnArray.includes(OPS.showText));
            assert.ok(ops.fnArray.includes(OPS.constructPath));
        }
        finally { await task.destroy(); }
    }
    finally {
        if (original) Object.defineProperty(ArrayBuffer.prototype, 'transferToFixedLength', original);
        else delete ArrayBuffer.prototype.transferToFixedLength;
    }
});

test('supplies PDF.js promise capabilities on older Zotero runtimes', async () => {
    class LegacyPromise extends Promise {}
    Object.defineProperty(LegacyPromise, 'withResolvers', { value: undefined, configurable: true });
    installPDFJSPromiseCapability(LegacyPromise);
    const resolved = LegacyPromise.withResolvers();
    assert.ok(resolved.promise instanceof LegacyPromise);
    resolved.resolve(42);
    assert.equal(await resolved.promise, 42);
    const rejected = LegacyPromise.withResolvers();
    rejected.reject(new Error('Cancelled render'));
    await assert.rejects(rejected.promise, /Cancelled render/);
    const method = LegacyPromise.withResolvers;
    installPDFJSPromiseCapability(LegacyPromise);
    assert.equal(LegacyPromise.withResolvers, method);
    assert.equal(Object.getOwnPropertyDescriptor(LegacyPromise, 'withResolvers').enumerable, false);
});
