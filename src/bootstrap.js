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
import {
    createSavedMarkdownOpenResolver,
} from './core/saved-markdown-open-resolver.js';
import { MINERU_PARSER_PROFILE_ID } from './mineru/parser-profile.js';
import {
    createZoteroBlobFactory,
    createZoteroSavedMarkdownStore,
} from './platform/zotero-saved-markdown-store.js';
import {
    resolveZoteroSavedMarkdownSourceItem,
} from './platform/zotero-saved-markdown-source.js';
import { MarkdownAnnotationOverlay } from './core/markdown-annotation-overlay.js';
import { MarkdownLocalAnnotations } from './core/markdown-local-annotations.js';
import {
    createEvidenceSnippet,
    formatEvidenceMarkdown,
} from './markdown/markdown-evidence.js';
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
    createZoteroSourceNavigation,
} from './platform/zotero-source-navigation.js';
import { createZoteroClipboard } from './platform/zotero-clipboard.js';
import {
    createZoteroEvidenceReference,
} from './platform/zotero-evidence-reference.js';
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
    savedMarkdownStore: null,
    savedMarkdownResolver: null,
    rootURI: null,
    preferencePaneID: null,
    localization: null,
    annotationActions: null,
    sourceNavigation: null,
    clipboard: null,
    evidenceReference: null,
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
    runtime.sourceNavigation = createZoteroSourceNavigation(Zotero);
    runtime.clipboard = createZoteroClipboard(
        typeof Components === 'undefined' ? null : Components
    );
    runtime.evidenceReference = createZoteroEvidenceReference(
        Zotero,
        runtimeTranslate
    );
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
    if (Zotero.Attachments && Zotero.Item) {
        runtime.savedMarkdownStore = createZoteroSavedMarkdownStore({
            zotero: Zotero,
            readFile: path => IOUtils.read(path),
            writeTemporaryFile: writeZoteroTemporaryFile,
            createBlob: createZoteroBlobFactory({
                zotero: Zotero,
                services: typeof Services === 'undefined' ? null : Services,
            }),
            preparingNoteText: runtimeTranslate('viewer.snapshotPreparing'),
            now: () => new Date().toISOString(),
        });
        runtime.savedMarkdownResolver = createSavedMarkdownOpenResolver({
            store: runtime.savedMarkdownStore,
            cache,
            parserProfile: MINERU_PARSER_PROFILE_ID,
            resolveSourceItem: manifest => (
                resolveZoteroSavedMarkdownSourceItem(Zotero, manifest)
            ),
            onCacheError: error => Zotero.logError?.(error),
        });
    }
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
        savedResolver: runtime.savedMarkdownResolver,
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
    runtime.savedMarkdownStore = null;
    runtime.savedMarkdownResolver = null;
    runtime.rootURI = null;
    runtime.localization = null;
    runtime.annotationActions = null;
    runtime.sourceNavigation = null;
    runtime.clipboard = null;
    runtime.evidenceReference = null;
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
        sourceItemID: itemID,
        onClose: () => abortConversion(itemID),
        onReparse: () => openItemAsMarkdown(itemID, { forceRefresh: true }),
        onSaveSnapshot: () => saveSnapshotForItem(itemID),
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
        onOpenSourceInPDF: location => openSourceInPDF(itemID, location),
        onCopySourcedMarkdown: target => copySourcedMarkdown(itemID, target),
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

