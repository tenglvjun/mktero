import {
    getMinerUCacheEnabled,
    getMinerUApiKey,
    getZoteroLocale,
    openMinerUPreferences,
    registerMinerUPreferencesPane,
} from './config/mineru-preferences.js';
import {
    createMinerUCacheKey,
    createZoteroMarkdownCache,
} from './cache/markdown-cache.js';
import {
    createZoteroMarkdownAnnotationStore,
} from './cache/markdown-annotation-store.js';
import { MarkdownDocumentService } from './core/markdown-document-service.js';
import { MarkdownAnnotationOverlay } from './core/markdown-annotation-overlay.js';
import { MarkdownLocalAnnotations } from './core/markdown-local-annotations.js';
import {
    CONVERSION_PROGRESS,
    normalizeConversionProgress,
} from './core/conversion-progress.js';
import {
    MinerUConfigurationError,
    MinerUDocumentExtractor,
} from './extractors/mineru-extractor.js';
import { ZoteroAnnotationExtractor } from './extractors/zotero-annotation-extractor.js';
import { MinerUClient } from './mineru/mineru-client.js';
import { MinerUConversion } from './mineru/mineru-conversion.js';
import {
    createZoteroMinerUPendingTaskStore,
} from './mineru/pending-task-store.js';
import { createRuntimeAbortController } from './platform/abort-controller.js';
import {
    createZoteroAnnotationActions,
} from './platform/zotero-annotation-actions.js';
import {
    registerZoteroAnnotationObserver,
} from './platform/zotero-annotation-observer.js';
import {
    createLocalization,
    translateEnglish,
} from './i18n/localization.js';
import {
    localizeConversionError,
    localizeConversionResult,
} from './ui/provider-neutral-copy.js';
import { registerItemContextMenu } from './ui/item-context-menu.js';
import { registerReaderToolbar } from './ui/reader-toolbar.js';
import { MarkdownTabPresenter } from './ui/markdown-tab-presenter.js';
import {
    createAnnotationOverlayRefresher,
} from './ui/annotation-overlay-refresher.js';
import {
    createConversionFailureChanges,
    createConversionLoadingChanges,
    createConversionProgressChanges,
    createConversionReadyChanges,
    snapshotReadyResult,
} from './ui/markdown-tab-state.js';

const runtime = {
    id: null,
    service: null,
    presenter: null,
    cache: null,
    rootURI: null,
    preferencePaneID: null,
    localization: null,
    annotationActions: null,
    disposeAnnotationObserver: null,
    annotationOverlayRefresher: null,
    localAnnotations: null,
    disposeToolbar: null,
    contextMenus: new Map(),
    controllers: new Map(),
};

globalThis.install = async function install() {};

