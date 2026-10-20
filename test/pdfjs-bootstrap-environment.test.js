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

test('adopts Path2D from the Zotero window for PDF.js rendering', async () => {
    const previousPath2D = globalThis.Path2D;
    function WindowPath2D() {}
    const { adoptPDFJSWindowGlobals } = await import(
        '../src/pdf/pdfjs-bootstrap-environment.js?path2d'
    );
    try {
        adoptPDFJSWindowGlobals({ Path2D: WindowPath2D });
        assert.equal(globalThis.Path2D, WindowPath2D);
    }
    finally {
        if (previousPath2D === undefined) delete globalThis.Path2D;
        else globalThis.Path2D = previousPath2D;
    }
});

test('adopts document and FontFace so PDF.js can load standard fonts', async () => {
    const previousDocument = globalThis.document;
    const previousFontFace = globalThis.FontFace;
    function WindowFontFace() {}
    const fakeDocument = { fonts: new Set() };
    const { adoptPDFJSWindowGlobals } = await import(
        '../src/pdf/pdfjs-bootstrap-environment.js?fonts'
    );
    try {
        delete globalThis.document;
        delete globalThis.FontFace;
        adoptPDFJSWindowGlobals({ document: fakeDocument, FontFace: WindowFontFace });
        assert.equal(globalThis.document, fakeDocument);
        assert.equal(globalThis.FontFace, WindowFontFace);
    }
    finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
        if (previousFontFace === undefined) delete globalThis.FontFace;
        else globalThis.FontFace = previousFontFace;
    }
});

test('bridges session-long PDF.js globals from the hidden DOM window first', async () => {
    const NativeAbortController = globalThis.AbortController;
    const NativeAbortSignal = globalThis.AbortSignal;
    const nativeStructuredClone = globalThis.structuredClone;
    const previousZotero = globalThis.Zotero;
    const previousServices = globalThis.Services;
    delete globalThis.AbortController;
    delete globalThis.AbortSignal;
    delete globalThis.structuredClone;
    // The startup main window can close while Zotero keeps running on macOS;
    // a structuredClone bound to it would then throw.
    const mainWindow = {
        AbortController: class ClosedWindowAbortController {},
        AbortSignal: class ClosedWindowAbortSignal {},
        structuredClone() { throw new Error('NS_ERROR_NOT_INITIALIZED'); },
    };
    globalThis.Zotero = { getMainWindow: () => mainWindow };
    globalThis.Services = { appShell: { hiddenDOMWindow: {
        AbortController: NativeAbortController,
        AbortSignal: NativeAbortSignal,
        structuredClone: nativeStructuredClone,
    } } };

    try {
        await import('../src/pdf/pdfjs-bootstrap-environment.js?hidden-window');
        assert.equal(globalThis.AbortController, NativeAbortController);
        assert.equal(globalThis.AbortSignal, NativeAbortSignal);
        assert.deepEqual(globalThis.structuredClone({ page: 1 }), { page: 1 });
    }
    finally {
        globalThis.AbortController = NativeAbortController;
        globalThis.AbortSignal = NativeAbortSignal;
        globalThis.structuredClone = nativeStructuredClone;
        if (previousZotero === undefined) delete globalThis.Zotero;
        else globalThis.Zotero = previousZotero;
        if (previousServices === undefined) delete globalThis.Services;
        else globalThis.Services = previousServices;
    }
});