async function openSavedMarkdownNote(noteID) {
    if (!runtime.savedMarkdownStore?.readManifest) {
        throw new Error('Saved Markdown notes are unavailable');
    }
    const header = await runtime.savedMarkdownStore.readManifest(noteID);
    if (!header?.manifest) {
        throw new Error('The selected note is not a Mktero saved Markdown note');
    }
    let sourceItem = null;
    try {
        sourceItem = await resolveZoteroSavedMarkdownSourceItem(
            Zotero,
            header.manifest
        );
    }
    catch (error) {
        Zotero.logError?.(error);
    }
    const presentation = runtime.presenter.open(noteID, {
        sourceItemID: sourceItem?.id ?? null,
        ...createSavedMarkdownActions(noteID, sourceItem),
    });
    try {
        const result = localizeConversionResult(
            await runtime.service.openSaved(noteID),
            runtimeTranslate
        );
        runtime.presenter.update(presentation, {
            ...result,
            itemID: result.sourceItemID,
            documentID: noteID,
            status: 'ready',
            progress: 100,
            preserveContent: false,
            resumingTask: false,
            error: '',
        });
    }
    catch (error) {
        if (presentation.created || presentation.model.status !== 'ready') {
            runtime.presenter.update(presentation, {
                status: 'error',
                error: localizeConversionError(error, runtimeTranslate),
                progress: 0,
                preserveContent: false,
                resumingTask: false,
            });
        }
        throw error;
    }
    return runtime.presenter.get(noteID);
}

function createSavedMarkdownActions(noteID, sourceItem) {
    const withSource = callback => (...args) => {
        const sourceItemID = runtime.presenter?.get(noteID)?.model?.sourceItemID
            ?? sourceItem?.id
            ?? null;
        if (!sourceItemID) throw new Error('The source PDF is unavailable');
        return callback(sourceItemID, ...args);
    };
    return {
        onClose: () => {},
        onReparse: sourceItem
            ? () => openItemAsMarkdown(sourceItem.id, { forceRefresh: true })
            : null,
        onSaveSnapshot: sourceItem
            ? () => saveSnapshotForSavedNote(noteID, sourceItem.id)
            : null,
        onOpenAnnotationInPDF: withSource((itemID, annotationID) => (
            runAnnotationAction('openInPDF', itemID, annotationID)
        )),
        onOpenSourceInPDF: withSource((itemID, location) => (
            openSourceInPDF(itemID, location)
        )),
        onCopySourcedMarkdown: withSource((itemID, target) => (
            copySourcedMarkdown(itemID, target)
        )),
        onChangeAnnotationColor: withSource((itemID, annotationID, color) => (
            runAnnotationAction('changeColor', itemID, annotationID, color)
        )),
        onUpdateAnnotationComment: withSource((itemID, annotationID, comment) => (
            runAnnotationAction('updateComment', itemID, annotationID, comment)
        )),
        onDeleteAnnotation: withSource((itemID, annotationID) => (
            runAnnotationAction('deleteAnnotation', itemID, annotationID)
        )),
        onCreateMarkdownAnnotation: withSource((itemID, draft) => (
            runMarkdownAnnotationAction('create', itemID, draft)
        )),
        onUpdateMarkdownAnnotation: withSource((itemID, annotationID, changes) => (
            runMarkdownAnnotationAction(
                'update',
                itemID,
                annotationID,
                changes
            )
        )),
        onDeleteMarkdownAnnotation: withSource((itemID, annotationID) => (
            runMarkdownAnnotationAction('delete', itemID, annotationID)
        )),
        onRetryMarkdownAnnotationSynchronization: withSource(
            (itemID, annotationID) => (
                runMarkdownAnnotationAction(
                    'retrySynchronization',
                    itemID,
                    annotationID
                )
            )
        ),
    };
}

async function saveSnapshotForItem(itemID) {
    const presentation = runtime.presenter?.get(itemID);
    return saveSnapshotForModel(itemID, presentation?.model);
}

async function saveSnapshotForSavedNote(noteID, sourceItemID) {
    const presentation = runtime.presenter?.get(noteID);
    return saveSnapshotForModel(sourceItemID, presentation?.model);
}

