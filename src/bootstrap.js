import {
    getMinerUCacheEnabled,
    getMinerUApiKey,
    openMinerUPreferences,
    registerMinerUPreferencesPane,
} from './config/mineru-preferences.js';
import {
    createMinerUCacheKey,
    createZoteroMarkdownCache,
} from './cache/markdown-cache.js';
import { MarkdownDocumentService } from './core/markdown-document-service.js';
import {
    CONVERSION_PROGRESS,
    normalizeConversionProgress,
} from './core/conversion-progress.js';
import {
    MinerUConfigurationError,
    MinerUDocumentExtractor,
} from './extractors/mineru-extractor.js';
import { MinerUClient } from './mineru/mineru-client.js';
import { createRuntimeAbortController } from './platform/abort-controller.js';
import { registerReaderToolbar } from './ui/reader-toolbar.js';
import { MarkdownTabPresenter } from './ui/markdown-tab-presenter.js';
import {
    createConversionFailureChanges,
    createConversionLoadingChanges,
    createConversionReadyChanges,
    snapshotReadyResult,
} from './ui/markdown-tab-state.js';

const runtime = {
    id: null,
    service: null,
    presenter: null,
    cache: null,
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

    const cache = createZoteroMarkdownCache({
        zotero: Zotero,
        ioUtils: IOUtils,
        pathUtils: PathUtils,
    });
    runtime.cache = cache;
    runtime.service = new MarkdownDocumentService({
        extractor: new MinerUDocumentExtractor({
            zotero: Zotero,
            client: new MinerUClient({
                createAbortController: createZoteroAbortController,
            }),
            getApiKey: () => getMinerUApiKey(Zotero),
            readFile: path => IOUtils.read(path),
            cache,
            createCacheKey: fileData => createMinerUCacheKey(fileData),
            isCacheEnabled: () => getMinerUCacheEnabled(Zotero),
        }),
    });
    cache.prune().catch(error => Zotero.logError(error));
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
    runtime.cache = null;
    runtime.preferencePaneID = null;
    runtime.id = null;
};

globalThis.uninstall = async function uninstall() {};
globalThis.onMainWindowLoad = function onMainWindowLoad() {};
globalThis.onMainWindowUnload = function onMainWindowUnload() {};

async function openReaderAsMarkdown(reader, { forceRefresh = false } = {}) {
    const itemID = reader.itemID;
    const presentation = runtime.presenter.open(itemID, {
        onClose: () => abortConversion(itemID),
        onReparse: () => openReaderAsMarkdown(reader, { forceRefresh: true }),
    });
    if (!presentation.created
        && presentation.model.status !== 'error'
        && !forceRefresh) return;

    const previousResult = forceRefresh
        ? snapshotReadyResult(presentation.model)
        : null;
    abortConversion(itemID);
    const controller = createZoteroAbortController();
    runtime.controllers.set(itemID, controller);
    Zotero.debug(
        `Mktero: conversion started for item ${itemID} `
        + `(force refresh: ${forceRefresh})`
    );
    runtime.presenter.update(
        presentation,
        createConversionLoadingChanges(previousResult)
    );

    let lastLoggedProgress = null;
    try {
        const result = await runtime.service.convert(itemID, {
            signal: controller.signal,
            forceRefresh,
            onProgress(progress) {
                const normalizedProgress = normalizeConversionProgress(progress);
                if (normalizedProgress !== lastLoggedProgress) {
                    lastLoggedProgress = normalizedProgress;
                    Zotero.debug(
                        `Mktero: item ${itemID}: `
                        + `${conversionProgressLog(normalizedProgress)} `
                        + `(${normalizedProgress}%)`
                    );
                }
                runtime.presenter?.update(presentation, {
                    status: 'loading',
                    progress: normalizedProgress,
                });
            },
        });
        Zotero.debug(
            result.cacheHit
                ? `Mktero: item ${itemID}: completed from local cache; MinerU upload skipped`
                : `Mktero: item ${itemID}: completed through MinerU API`
        );
        runtime.presenter?.update(
            presentation,
            createConversionReadyChanges(result)
        );
    }
    catch (error) {
        if (controller.signal.aborted) return;
        Zotero.debug(
            `Mktero: conversion failed for item ${itemID}: ${userFacingError(error)}`
        );
        Zotero.logError(error);
        if (error instanceof MinerUConfigurationError
            || error?.code === 'MINERU_API_KEY_INVALID') {
            openMinerUPreferences(Zotero);
        }
        runtime.presenter?.update(
            presentation,
            createConversionFailureChanges(userFacingError(error), previousResult)
        );
    }
    finally {
        if (runtime.controllers.get(itemID) === controller) {
            runtime.controllers.delete(itemID);
        }
    }
}

function conversionProgressLog(progress) {
    if (progress >= CONVERSION_PROGRESS.COMPLETE) {
        return 'conversion result available';
    }
    if (progress >= CONVERSION_PROGRESS.DOWNLOADING) {
        return 'MinerU parsing finished; downloading the result';
    }
    if (progress >= CONVERSION_PROGRESS.PARSING) {
        return 'PDF upload completed; MinerU is parsing';
    }
    if (progress >= CONVERSION_PROGRESS.UPLOADING) {
        return 'uploading PDF to MinerU';
    }
    if (progress >= CONVERSION_PROGRESS.PREPARING) {
        return 'requesting a MinerU upload URL';
    }
    return 'preparing the local PDF';
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

function createZoteroAbortController() {
    return createRuntimeAbortController({
        globalObject: globalThis,
        zotero: Zotero,
        services: typeof Services === 'undefined' ? null : Services,
    });
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
