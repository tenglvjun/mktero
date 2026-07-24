import {
    getMinerUApiKey,
    openMinerUPreferences,
    registerMinerUPreferencesPane,
} from './config/mineru-preferences.js';
import { MarkdownDocumentService } from './core/markdown-document-service.js';
import {
    MinerUConfigurationError,
    MinerUDocumentExtractor,
} from './extractors/mineru-extractor.js';
import { MinerUClient } from './mineru/mineru-client.js';
import { registerReaderToolbar } from './ui/reader-toolbar.js';
import { MarkdownTabPresenter } from './ui/markdown-tab-presenter.js';

const runtime = {
    id: null,
    service: null,
    presenter: null,
    preferencePaneID: null,
    disposeToolbar: null,
    controllers: new Map(),
};

globalThis.install = async function install() {};

globalThis.startup = async function startup({ id, rootURI }) {
    runtime.id = id;
    runtime.presenter = new MarkdownTabPresenter({
        zotero: Zotero,
        rootURI,
    });
    const presenter = runtime.presenter;
    await Zotero.uiReadyPromise;
    if (runtime.presenter !== presenter) return;

    runtime.service = new MarkdownDocumentService({
        extractor: new MinerUDocumentExtractor({
            zotero: Zotero,
            client: new MinerUClient(),
            getApiKey: () => getMinerUApiKey(Zotero),
            readFile: path => IOUtils.read(path),
        }),
    });
    presenter.ensureSessionStateFilter();
    const preferencePaneID = await registerMinerUPreferencesPane({
        zotero: Zotero,
        pluginID: id,
        rootURI,
    });
    if (runtime.presenter !== presenter) {
        Zotero.PreferencePanes.unregister?.(preferencePaneID);
        return;
    }
    runtime.preferencePaneID = preferencePaneID;
    runtime.disposeToolbar = registerReaderToolbar({
        zotero: Zotero,
        pluginID: id,
        onOpen: openReaderAsMarkdown,
        onError: handleToolbarError,
    });

    Zotero.debug('Mktero: started');
};

globalThis.shutdown = function shutdown() {
    abortAllConversions();
    runtime.disposeToolbar?.();
    runtime.presenter?.dispose();
    if (runtime.preferencePaneID) {
        Zotero.PreferencePanes.unregister?.(runtime.preferencePaneID);
    }
    runtime.disposeToolbar = null;
    runtime.presenter = null;
    runtime.service = null;
    runtime.preferencePaneID = null;
    runtime.id = null;
};

globalThis.uninstall = async function uninstall() {};
globalThis.onMainWindowLoad = function onMainWindowLoad() {};
globalThis.onMainWindowUnload = function onMainWindowUnload() {};

async function openReaderAsMarkdown(reader) {
    const itemID = reader.itemID;
    const presentation = runtime.presenter.open(itemID, {
        onClose: () => abortConversion(itemID),
    });
    if (!presentation.created && presentation.model.status !== 'error') return;

    abortConversion(itemID);
    const controller = new AbortController();
    runtime.controllers.set(itemID, controller);
    runtime.presenter.update(presentation, {
        status: 'loading',
        progress: 0,
        markdown: '',
        assets: [],
        assetBasePath: '',
        warnings: [],
        error: '',
    });

    try {
        const result = await runtime.service.convert(itemID, {
            signal: controller.signal,
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
        if (controller.signal.aborted) return;
        Zotero.logError(error);
        if (error instanceof MinerUConfigurationError
            || error?.code === 'MINERU_API_KEY_INVALID') {
            openMinerUPreferences(Zotero);
        }
        runtime.presenter?.update(presentation, {
            status: 'error',
            error: userFacingError(error),
        });
    }
    finally {
        if (runtime.controllers.get(itemID) === controller) {
            runtime.controllers.delete(itemID);
        }
    }
}

function abortConversion(itemID) {
    const controller = runtime.controllers.get(itemID);
    if (!controller) return;
    runtime.controllers.delete(itemID);
    controller.abort();
}

function abortAllConversions() {
    for (const controller of runtime.controllers.values()) {
        controller.abort();
    }
    runtime.controllers.clear();
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
    if (error instanceof MinerUConfigurationError) {
        return 'Configure a MinerU API Token in Settings → Mktero, then try again.';
    }
    if (error?.code === 'MINERU_API_KEY_INVALID') {
        return 'The MinerU API Token is invalid or expired. Update it in Settings → Mktero.';
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/no extractable text/i.test(message)) {
        return 'This PDF has no extractable text. A scanned PDF may require OCR.';
    }
    return message || 'PDF conversion failed.';
}