async function saveSnapshotForModel(pdfItemOrID, model) {
    if (model?.status !== 'ready' || model.renderMode === 'html') {
        throw new Error('The Markdown document is unavailable');
    }
    if (!runtime.savedMarkdownStore?.saveSnapshot) {
        throw new Error('Saved Markdown notes are unavailable');
    }
    const pdfItem = pdfItemOrID && typeof pdfItemOrID === 'object'
        ? pdfItemOrID
        : await Zotero.Items.getAsync(pdfItemOrID);
    let cacheKey = model.cacheKey;
    if (!cacheKey) {
        const filePath = await pdfItem?.getFilePathAsync?.();
        if (!filePath) throw new Error('The local PDF file is unavailable');
        cacheKey = await createMinerUCacheKey(await IOUtils.read(filePath));
    }
    const result = await runtime.savedMarkdownStore.saveSnapshot({
        pdfItem,
        parentItem: pdfItem.parentItem || null,
        markdown: model.markdown,
        assets: model.assets,
        assetBasePath: model.assetBasePath,
        sourceMap: model.sourceMap,
        cacheKey,
        parserProfile: MINERU_PARSER_PROFILE_ID,
    });
    Zotero.debug('Mktero: saved Markdown snapshot for item ' + pdfItem.id);
    return result;
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

async function openSourceInPDF(itemID, location) {
    try {
        if (typeof runtime.sourceNavigation?.open !== 'function') {
            throw new Error('PDF source navigation is unavailable');
        }
        await runtime.sourceNavigation.open(itemID, location);
    }
    catch (error) {
        Zotero.logError?.(error);
        const message = runtimeTranslate('source.navigationFailed');
        Zotero.getMainWindow?.()?.alert?.(`Mktero: ${message}`);
    }
}

async function copySourcedMarkdown(itemID, target) {
    try {
        const presentation = runtime.presenter?.get(itemID)
            || runtime.presenter?.getForSourceItem?.(itemID);
        const model = presentation?.model;
        if (model?.status !== 'ready') {
            throw new Error('The Markdown document is unavailable');
        }
        const snippet = createEvidenceSnippet({
            markdown: model.markdown,
            sourceMap: model.sourceMap,
            target,
        });
        if (typeof runtime.evidenceReference?.resolve !== 'function'
            || typeof runtime.clipboard?.writeText !== 'function') {
            throw new Error('Sourced Markdown copy is unavailable');
        }
        const reference = await runtime.evidenceReference.resolve(
            itemID,
            snippet.pageIndexes
        );
        const markdown = formatEvidenceMarkdown(
            snippet,
            reference,
            runtimeTranslate
        );
        await runtime.clipboard.writeText(markdown);
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
        onOpenSavedNote: openSavedMarkdownNote,
        isSavedMarkdownNote: item => (
            runtime.savedMarkdownStore?.isSavedMarkdownNote(item) || false
        ),
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

async function writeZoteroTemporaryFile({ name, data }) {
    const tempRoot = PathUtils.tempDir
        || PathUtils.join(Zotero.Profile.dir, 'mktero-temp');
    const randomID = globalThis.crypto?.randomUUID?.()
        || String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    const directory = PathUtils.join(tempRoot, 'mktero-note-' + randomID);
    const filePath = PathUtils.join(directory, String(name));
    await IOUtils.makeDirectory(tempRoot, { ignoreExisting: true });
    await IOUtils.makeDirectory(directory, { ignoreExisting: false });
    try {
        await IOUtils.write(filePath, data);
    }
    catch (error) {
        await IOUtils.remove(directory, {
            recursive: true,
            ignoreAbsent: true,
        }).catch(() => {});
        throw error;
    }
    return {
        path: filePath,
        file: zoteroFileFromPath(filePath),
        cleanup: () => IOUtils.remove(directory, {
            recursive: true,
            ignoreAbsent: true,
        }),
    };
}

function zoteroFileFromPath(path) {
    if (Zotero.File?.pathToFile) return Zotero.File.pathToFile(path);
    if (typeof Components !== 'undefined') {
        const file = Components.classes['@mozilla.org/file/local;1']
            .createInstance(Components.interfaces.nsIFile);
        file.initWithPath(path);
        return file;
    }
    return path;
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
