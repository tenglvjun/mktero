import { createMarkdownDocumentService } from './core/markdown-document-service.js';
import { registerReaderToolbar } from './ui/reader-toolbar.js';
import { MarkdownWindowPresenter } from './ui/markdown-window-presenter.js';

const runtime = {
    id: null,
    service: null,
    presenter: null,
    disposeToolbar: null,
};

globalThis.install = async function install() {};

globalThis.startup = async function startup({ id, rootURI }) {
    runtime.id = id;
    await Zotero.uiReadyPromise;

    runtime.service = createMarkdownDocumentService({ zotero: Zotero });
    runtime.presenter = new MarkdownWindowPresenter({
        zotero: Zotero,
        rootURI,
    });
    runtime.disposeToolbar = registerReaderToolbar({
        zotero: Zotero,
        pluginID: id,
        onOpen: openReaderAsMarkdown,
        onError: handleToolbarError,
    });

    Zotero.debug('Mktero: started');
};

globalThis.shutdown = function shutdown() {
    runtime.disposeToolbar?.();
    runtime.presenter?.closeAll();
    runtime.disposeToolbar = null;
    runtime.presenter = null;
    runtime.service = null;
    runtime.id = null;
};

globalThis.uninstall = async function uninstall() {};
globalThis.onMainWindowLoad = function onMainWindowLoad() {};
globalThis.onMainWindowUnload = function onMainWindowUnload() {};

async function openReaderAsMarkdown(reader) {
    const presentation = runtime.presenter.open(reader.itemID);
    if (!presentation.created) return;

    try {
        const result = await runtime.service.convert(reader.itemID, {
            onProgress(progress) {
                runtime.presenter?.update(presentation, {
                    status: 'loading',
                    progress: normalizeProgress(progress),
                });
            },
        });
        runtime.presenter?.update(presentation, {
            ...result,
            status: 'ready',
            progress: 100,
        });
    }
    catch (error) {
        Zotero.logError(error);
        runtime.presenter?.update(presentation, {
            status: 'error',
            error: userFacingError(error),
        });
    }
}

function handleToolbarError(error) {
    Zotero.logError(error);
    const owner = Zotero.getMainWindow?.();
    owner?.alert?.(`Mktero: ${userFacingError(error)}`);
}

function normalizeProgress(progress) {
    const value = Number(progress);
    if (!Number.isFinite(value)) return 0;
    return Math.min(100, Math.max(0, Math.round(value)));
}

function userFacingError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no extractable text/i.test(message)) {
        return 'This PDF has no extractable text. A scanned PDF may require OCR.';
    }
    return message || 'PDF conversion failed.';
}
