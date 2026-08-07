import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('extracts PDF text when worker globals only exist on the Zotero window', async () => {
    await fetch('data:text/plain,ready');
    const NativeAbortController = globalThis.AbortController;
    const NativeAbortSignal = globalThis.AbortSignal;
    const NativeReadableStream = globalThis.ReadableStream;
    const nativeStructuredClone = globalThis.structuredClone;
    const previousZotero = globalThis.Zotero;
    delete globalThis.AbortController;
    delete globalThis.AbortSignal;
    delete globalThis.ReadableStream;
    delete globalThis.structuredClone;
    globalThis.Zotero = {
        getMainWindow: () => ({
            AbortController: NativeAbortController,
            AbortSignal: NativeAbortSignal,
            ReadableStream: NativeReadableStream,
            structuredClone: nativeStructuredClone,
        }),
    };

    try {
        const { createPDFJSTextEngine } = await import(
            '../src/pdf/pdfjs-text-engine.js?zotero-abort-controller'
        );
        const fileData = new Uint8Array(await readFile(
            new URL('./fixtures/offline-annotation.pdf', import.meta.url)
        ));
        const engine = createPDFJSTextEngine({
            workerSrc: 'jar:file:///tmp/mktero.xpi!/pdf.worker.mjs',
        });

        try {
            const index = await engine.extract(fileData);

            assert.equal(
                index.pages[0].rawText,
                'Ovulation limits (±2 days)'
            );
        }
        finally {
            await engine.dispose();
        }
    }
    finally {
        globalThis.AbortController = NativeAbortController;
        globalThis.AbortSignal = NativeAbortSignal;
        globalThis.ReadableStream = NativeReadableStream;
        globalThis.structuredClone = nativeStructuredClone;
        if (previousZotero === undefined) delete globalThis.Zotero;
        else globalThis.Zotero = previousZotero;
    }
});