globalThis.startup = async function startup({ id, rootURI }) {
    runtime.id = id;
    runtime.rootURI = rootURI;
    const localization = createLocalization({
        zoteroLocale: getZoteroLocale(
            Zotero,
            typeof Services === 'undefined' ? null : Services
        ),
    });
    runtime.localization = localization;
    runtime.annotationActions = createZoteroAnnotationActions(Zotero);
    runtime.presenter = new MarkdownTabPresenter({
        zotero: Zotero,
        rootURI,
        localization,
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
    const annotationOverlay = new MarkdownAnnotationOverlay({
        extractor: new ZoteroAnnotationExtractor(Zotero),
        onError: error => Zotero.logError?.(error),
    });
    const localAnnotations = new MarkdownLocalAnnotations({
        store: createZoteroMarkdownAnnotationStore({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        }),
        createPDFAnnotation: (itemID, draft, context) => (
            runtime.annotationActions.createFromText(itemID, draft, context)
        ),
        deletePDFAnnotation: (itemID, annotationID) => (
            runtime.annotationActions.deleteAnnotation(itemID, annotationID)
        ),
        onSynchronizationChange: itemID => (
            runtime.annotationOverlayRefresher?.refresh([itemID])
        ),
        onError: error => Zotero.logError?.(error),
    });
    runtime.localAnnotations = localAnnotations;
    const pendingTasks = createZoteroMinerUPendingTaskStore({
        zotero: Zotero,
        ioUtils: IOUtils,
        pathUtils: PathUtils,
    });
    const conversion = new MinerUConversion({
        client: new MinerUClient({
            createAbortController: createZoteroAbortController,
        }),
        pendingTasks,
        cache,
        onError: error => Zotero.logError?.(error),
    });
    runtime.service = new MarkdownDocumentService({
        extractor: new MinerUDocumentExtractor({
            zotero: Zotero,
            conversion,
            getApiKey: () => getMinerUApiKey(Zotero),
            readFile: path => IOUtils.read(path),
            createCacheKey: fileData => createMinerUCacheKey(fileData),
            isCacheEnabled: () => getMinerUCacheEnabled(Zotero),
        }),
        annotationOverlay,
        localAnnotations,
    });
    runtime.annotationOverlayRefresher = createAnnotationOverlayRefresher({
        presenter,
        service: runtime.service,
    });
    runtime.disposeAnnotationObserver = registerZoteroAnnotationObserver(
        Zotero,
        {
            onChange: itemIDs => (
                runtime.annotationOverlayRefresher?.refresh(itemIDs)
            ),
            onError: error => Zotero.logError?.(error),
        }
    );
    cache.prune().catch(error => Zotero.logError(error));
    pendingTasks.prune().catch(error => Zotero.logError(error));
    presenter.ensureSessionStateFilter();
    const preferencePaneID = await registerMinerUPreferencesPane({
        zotero: Zotero,
        pluginID: id,
        rootURI,
        translate: runtimeTranslate,
    });
    if (runtime.presenter !== presenter) {
        Zotero.PreferencePanes.unregister?.(preferencePaneID);
        return;
    }
    runtime.preferencePaneID = preferencePaneID;
    registerReaderToolbarAction();
    registerMainWindowContextMenu(Zotero.getMainWindow?.());

    Zotero.debug('Mktero: started');
};

globalThis.shutdown = function shutdown() {
    abortAllConversions();
    runtime.disposeAnnotationObserver?.();
    runtime.localAnnotations?.dispose();
    runtime.annotationOverlayRefresher?.dispose();
    runtime.disposeToolbar?.();
    disposeAllContextMenus();
    runtime.presenter?.dispose();
    if (runtime.preferencePaneID) {
        Zotero.PreferencePanes.unregister?.(runtime.preferencePaneID);
    }
    runtime.disposeToolbar = null;
    runtime.presenter = null;
    runtime.service = null;
    runtime.cache = null;
    runtime.rootURI = null;
    runtime.localization = null;
    runtime.annotationActions = null;
    runtime.disposeAnnotationObserver = null;
    runtime.annotationOverlayRefresher = null;
    runtime.localAnnotations = null;
    runtime.preferencePaneID = null;
    runtime.id = null;
};

globalThis.uninstall = async function uninstall() {};
globalThis.onMainWindowLoad = function onMainWindowLoad({ window }) {
    registerMainWindowContextMenu(window);
};
globalThis.onMainWindowUnload = function onMainWindowUnload({ window }) {
    disposeMainWindowContextMenu(window);
};

async function openReaderAsMarkdown(reader, { forceRefresh = false } = {}) {
    return openItemAsMarkdown(reader.itemID, { forceRefresh });
}

async function openItemAsMarkdown(itemID, { forceRefresh = false } = {}) {
    const presentation = runtime.presenter.open(itemID, {
        onClose: () => abortConversion(itemID),
        onReparse: () => openItemAsMarkdown(itemID, { forceRefresh: true }),
        onChangeAnnotationColor: (annotationID, color) => (
            runAnnotationAction('changeColor', itemID, annotationID, color)
        ),
        onUpdateAnnotationComment: (annotationID, comment) => (
            runAnnotationAction('updateComment', itemID, annotationID, comment)
        ),
        onDeleteAnnotation: annotationID => (
            runAnnotationAction('deleteAnnotation', itemID, annotationID)
        ),
        onOpenAnnotationInPDF: annotationID => (
            runAnnotationAction('openInPDF', itemID, annotationID)
        ),
        onCreateMarkdownAnnotation: draft => (
            runMarkdownAnnotationAction('create', itemID, draft)
        ),
        onUpdateMarkdownAnnotation: (annotationID, changes) => (
            runMarkdownAnnotationAction(
                'update',
                itemID,
                annotationID,
                changes
            )
        ),
        onDeleteMarkdownAnnotation: annotationID => (
            runMarkdownAnnotationAction('delete', itemID, annotationID)
        ),
        onRetryMarkdownAnnotationSynchronization: annotationID => (
            runMarkdownAnnotationAction(
                'retrySynchronization',
                itemID,
                annotationID
            )
        ),
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
        createConversionLoadingChanges(previousResult, runtimeTranslate)
    );

    let lastLoggedProgress = null;
    try {
        const result = await runtime.service.convert(itemID, {
            signal: controller.signal,
            forceRefresh,
            onProgress(progress, state) {
                const normalizedProgress = normalizeConversionProgress(progress);
                if (normalizedProgress !== lastLoggedProgress) {
                    lastLoggedProgress = normalizedProgress;
                    Zotero.debug(
                        `Mktero: item ${itemID}: `
                        + `${conversionProgressLog(
                            normalizedProgress,
                            Boolean(state?.resumingTask)
                        )} `
                        + `(${normalizedProgress}%)`
                    );
                }
                runtime.presenter?.update(
                    presentation,
                    createConversionProgressChanges(normalizedProgress, state)
                );
            },
        });
        Zotero.debug(
            result.cacheHit
                ? `Mktero: item ${itemID}: completed from local cache; MinerU upload skipped`
                : result.resumedTask
                    ? `Mktero: item ${itemID}: completed from a resumed MinerU task`
                    : `Mktero: item ${itemID}: completed through a new MinerU task`
        );
        runtime.presenter?.update(
            presentation,
            createConversionReadyChanges(
                localizeConversionResult(result, runtimeTranslate)
            )
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
            createConversionFailureChanges(
                userFacingError(error),
                previousResult,
                runtimeTranslate
            )
        );
    }
    finally {
        if (runtime.controllers.get(itemID) === controller) {
            runtime.controllers.delete(itemID);
        }
    }
}

async function runAnnotationAction(action, ...args) {
    try {
        const handler = runtime.annotationActions?.[action];
        if (typeof handler !== 'function') {
            throw new Error('PDF annotation actions are unavailable');
        }
        await handler(...args);
    }
    catch (error) {
        Zotero.logError?.(error);
        throw error;
    }
}

async function runMarkdownAnnotationAction(action, ...args) {
    try {
        const handler = runtime.localAnnotations?.[action];
        if (typeof handler !== 'function') {
            throw new Error('Markdown annotation actions are unavailable');
        }
        return await handler.call(runtime.localAnnotations, ...args);
    }
    catch (error) {
        Zotero.logError?.(error);
        throw error;
    }
}

function conversionProgressLog(progress, resumingTask = false) {
    if (progress >= CONVERSION_PROGRESS.COMPLETE) {
        return 'conversion result available';
    }
    if (progress >= CONVERSION_PROGRESS.DOWNLOADING) {
        return 'MinerU parsing finished; downloading the result';
    }
    if (resumingTask) {
        return 'resuming an uploaded MinerU task; PDF upload skipped';
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

function registerMainWindowContextMenu(window) {
    if (!window || !runtime.id || runtime.contextMenus.has(window)) return;
    const dispose = registerItemContextMenu({
        zotero: Zotero,
        window,
        rootURI: runtime.rootURI,
        onOpen: openItemAsMarkdown,
        onError: handleOpenError,
        translate: runtimeTranslate,
    });
    if (dispose) runtime.contextMenus.set(window, dispose);
}

function disposeMainWindowContextMenu(window) {
    const dispose = runtime.contextMenus.get(window);
    if (!dispose) return;
    runtime.contextMenus.delete(window);
    dispose();
}

function disposeAllContextMenus() {
    for (const dispose of runtime.contextMenus.values()) dispose();
    runtime.contextMenus.clear();
}

function handleOpenError(error) {
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

function registerReaderToolbarAction() {
    if (!runtime.id) return;
    runtime.disposeToolbar = registerReaderToolbar({
        zotero: Zotero,
        pluginID: runtime.id,
        onOpen: openReaderAsMarkdown,
        onPDFReaderAvailable: reader => (
            runtime.localAnnotations?.synchronizePending(
                reader.itemID,
                { reader }
            )
        ),
        onError: handleOpenError,
        translate: runtimeTranslate,
    });
}

function runtimeTranslate(key, variables) {
    return runtime.localization?.t(key, variables)
        ?? translateEnglish(key, variables);
}

function userFacingError(error) {
    if (error instanceof MinerUConfigurationError) {
        return runtimeTranslate('error.apiTokenMissing');
    }
    return localizeConversionError(error, runtimeTranslate);
}
