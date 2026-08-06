import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('extracts PDF text when AbortController only exists on the Zotero window', async () => {
    const NativeAbortController = globalThis.AbortController;
    const previousZotero = globalThis.Zotero;
    delete globalThis.AbortController;
    globalThis.Zotero = {
        getMainWindow: () => ({ AbortController: NativeAbortController }),
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
        if (previousZotero === undefined) delete globalThis.Zotero;
        else globalThis.Zotero = previousZotero;
    }
});
