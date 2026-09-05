import {
    getMinerUCacheEnabled,
    getMinerUApiKey,
    getConversionProvider,
    getMistralApiKey,
    getZoteroLocale,
    openMinerUPreferences,
    registerMinerUPreferencesPane,
} from './config/mineru-preferences.js';
import {
    createMarkdownCacheKey,
    createMinerUCacheKey,
    createZoteroMarkdownCache,
} from './cache/markdown-cache.js';
import {
    createCitationCacheKey,
    createZoteroCitationGraphCache,
} from './cache/citation-graph-cache.js';
import { observeLocalCacheCleared } from './cache/cache-events.js';
import {
    createZoteroPDFTextIndexCache,
} from './cache/pdf-text-index-cache.js';
import {
    createZoteroMarkdownAnnotationStore,
} from './cache/markdown-annotation-store.js';
import {
    AI_TARGET_LANGUAGES,
    getAISettings,
    isSupportedAITargetLanguage,
    observeAITargetLanguage,
} from './config/ai-preferences.js';
import { CitationGraph } from './citations/citation-graph.js';
import { OpenAlexClient } from './citations/openalex-client.js';
import { OpenCitationsClient } from './citations/open-citations-client.js';
import {
    SemanticScholarClient,
} from './citations/semantic-scholar-client.js';
import { createOpenAccessResolver } from './citations/open-access-resolver.js';
import { AISDKGateway } from './ai/ai-sdk-gateway.js';
import {
    MarkdownTranslationService,
} from './ai/markdown-translation-service.js';
import {
    TranslationRequestTracker,
} from './ai/translation-request-tracker.js';
import { MarkdownDocumentService } from './core/markdown-document-service.js';
import { ConversionProviderRouter } from './core/conversion-provider.js';
import {
    collectMatchedAnnotationRanges,
    createMarkdownRevisionSessionRegistry,
} from './core/markdown-revision-session.js';
import {
    createSavedMarkdownOpenResolver,
} from './core/saved-markdown-open-resolver.js';
import { MINERU_PARSER_PROFILE_ID } from './mineru/parser-profile.js';
import { MISTRAL_PARSER_PROFILE_ID } from './mistral/parser-profile.js';
import {
    createZoteroBlobFactory,
    createZoteroSavedMarkdownStore,
} from './platform/zotero-saved-markdown-store.js';
import {
    createZoteroMarkdownExporter,
} from './platform/zotero-markdown-exporter.js';
import {
    createZoteroMarkdownRevisionStore,
} from './platform/zotero-markdown-revision-store.js';
import {
    resolveZoteroSavedMarkdownSourceItem,
} from './platform/zotero-saved-markdown-source.js';
import {
    createEmptyAnnotationOverlay,
    MarkdownAnnotationOverlay,
} from './core/markdown-annotation-overlay.js';
import { MarkdownLocalAnnotations } from './core/markdown-local-annotations.js';
import {
    createEvidenceSnippet,
    formatEvidenceMarkdown,
} from './markdown/markdown-evidence.js';
import { selectExportMarkdown } from './markdown/export-markdown-selector.js';
import {
    CONVERSION_PROGRESS,
    normalizeConversionProgress,
} from './core/conversion-progress.js';
import {
    MinerUConfigurationError,
    MinerUDocumentExtractor,
} from './extractors/mineru-extractor.js';
import {
    MistralConfigurationError,
    MistralDocumentExtractor,
} from './extractors/mistral-extractor.js';
import { ZoteroAnnotationExtractor } from './extractors/zotero-annotation-extractor.js';
import { MinerUClient } from './mineru/mineru-client.js';
import { MinerUConversion } from './mineru/mineru-conversion.js';
import { MistralClient } from './mistral/mistral-client.js';
import { MistralConversion } from './mistral/mistral-conversion.js';
import {
    createZoteroMinerUPendingTaskStore,
} from './mineru/pending-task-store.js';
import { createRuntimeAbortController } from './platform/abort-controller.js';
import {
    createZoteroAnnotationActions,
    createZoteroPDFTextLocator,
} from './platform/zotero-annotation-actions.js';
import { PDFAnnotationLocator } from './pdf/pdf-annotation-locator.js';
import {
    PDFIndexOperationTracker,
} from './pdf/pdf-index-operation-tracker.js';
import { createPDFJSTextEngine } from './pdf/pdfjs-text-engine.js';
import { sha256Hex } from './core/sha256.js';
import {
    createZoteroPDFFileLoader,
    createZoteroTextMeasurer,
} from './platform/zotero-pdf-index-adapters.js';
import {
    createZoteroActionsTagsBridge,
} from './platform/zotero-actions-tags.js';
import {
    createZoteroSourceNavigation,
} from './platform/zotero-source-navigation.js';
import { createZoteroClipboard } from './platform/zotero-clipboard.js';
import {
    createZoteroEvidenceReference,
} from './platform/zotero-evidence-reference.js';
import {
    createZoteroCitationLibrary,
    findCitationPaperPDFAttachment,
} from './platform/zotero-citation-library.js';
import { createZoteroReferenceLibrary } from './platform/zotero-reference-library.js';
import {
    createReferenceImportService,
    createReferenceServiceActions,
} from './core/reference-import-service.js';
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
import {
    MARKDOWN_TAB_CLOSE_REASONS,
    MarkdownTabPresenter,
} from './ui/markdown-tab-presenter.js';
import {
    CitationGraphModalPresenter,
} from './ui/citation-graph-modal-presenter.js';
import {
    createAnnotationOverlayRefresher,
} from './ui/annotation-overlay-refresher.js';
import {
    createConversionFailureChanges,
    createConversionLoadingChanges,
    createConversionProgressChanges,
    createConversionReadyChanges,
    createEmptyTranslationState,
    createTranslationLoadingChanges,
    snapshotReadyResult,
} from './ui/markdown-tab-state.js';

const runtime = {
    id: null,
    service: null,
    presenter: null,
    citationPresenter: null,
    citationGraph: null,
    citationLibrary: null,
    citationCache: null,
    referenceLibrary: null,
    referenceImportService: null,
    cache: null,
    translationService: null,
    revisionStore: null,
    revisionSessions: null,
    pdfTextIndexCache: null,
    pdfAnnotationLocator: null,
    savedMarkdownStore: null,
    savedMarkdownResolver: null,
    markdownExporter: null,
    rootURI: null,
    preferencePaneID: null,
    localization: null,
    annotationActions: null,
    actionsTags: null,
    sourceNavigation: null,
    clipboard: null,
    evidenceReference: null,
    disposeAnnotationObserver: null,
    disposeReferenceObserver: null,
    disposeCacheObserver: null,
    disposeAITargetLanguageObserver: null,
    annotationOverlayRefresher: null,
    localAnnotations: null,
    disposeToolbar: null,
    contextMenus: new Map(),
    translationRequests: null,
    pdfIndexOperations: new PDFIndexOperationTracker(),
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
    runtime.actionsTags = createZoteroActionsTagsBridge({
        zotero: Zotero,
        onError: error => Zotero.logError?.(error),
    });
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
    runtime.markdownExporter = createZoteroMarkdownExporter({
        createFilePicker: createZoteroFilePicker,
        ioUtils: IOUtils,
        pathUtils: PathUtils,
        createID: createMarkdownExportID,
        translate: runtimeTranslate,
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
    initializeCitationGraph(localization);
    initializeReferenceImport();
    runtime.translationService = new MarkdownTranslationService({
        aiGateway: new AISDKGateway({
            createAbortController: createZoteroAbortController,
            runtimeWindow: Zotero.getMainWindow?.(),
        }),
        cache,
        getSettings: () => getAISettings(Zotero),
        onCacheError: error => Zotero.logError?.(error),
    });
    runtime.translationRequests = new TranslationRequestTracker({
        createAbortController: createZoteroAbortController,
    });
    runtime.revisionStore = createZoteroMarkdownRevisionStore({
        zotero: Zotero,
        ioUtils: IOUtils,
        pathUtils: PathUtils,
    });
    runtime.revisionSessions = createMarkdownRevisionSessionRegistry();
    const pdfTextIndexCache = createZoteroPDFTextIndexCache({
        zotero: Zotero,
        ioUtils: IOUtils,
        pathUtils: PathUtils,
    });
    runtime.pdfTextIndexCache = pdfTextIndexCache;
    const readerTextLocator = createZoteroPDFTextLocator(Zotero);
    const pdfAnnotationLocator = new PDFAnnotationLocator({
        engine: createPDFJSTextEngine({
            workerSrc: `${rootURI}pdf.worker.mjs`,
            cMapUrl: `${rootURI}pdfjs/cmaps/`,
            standardFontDataUrl: `${rootURI}pdfjs/standard_fonts/`,
            wasmUrl: `${rootURI}pdfjs/wasm/`,
        }),
        cache: pdfTextIndexCache,
        createAbortController: createZoteroAbortController,
        createSourceHash: fileData => sha256Hex(fileData),
        loadFile: createZoteroPDFFileLoader(
            Zotero,
            path => IOUtils.read(path)
        ),
        measureText: createZoteroTextMeasurer(Zotero),
        readerLocator: readerTextLocator,
        onError: error => Zotero.logError?.(error),
    });
    runtime.pdfAnnotationLocator = pdfAnnotationLocator;
    runtime.annotationActions = createZoteroAnnotationActions(Zotero, {
        locateText: (itemID, text, options) => (
            pdfAnnotationLocator.locate(itemID, text, options)
        ),
    });
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
            translate: runtimeTranslate,
            now: () => new Date().toISOString(),
        });
        runtime.savedMarkdownResolver = createSavedMarkdownOpenResolver({
            store: runtime.savedMarkdownStore,
            cache,
            parserProfiles: [
                MINERU_PARSER_PROFILE_ID,
                MISTRAL_PARSER_PROFILE_ID,
            ],
            resolveSourceItem: manifest => (
                resolveZoteroSavedMarkdownSourceItem(Zotero, manifest)
            ),
            onCacheError: error => Zotero.logError?.(error),
        });
    }
    const annotationOverlay = new MarkdownAnnotationOverlay({
        extractor: new ZoteroAnnotationExtractor(Zotero),
        locateTextQuote: (itemID, annotation) => (
            pdfAnnotationLocator.locateTextQuote(
                itemID,
                annotation.text,
                {
                    pdfPageIndexHint: annotation.pageIndex,
                    sortIndex: annotation.sortIndex,
                }
            )
        ),
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
    const mineruExtractor = new MinerUDocumentExtractor({
        zotero: Zotero,
        conversion,
        getApiKey: () => getMinerUApiKey(Zotero),
        readFile: path => IOUtils.read(path),
        preparePDFIndex: (itemID, options) => trackPDFIndexTask(
            runtime.pdfIndexOperations,
            itemID,
            options,
            pdfAnnotationLocator
        ),
        createCacheKey: fileData => createMinerUCacheKey(fileData),
        readRevision: options => readRevisionSnapshot(options),
        isCacheEnabled: () => getMinerUCacheEnabled(Zotero),
    });
    const mistralConversion = new MistralConversion({
        client: new MistralClient({
            createAbortController: createZoteroAbortController,
        }),
        cache,
        onError: error => Zotero.logError?.(error),
    });
    const mistralExtractor = new MistralDocumentExtractor({
        zotero: Zotero,
        conversion: mistralConversion,
        getApiKey: () => getMistralApiKey(Zotero),
        readFile: path => IOUtils.read(path),
        preparePDFIndex: (itemID, options) => trackPDFIndexTask(
            runtime.pdfIndexOperations,
            itemID,
            options,
            pdfAnnotationLocator
        ),
        createCacheKey: (fileData, options) => createMarkdownCacheKey(
            fileData,
            {
                ...options,
                parserProfile: MISTRAL_PARSER_PROFILE_ID,
            }
        ),
        readRevision: options => readRevisionSnapshot(options),
        isCacheEnabled: () => getMinerUCacheEnabled(Zotero),
    });
    const extractor = new ConversionProviderRouter({
        getProvider: () => getConversionProvider(Zotero),
        providers: {
            mineru: mineruExtractor,
            mistral: mistralExtractor,
        },
    });
    runtime.service = new MarkdownDocumentService({
        extractor,
        annotationOverlay,
        localAnnotations,
        savedResolver: runtime.savedMarkdownResolver,
        translate: runtimeTranslate,
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
    runtime.disposeCacheObserver = observeLocalCacheCleared(
        typeof Services === 'undefined' ? null : Services,
        resetOpenDocumentTranslations
    );
    runtime.disposeAITargetLanguageObserver = observeAITargetLanguage(
        Zotero,
        targetLanguage => {
            try {
                updateOpenDocumentTranslationLanguage(targetLanguage);
            }
            catch (error) {
                Zotero.logError?.(error);
            }
        }
    );
    cache.prune().catch(error => Zotero.logError(error));
    runtime.citationCache?.prune().catch(error => Zotero.logError(error));
    pdfTextIndexCache.prune().catch(error => Zotero.logError(error));
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
    abortAllTranslations();
    destroyAllRevisionSessions();
    runtime.disposeAnnotationObserver?.();
    runtime.disposeReferenceObserver?.();
    runtime.referenceImportService?.dispose?.();
    runtime.disposeCacheObserver?.();
    runtime.disposeAITargetLanguageObserver?.();
    runtime.localAnnotations?.dispose();
    runtime.pdfAnnotationLocator?.dispose();
    runtime.annotationOverlayRefresher?.dispose();
    runtime.disposeToolbar?.();
    disposeAllContextMenus();
    runtime.actionsTags?.dispose();
    runtime.citationPresenter?.dispose();
    runtime.presenter?.dispose();
    if (runtime.preferencePaneID) {
        Zotero.PreferencePanes.unregister?.(runtime.preferencePaneID);
    }
    runtime.disposeToolbar = null;
    runtime.presenter = null;
    runtime.citationPresenter = null;
    runtime.citationGraph = null;
    runtime.citationLibrary = null;
    runtime.citationCache = null;
    runtime.referenceLibrary = null;
    runtime.referenceImportService = null;
    runtime.service = null;
    runtime.cache = null;
    runtime.translationService = null;
    runtime.translationRequests = null;
    runtime.revisionStore = null;
    runtime.revisionSessions = null;
    runtime.pdfTextIndexCache = null;
    runtime.pdfAnnotationLocator = null;
    runtime.savedMarkdownStore = null;
    runtime.savedMarkdownResolver = null;
    runtime.markdownExporter = null;
    runtime.rootURI = null;
    runtime.localization = null;
    runtime.annotationActions = null;
    runtime.actionsTags = null;
    runtime.sourceNavigation = null;
    runtime.clipboard = null;
    runtime.evidenceReference = null;
    runtime.disposeAnnotationObserver = null;
    runtime.disposeReferenceObserver = null;
    runtime.disposeCacheObserver = null;
    runtime.disposeAITargetLanguageObserver = null;
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
    runtime.citationPresenter?.closeForWindow(window);
};

async function openReaderAsMarkdown(reader, { forceRefresh = false } = {}) {
    return openItemAsMarkdown(reader.itemID, {
        forceRefresh,
        entryPoint: 'reader-toolbar',
    });
}

async function openReaderCitationGraph(reader, { forceRefresh = false } = {}) {
    return openCitationGraph(reader.itemID, { forceRefresh });
}

async function openCitationGraph(itemID, { forceRefresh = false } = {}) {
    if (!runtime.citationLibrary || !runtime.citationPresenter) {
        throw new Error(runtimeTranslate('graph.loadFailed'));
    }
    const origin = await runtime.citationLibrary.resolveGraphOrigin(itemID);
    return runtime.citationPresenter.open({
        libraryID: origin.libraryID,
        focusItemID: origin.itemID,
        sourceItemID: itemID,
        forceRefresh,
    });
}

async function openCitationPaperWithMktero(node) {
    const attachment = await findCitationPaperPDFAttachment(Zotero, node);
    if (!attachment) {
        const error = new Error(
            'A PDF attachment is required to open a citation with Mktero'
        );
        error.code = 'CITATION_PDF_REQUIRED';
        throw error;
    }
    runtime.citationPresenter?.close();
    return openItemAsMarkdown(attachment.id);
}

async function openItemAsMarkdown(itemID, {
    forceRefresh = false,
    entryPoint = 'item-menu',
} = {}) {
    const presentation = runtime.presenter.open(itemID, {
        sourceItemID: itemID,
        onClose: ({ reason = MARKDOWN_TAB_CLOSE_REASONS.USER } = {}) => {
            abortConversion(itemID);
            abortDocumentTranslations(itemID);
            runtime.citationPresenter?.closeForItem(itemID);
            void closeRevisionSession(itemID);
            void runtime.actionsTags?.closeMarkdownSession({
                sessionID: itemID,
                sourceItemID: itemID,
                reason,
            });
        },
        onReparse: () => requestItemReparse(itemID, entryPoint),
        onOpenCitationGraph: sourceItemID => (
            openCitationGraph(sourceItemID || itemID)
        ),
        onOpenSettings: () => openMinerUPreferences(Zotero),
        onSaveSnapshot: () => saveSnapshotForItem(itemID),
        onExportMarkdown: options => exportMarkdownForDocument(itemID, options),
        onSetCorrectionMode: enabled => setCorrectionMode(itemID, enabled),
        onCommitCorrection: correction => commitCorrection(itemID, correction),
        onRestoreCorrection: blockID => restoreCorrection(itemID, blockID),
        onRestoreAllCorrections: () => restoreAllCorrections(itemID),
        onTranslateDocument: options => translateDocument(itemID, options),
        onCancelDocumentTranslation: () => cancelDocumentTranslation(itemID),
        onTranslateSelection: ({ text, context, onTextDelta } = {}) => (
            translateSelection(itemID, { text, context, onTextDelta })
        ),
        onCancelSelectionTranslation: () => cancelSelectionTranslation(itemID),
        shouldAutoTranslateSelection: () => isAutoSelectionTranslationEnabled(),
        onCopySelectionTranslation: text => copyCode(text),
        onSetTranslationView: view => setTranslationView(itemID, view),
        onSelectTranslationLanguage: language => (
            selectTranslationLanguage(itemID, language)
        ),
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
        onCopyCode: code => copyCode(code),
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
        ...createReferenceServiceActions(
            runtime.referenceImportService,
            { getSourceItemID: () => itemID }
        ),
    });
    if (presentation.created) {
        void runtime.actionsTags?.openMarkdownSession({
            sessionID: itemID,
            sourceItemID: itemID,
            entryPoint,
        });
    }
    if (!presentation.created
        && presentation.model.status !== 'error'
        && !forceRefresh) return;

    const previousResult = forceRefresh
        ? snapshotReadyResult(presentation.model)
        : null;
    abortConversion(itemID);
    const controller = createZoteroAbortController();
    runtime.pdfIndexOperations.start(itemID, controller);
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
                ? `Mktero: item ${itemID}: completed from local cache`
                : result.resumedTask
                    ? `Mktero: item ${itemID}: completed from a resumed conversion task`
                    : `Mktero: item ${itemID}: completed through a new conversion request`
        );
        const revisionResult = await attachRevisionSession(
            itemID,
            result,
            controller.signal
        );
        throwIfRevisionAborted(controller.signal);
        const readyResult = await attachCachedDocumentTranslation(
            revisionResult,
            controller.signal
        );
        runtime.presenter?.update(
            presentation,
            createConversionReadyChanges(
                localizeConversionResult(readyResult, runtimeTranslate)
            )
        );
    }
    catch (error) {
        if (controller.signal.aborted) return;
        Zotero.debug(
            `Mktero: conversion failed for item ${itemID}: ${userFacingError(error)}`
        );
        Zotero.logError(error);
        const opensSettings = error instanceof MinerUConfigurationError
            || error instanceof MistralConfigurationError
            || error?.code === 'MINERU_API_KEY_INVALID'
            || error?.code === 'MISTRAL_API_KEY_INVALID'
            || error?.code === 'MISTRAL_API_KEY_REQUIRED';
        if (opensSettings) {
            openMinerUPreferences(Zotero);
        }
        runtime.presenter?.update(
            presentation,
            createConversionFailureChanges(
                userFacingError(error),
                previousResult,
                runtimeTranslate,
                {
                    errorAction: opensSettings ? 'open-settings' : null,
                }
            )
        );
    }
    finally {
        runtime.pdfIndexOperations.finish(itemID, controller);
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
        onClose: () => {
            abortDocumentTranslations(noteID);
            runtime.citationPresenter?.closeForItem(sourceItem?.id);
        },
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
    const currentSourceItemID = () => runtime.presenter?.get(noteID)?.model
        ?.sourceItemID
        ?? sourceItem?.id
        ?? null;
    const withSource = callback => (...args) => {
        const sourceItemID = currentSourceItemID();
        if (!sourceItemID) throw new Error('The source PDF is unavailable');
        return callback(sourceItemID, ...args);
    };
    return {
        onOpenCitationGraph: sourceItem
            ? () => openCitationGraph(sourceItem.id)
            : null,
        onReparse: sourceItem
            ? () => requestItemReparse(sourceItem.id, 'saved-note')
            : null,
        onSaveSnapshot: sourceItem
            ? () => saveSnapshotForSavedNote(noteID, sourceItem.id)
            : null,
        onExportMarkdown: options => exportMarkdownForDocument(noteID, options),
        onOpenAnnotationInPDF: withSource((itemID, annotationID) => (
            runAnnotationAction('openInPDF', itemID, annotationID)
        )),
        onOpenSourceInPDF: withSource((itemID, location) => (
            openSourceInPDF(itemID, location)
        )),
        onCopySourcedMarkdown: withSource((itemID, target) => (
            copySourcedMarkdown(itemID, target)
        )),
        onCopyCode: code => copyCode(code),
        onTranslateSelection: ({ text, context, onTextDelta } = {}) => (
            translateSelection(noteID, { text, context, onTextDelta })
        ),
        onCancelSelectionTranslation: () => cancelSelectionTranslation(noteID),
        shouldAutoTranslateSelection: () => isAutoSelectionTranslationEnabled(),
        onCopySelectionTranslation: text => copyCode(text),
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
        ...createReferenceServiceActions(
            runtime.referenceImportService,
            { getSourceItemID: currentSourceItemID }
        ),
    };
}

async function saveSnapshotForItem(itemID) {
    const presentation = runtime.presenter?.get(itemID);
    return saveSnapshotForModel(itemID, presentation?.model);
}

async function exportMarkdownForDocument(documentID, options) {
    const presentation = runtime.presenter?.get(documentID);
    return exportMarkdownForModel(presentation?.model, options);
}

async function readRevisionSnapshot({ itemID, cacheKey, signal }) {
    if (!runtime.revisionStore) return null;
    throwIfRevisionAborted(signal);
    const saved = await runtime.revisionStore.load(cacheKey);
    throwIfRevisionAborted(signal);
    if (!saved) return null;
    const entry = await replaceRevisionSession(itemID, saved.base, { signal });
    throwIfRevisionAborted(signal);
    return { ...entry.session.snapshot(), itemID };
}

async function attachRevisionSession(itemID, result, signal) {
    if (!runtime.revisionStore || !result?.cacheKey) {
        await closeRevisionSession(itemID);
        return {
            ...result,
            editableBlocks: [],
            correctedBlockIDs: [],
            correctionCount: 0,
            hasCorrections: false,
            correctionMode: false,
        };
    }
    throwIfRevisionAborted(signal);
    let entry = runtime.revisionSessions?.get(itemID);
    if (!entry || entry.cacheKey !== result.cacheKey) {
        entry = await replaceRevisionSession(itemID, {
            itemID,
            cacheKey: result.cacheKey,
            markdown: result.markdown,
            sourceMap: result.sourceMap || [],
            assets: result.assets || [],
            assetBasePath: result.assetBasePath || '',
            extractedPages: result.extractedPages,
            totalPages: result.totalPages,
        }, { signal });
    }
    throwIfRevisionAborted(signal);
    entry.baseWarnings = [...(result.warnings || [])];
    return {
        ...result,
        ...entry.session.snapshot(),
        itemID,
        correctionMode: false,
    };
}

async function replaceRevisionSession(itemID, baseDocument, { signal } = {}) {
    const registry = runtime.revisionSessions;
    const store = runtime.revisionStore;
    if (!registry || !store) {
        throw new Error('Markdown corrections are unavailable');
    }
    return registry.open(itemID, baseDocument, {
        signal,
        store,
    });
}

async function closeRevisionSession(itemID) {
    await runtime.revisionSessions?.close(itemID);
}

function destroyAllRevisionSessions() {
    const sessions = runtime.revisionSessions;
    void sessions?.destroyAll()
        .catch(error => Zotero.logError?.(error));
}

function setCorrectionMode(itemID, enabled) {
    const presentation = runtime.presenter?.get(itemID);
    if (!presentation || presentation.model.status !== 'ready') return false;
    if (enabled) abortDocumentTranslations(itemID);
    runtime.presenter.update(presentation, {
        correctionMode: Boolean(enabled),
        ...(enabled ? { translationView: 'original' } : {}),
    });
    return true;
}

function setTranslationView(documentID, view) {
    const presentation = runtime.presenter?.get(documentID);
    const translationAvailable = ['ready', 'partial'].includes(
        presentation?.model.translationStatus
    ) || (
        presentation?.model.translationStatus === 'loading'
        && Array.isArray(presentation.model.translationBlocks)
        && presentation.model.translationBlocks.length > 0
    );
    if (!presentation
        || presentation.model.status !== 'ready'
        || presentation.model.renderMode === 'html'
        || !translationAvailable) {
        return false;
    }
    const normalized = ['original', 'translated', 'compare'].includes(view)
        ? view
        : 'original';
    runtime.presenter.update(presentation, {
        translationView: normalized,
        ...(normalized !== 'original' ? { correctionMode: false } : {}),
    });
    return true;
}

async function translateDocument(documentID, {
    retryBlockIDs = null,
    forceRetranslate = false,
    targetLanguage: selectedTargetLanguage,
    translationView: completedTranslationView,
} = {}) {
    const presentation = runtime.presenter?.get(documentID);
    const service = runtime.translationService;
    if (!presentation
        || presentation.model.status !== 'ready'
        || presentation.model.renderMode === 'html'
        || typeof service?.translateDocument !== 'function') {
        const error = new Error('AI translation is unavailable');
        error.code = 'AI_CONFIGURATION_ERROR';
        throw error;
    }
    const requests = runtime.translationRequests;
    if (!requests) {
        const error = new Error('AI translation is unavailable');
        error.code = 'AI_CONFIGURATION_ERROR';
        throw error;
    }
    presentation.translationLanguageSelection = null;
    const previousTranslation = currentTranslationResult(
        presentation.model
    );
    const configuredTargetLanguage = getAISettings(Zotero).targetLanguage;
    const targetLanguage = selectedTargetLanguage === undefined
        ? previousTranslation?.targetLanguage || configuredTargetLanguage
        : String(selectedTargetLanguage || '').trim();
    if (!isSupportedAITargetLanguage(targetLanguage)) {
        const error = new Error('AI translation target language is unavailable');
        error.code = 'AI_CONFIGURATION_ERROR';
        throw error;
    }
    const loadingTranslation = createTranslationLoadingChanges({
        model: presentation.model,
        previousTranslation,
        targetLanguage,
        retryBlockIDs,
        forceRetranslate,
    });
    runtime.presenter.update(presentation, {
        correctionMode: false,
        ...(previousTranslation ? {} : { translationView: 'original' }),
        translationStatus: 'loading',
        ...loadingTranslation,
        translationStage: 'preparing',
        translationTargetLanguage: previousTranslation?.targetLanguage
            || '',
        translationConfiguredTargetLanguage: configuredTargetLanguage,
        translationRequestedTargetLanguage: targetLanguage,
        translationError: '',
    });
    try {
        const result = await requests.run(
            documentID,
            'document',
            signal => service.translateDocument({
                documentKey: String(presentation.model.cacheKey || ''),
                markdown: presentation.model.markdown,
                signal,
                targetLanguage,
                retryBlockIDs,
                existingTranslation: previousTranslation,
                forceRetranslate,
                onProgress: ({ completed, total, stage }) => {
                    if (runtime.presenter?.get(documentID) !== presentation) return;
                    if (presentation.model.translationRequestedTargetLanguage
                        !== targetLanguage) return;
                    runtime.presenter.update(presentation, {
                        ...(stage ? { translationStage: stage } : {}),
                        ...(total !== undefined ? {
                            translationProgress: total
                                ? Math.round(completed / total * 100)
                                : 100,
                            translationCompletedBlocks: completed,
                            translationTotalBlocks: total,
                        } : {}),
                    });
                },
            })
        );
        if (runtime.presenter?.get(documentID) !== presentation) return result;
        if (presentation.model.translationRequestedTargetLanguage
            !== targetLanguage) return result;
        const preservePrevious = result.partial
            && previousTranslation?.status === 'ready';
        const languageState = cachedLanguageStateAfterTranslation(
            presentation.model,
            result
        );
        if (preservePrevious) {
            runtime.presenter.update(presentation, {
                ...restoreTranslationResult(previousTranslation),
                translationConfiguredTargetLanguage:
                    presentation.model.translationConfiguredTargetLanguage,
                ...languageState,
            });
            return result;
        }
        runtime.presenter.update(presentation, documentTranslationChanges(
            result,
            {
                translationView: completedTranslationView
                    || presentation.model.translationView
                    || 'original',
                configuredTargetLanguage:
                    presentation.model.translationConfiguredTargetLanguage,
                ...languageState,
            }
        ));
        return result;
    }
    catch (error) {
        if (runtime.presenter?.get(documentID) === presentation
            && presentation.model.translationRequestedTargetLanguage
                === targetLanguage) {
            runtime.presenter.update(
                presentation,
                previousTranslation
                    ? restoreTranslationResult(previousTranslation, {
                        error: error?.name === 'AbortError'
                            ? previousTranslation.error
                            : localizeTranslationError(error),
                    })
                    : {
                        translationStatus: 'none',
                        translationProgress: 0,
                        translationCompletedBlocks: 0,
                        translationTotalBlocks: 0,
                        translationStage: '',
                        translationView: 'original',
                        translationTargetLanguage: '',
                        translationRequestedTargetLanguage: '',
                        translationKey: null,
                        translationSettingsIdentity: '',
                        translationBlocks: [],
                        translationFailedBlocks: [],
                        translationBlockRanges: [],
                        translationError: error?.name === 'AbortError'
                            ? ''
                            : localizeTranslationError(error),
                    }
            );
        }
        if (error?.name !== 'AbortError') Zotero.logError?.(error);
        throw error;
    }
}

async function translateSelection(documentID, {
    text,
    context = '',
    targetLanguage: requestedTargetLanguage,
    onTextDelta,
} = {}) {
    const presentation = runtime.presenter?.get(documentID);
    const service = runtime.translationService;
    if (!presentation
        || presentation.model.status !== 'ready'
        || presentation.model.renderMode === 'html'
        || typeof service?.translateSelection !== 'function') {
        const error = new Error('AI selection translation is unavailable');
        error.code = 'AI_CONFIGURATION_ERROR';
        throw error;
    }
    const requests = runtime.translationRequests;
    if (!requests) {
        const error = new Error('AI selection translation is unavailable');
        error.code = 'AI_CONFIGURATION_ERROR';
        throw error;
    }
    const configuredTargetLanguage = getAISettings(Zotero).targetLanguage;
    const targetLanguage = requestedTargetLanguage === undefined
        ? configuredTargetLanguage
        : String(requestedTargetLanguage || '').trim();
    if (!isSupportedAITargetLanguage(targetLanguage)) {
        const error = new Error(
            'AI selection translation target language is unavailable'
        );
        error.code = 'AI_CONFIGURATION_ERROR';
        throw error;
    }
    return requests.run(
        documentID,
        'selection',
        signal => service.translateSelection({
            text,
            context,
            signal,
            targetLanguage,
            onTextDelta,
        })
    );
}

function cancelDocumentTranslation(documentID) {
    return runtime.translationRequests?.cancelBlock(documentID, 'document')
        || false;
}

function cancelSelectionTranslation(documentID) {
    return runtime.translationRequests?.cancelBlock(documentID, 'selection')
        || false;
}

function isAutoSelectionTranslationEnabled() {
    const settings = getAISettings(Zotero);
    return settings.enabled === true
        && settings.autoTranslateSelection === true;
}

function abortDocumentTranslations(documentID) {
    runtime.translationRequests?.cancelDocument(documentID);
}

function abortAllTranslations() {
    runtime.translationRequests?.abortAll();
}

function commitCorrection(itemID, correction) {
    return updateRevisionSession(
        itemID,
        (session, annotationRanges) => {
            const {
                annotationRanges: mappedAnnotationRanges = [],
                ...revisionCorrection
            } = correction || {};
            return session.commit({
                ...revisionCorrection,
                annotationRanges,
                mappedAnnotationRanges,
            });
        }
    ).then(({ snapshot, translation }) => {
        const canRetranslate = getAISettings(Zotero).enabled === true
            && String(correction?.replacementMarkdown || '').trim()
            && translation?.pendingBlockIDs?.length;
        return {
            ...snapshot,
            ...(canRetranslate ? {
                translationRefresh: {
                    blockIDs: [...translation.pendingBlockIDs],
                    targetLanguage: translation.targetLanguage,
                    translationView: translation.view,
                },
            } : {}),
        };
    });
}

function restoreCorrection(itemID, blockID) {
    return updateRevisionSession(
        itemID,
        (session, annotationRanges) => session.restore(
            blockID,
            { annotationRanges }
        )
    ).then(result => result.snapshot);
}

function restoreAllCorrections(itemID) {
    return updateRevisionSession(
        itemID,
        (session, annotationRanges) => session.restoreAll({ annotationRanges }),
        { recoverCachedTranslation: true },
    ).then(result => result.snapshot);
}

async function updateRevisionSession(itemID, mutate, {
    recoverCachedTranslation = false,
} = {}) {
    const entry = runtime.revisionSessions?.get(itemID);
    const presentation = runtime.presenter?.get(itemID);
    if (!entry || !presentation) {
        throw new Error('The Markdown correction session is unavailable');
    }
    const previousTranslation = currentTranslationResult(presentation.model);
    const annotationRanges = collectMatchedAnnotationRanges(
        presentation.model.annotationOverlay
    );
    const revisionResult = await mutate(entry.session, annotationRanges);
    const {
        annotationRangeMappings = [],
        ...snapshot
    } = revisionResult;
    if (annotationRangeMappings.length) {
        await runtime.localAnnotations?.remapRanges?.(
            itemID,
            annotationRangeMappings,
            snapshot.markdown,
            { sourceMap: snapshot.sourceMap }
        );
    }
    abortDocumentTranslations(itemID);
    const translationState = await resolveTranslationAfterRevision(snapshot, {
        previousTranslation,
        recoverCachedTranslation,
    });
    if (runtime.revisionSessions?.get(itemID) !== entry
        || runtime.presenter?.get(itemID) !== presentation) {
        return { snapshot, translation: null };
    }
    const recoveredTranslationChanges = translationState.recovered ? {
        ...translationState.recoveredSnapshot,
        translationView: translationState.view,
    } : null;
    entry.annotationSequence = (entry.annotationSequence || 0) + 1;
    const annotationSequence = entry.annotationSequence;
    const languageState = translationState.reconciled
        ? cachedLanguageStateAfterTranslation(
            presentation.model,
            translationState.reconciled
        ) : null;
    runtime.presenter.update(presentation, {
        ...snapshot,
        itemID,
        annotationOverlay: createEmptyAnnotationOverlay(),
        warnings: uniqueWarnings(entry.baseWarnings),
        ...(translationState.reconciled ? documentTranslationChanges(
            translationState.reconciled,
            {
                translationView: translationState.view,
                configuredTargetLanguage:
                    presentation.model.translationConfiguredTargetLanguage,
                ...languageState,
            }
        ) : recoveredTranslationChanges || createEmptyTranslationState()),
    });
    let annotationResult;
    try {
        annotationResult = await runtime.service.resolveAnnotations(
            itemID,
            snapshot.markdown,
            { sourceMap: snapshot.sourceMap }
        );
    }
    catch (error) {
        Zotero.logError?.(error);
        return {
            snapshot,
            translation: translationState.result,
        };
    }
    if (entry.annotationSequence !== annotationSequence
        || runtime.revisionSessions?.get(itemID) !== entry
        || runtime.presenter?.get(itemID) !== presentation) {
        return { snapshot, translation: null };
    }
    runtime.presenter.update(presentation, {
        annotationOverlay: annotationResult.annotationOverlay
            || createEmptyAnnotationOverlay(),
        warnings: uniqueWarnings([
            ...entry.baseWarnings,
            ...(annotationResult.warnings || []),
        ]),
    });
    return {
        snapshot,
        translation: translationState.result,
    };
}

async function resolveTranslationAfterRevision(snapshot, {
    previousTranslation,
    recoverCachedTranslation,
}) {
    let reconciled = null;
    if (previousTranslation && snapshot.markdown.trim()) {
        try {
            reconciled = await runtime.translationService
                ?.reconcileDocumentTranslation?.({
                    documentKey: String(snapshot.cacheKey || ''),
                    markdown: snapshot.markdown,
                    existingTranslation: previousTranslation,
                    targetLanguage: previousTranslation.targetLanguage,
                }) || null;
        }
        catch (error) {
            Zotero.logError?.(error);
        }
    }
    let recoveredSnapshot = null;
    if (!reconciled
        && recoverCachedTranslation
        && snapshot.markdown.trim()) {
        try {
            recoveredSnapshot = await attachCachedDocumentTranslation(snapshot);
        }
        catch (error) {
            Zotero.logError?.(error);
        }
    }
    const recovered = currentTranslationResult(recoveredSnapshot);
    const active = reconciled || recovered;
    const view = previousTranslation?.view || recovered?.view || 'original';
    return {
        reconciled,
        recovered,
        recoveredSnapshot,
        result: active ? { ...active, view } : null,
        view,
    };
}

function resetOpenDocumentTranslations() {
    abortAllTranslations();
    for (const presentation of runtime.presenter?.list?.() || []) {
        if (presentation.model.status !== 'ready') continue;
        runtime.presenter.update(presentation, createEmptyTranslationState());
    }
}

async function requestItemReparse(itemID, entryPoint) {
    const entry = runtime.revisionSessions?.get(itemID)
        || await loadRevisionSessionForItem(itemID);
    const correctionCount = entry?.session.snapshot().correctionCount || 0;
    if (correctionCount) {
        if (runtime.presenter?.get(itemID)) {
            await restoreAllCorrections(itemID);
        }
        else {
            await entry.session.restoreAll();
        }
    }
    setCorrectionMode(itemID, false);
    abortDocumentTranslations(itemID);
    await closeRevisionSession(itemID);
    await openItemAsMarkdown(itemID, {
        forceRefresh: true,
        entryPoint,
    });
    return true;
}

async function attachCachedDocumentTranslation(result, signal) {
    if (!result?.cacheKey || !result.markdown) return result;
    let targetLanguage;
    let variants;
    do {
        if (signal?.aborted) throw signal.reason || new Error('Aborted');
        targetLanguage = getAISettings(Zotero).targetLanguage;
        variants = await runtime.translationService
            ?.listCachedDocumentTranslationVariants?.({
                documentKey: result.cacheKey,
                markdown: result.markdown,
            });
        if (signal?.aborted) throw signal.reason || new Error('Aborted');
    } while (getAISettings(Zotero).targetLanguage !== targetLanguage);
    const completeTranslations = (variants || []).filter(
        translation => !translation.partial
    );
    const languageState = cachedTranslationLanguageState(variants);
    const visibleTranslation = completeTranslations[0]
        || (variants || []).find(translation => (
            translation.targetLanguage === targetLanguage
        ))
        || variants?.[0];
    if (!visibleTranslation) {
        return {
            ...result,
            translationConfiguredTargetLanguage: targetLanguage,
            ...languageState,
        };
    }
    return {
        ...result,
        ...documentTranslationChanges(visibleTranslation, {
            translationView: 'original',
            configuredTargetLanguage: targetLanguage,
            ...languageState,
        }),
    };
}

function updateOpenDocumentTranslationLanguage(targetLanguage) {
    for (const presentation of runtime.presenter?.list?.() || []) {
        runtime.presenter.update(presentation, {
            translationConfiguredTargetLanguage: targetLanguage,
        });
    }
}

async function selectTranslationLanguage(documentID, targetLanguage) {
    const presentation = runtime.presenter?.get(documentID);
    if (!presentation
        || !isSupportedAITargetLanguage(targetLanguage)
        || presentation.model.translationStatus === 'loading') {
        return false;
    }
    const currentComplete = presentation.model.translationStatus === 'ready'
        && presentation.model.translationTargetLanguage === targetLanguage;
    if (currentComplete) {
        return setTranslationView(documentID, 'translated');
    }
    if (!presentation.model.translationCachedLanguages?.includes(
        targetLanguage
    )) {
        return translateDocument(documentID, {
            targetLanguage,
            translationView: 'translated',
        });
    }
    const selection = {};
    presentation.translationLanguageSelection = selection;
    return activateCachedTranslationLanguage(presentation, targetLanguage, {
        translationView: 'translated',
        selection,
    });
}

async function activateCachedTranslationLanguage(
    presentation,
    targetLanguage,
    {
        translationView = presentation.model.translationView || 'original',
        selection = null,
    } = {}
) {
    const documentID = presentation.model.documentID;
    const documentKey = String(presentation.model.cacheKey || '');
    const markdown = String(presentation.model.markdown || '');
    const cached = await runtime.translationService
        ?.getCachedDocumentTranslation?.({
            documentKey,
            markdown,
            targetLanguage,
        });
    const current = runtime.presenter?.get(documentID);
    if (current !== presentation
        || presentation.model.status !== 'ready'
        || String(presentation.model.cacheKey || '') !== documentKey
        || String(presentation.model.markdown || '') !== markdown
        || selection && presentation.translationLanguageSelection !== selection
        || !cached
        || cached.partial
        || cached.targetLanguage !== targetLanguage) {
        return false;
    }
    runtime.presenter.update(presentation, documentTranslationChanges(
        cached,
        {
            translationView,
            configuredTargetLanguage:
                presentation.model.translationConfiguredTargetLanguage
                || getAISettings(Zotero).targetLanguage,
            translationCachedLanguages:
                presentation.model.translationCachedLanguages,
            translationPartialLanguages:
                presentation.model.translationPartialLanguages,
        }
    ));
    return true;
}

function cachedTranslationLanguageState(translations) {
    const variants = Array.isArray(translations) ? translations : [];
    return {
        translationCachedLanguages: variants
            .filter(translation => !translation?.partial)
            .map(translation => translation?.targetLanguage)
            .filter(isSupportedAITargetLanguage),
        translationPartialLanguages: variants
            .filter(translation => translation?.partial)
            .map(translation => translation?.targetLanguage)
            .filter(isSupportedAITargetLanguage),
    };
}

function cachedLanguageStateAfterTranslation(model, result) {
    const complete = new Set(model.translationCachedLanguages || []);
    const partial = new Set(model.translationPartialLanguages || []);
    complete.delete(result.targetLanguage);
    partial.delete(result.targetLanguage);
    const cacheStatus = ['complete', 'partial', 'missing'].includes(
        result.cacheStatus
    ) ? result.cacheStatus : result.partial ? 'partial' : 'complete';
    if (cacheStatus === 'partial') {
        partial.add(result.targetLanguage);
    }
    else if (cacheStatus === 'complete') {
        complete.add(result.targetLanguage);
    }
    return {
        translationCachedLanguages: AI_TARGET_LANGUAGES.filter(
            language => complete.has(language)
        ),
        translationPartialLanguages: AI_TARGET_LANGUAGES.filter(
            language => partial.has(language)
        ),
    };
}

function documentTranslationChanges(cached, {
    translationView,
    configuredTargetLanguage,
    translationCachedLanguages,
    translationPartialLanguages,
}) {
    const partial = Boolean(cached.partial);
    return {
        translationStatus: partial ? 'partial' : 'ready',
        translationProgress: cached.totalBlocks
            ? Math.round(cached.completedBlocks / cached.totalBlocks * 100)
            : 100,
        translationView,
        translatedMarkdown: cached.translatedMarkdown,
        comparisonMarkdown: cached.comparisonMarkdown,
        comparisonSourceRanges: cached.comparisonSourceRanges,
        comparisonTranslationRanges: cached.comparisonTranslationRanges,
        translationCompletedBlocks: cached.completedBlocks,
        translationTotalBlocks: cached.totalBlocks,
        translationStage: 'complete',
        translationTargetLanguage: cached.targetLanguage,
        translationConfiguredTargetLanguage: configuredTargetLanguage,
        translationRequestedTargetLanguage: '',
        ...(Array.isArray(translationCachedLanguages) ? {
            translationCachedLanguages: [...translationCachedLanguages],
        } : {}),
        ...(Array.isArray(translationPartialLanguages) ? {
            translationPartialLanguages: [...translationPartialLanguages],
        } : {}),
        translationKey: cached.translationKey,
        translationSettingsIdentity: cached.settingsIdentity || '',
        translationBlocks: cached.blocks,
        translationSourceBlocks: cached.sourceBlocks || [],
        translationFailedBlocks: cached.failedBlocks,
        translationBlockRanges: cached.blockRanges,
        translationError: partial
            ? runtimeTranslate('ai.documentTranslationPartial', {
                failed: cached.failedBlocks.length,
            })
            : '',
    };
}

function currentTranslationResult(model) {
    if (!['ready', 'partial'].includes(model?.translationStatus)
        || !Array.isArray(model.translationBlocks)
        || !model.translationBlocks.length) {
        return null;
    }
    const failedBlocks = model.translationFailedBlocks || [];
    const totalBlocks = Math.max(
        failedBlocks.length,
        Number(model.translationTotalBlocks) || model.translationBlocks.length
    );
    return {
        status: model.translationStatus,
        view: model.translationView,
        progress: model.translationProgress,
        completedBlocks: model.translationCompletedBlocks,
        totalBlocks,
        targetLanguage: model.translationTargetLanguage,
        translationKey: model.translationKey,
        documentKey: String(model.cacheKey || ''),
        sourceMarkdown: String(model.markdown || ''),
        settingsIdentity: model.translationSettingsIdentity,
        blocks: model.translationBlocks,
        sourceBlocks: model.translationSourceBlocks,
        failedBlocks,
        blockRanges: model.translationBlockRanges,
        translatedMarkdown: model.translatedMarkdown,
        comparisonMarkdown: model.comparisonMarkdown,
        comparisonSourceRanges: model.comparisonSourceRanges,
        comparisonTranslationRanges: model.comparisonTranslationRanges,
        error: model.translationError,
    };
}

function restoreTranslationResult(result, { error = result.error } = {}) {
    return {
        translationStatus: result.status,
        translationView: result.view,
        translationProgress: result.progress,
        translationCompletedBlocks: result.completedBlocks,
        translationTotalBlocks: result.totalBlocks,
        translationStage: 'complete',
        translationTargetLanguage: result.targetLanguage,
        translationRequestedTargetLanguage: '',
        translationKey: result.translationKey,
        translationSettingsIdentity: result.settingsIdentity || '',
        translationBlocks: result.blocks,
        translationSourceBlocks: result.sourceBlocks || [],
        translationFailedBlocks: result.failedBlocks,
        translationBlockRanges: result.blockRanges,
        translatedMarkdown: result.translatedMarkdown,
        comparisonMarkdown: result.comparisonMarkdown,
        comparisonSourceRanges: result.comparisonSourceRanges,
        comparisonTranslationRanges: result.comparisonTranslationRanges,
        translationError: error,
    };
}

function localizeTranslationError(error) {
    if (error?.code === 'AI_CONFIGURATION_ERROR') {
        return runtimeTranslate('ai.configurationRequired');
    }
    if (error?.code === 'AI_REQUEST_TIMEOUT') {
        return runtimeTranslate('ai.requestTimedOut');
    }
    if (error?.code === 'AI_OUTPUT_TRUNCATED') {
        return runtimeTranslate('ai.outputTruncated');
    }
    if (error?.code === 'AI_RESPONSE_TOO_LARGE') {
        return runtimeTranslate('ai.responseTooLarge');
    }
    return runtimeTranslate('ai.documentTranslationFailed');
}

async function loadRevisionSessionForItem(itemID) {
    if (!runtime.revisionStore) return null;
    const item = await Zotero.Items.getAsync(itemID);
    const filePath = await item?.getFilePathAsync?.();
    if (!filePath) return null;
    const modelProfile = runtime.presenter?.get(itemID)?.model?.parserProfile;
    const parserProfile = validParserProfile(modelProfile)
        ? modelProfile
        : getConversionProvider(Zotero) === 'mistral'
            ? MISTRAL_PARSER_PROFILE_ID
            : MINERU_PARSER_PROFILE_ID;
    const cacheKey = await createMarkdownCacheKey(await IOUtils.read(filePath), {
        parserProfile,
    });
    const saved = await runtime.revisionStore.load(cacheKey);
    if (!saved) return null;
    return replaceRevisionSession(itemID, saved.base);
}

function throwIfRevisionAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}

function uniqueWarnings(warnings) {
    return [...new Set((warnings || []).filter(Boolean))];
}

async function saveSnapshotForSavedNote(noteID, sourceItemID) {
    const presentation = runtime.presenter?.get(noteID);
    return saveSnapshotForModel(sourceItemID, presentation?.model);
}

async function exportMarkdownForModel(model, { ownerWindow } = {}) {
    if (model?.status !== 'ready' || model.renderMode === 'html') {
        throw new Error('The Markdown document is unavailable');
    }
    if (!runtime.markdownExporter?.export) {
        throw new Error('Markdown export is unavailable');
    }
    return runtime.markdownExporter.export({
        ownerWindow: ownerWindow || Zotero.getMainWindow?.(),
        title: model.title,
        markdown: selectExportMarkdown(model),
        assets: model.assets,
        assetBasePath: model.assetBasePath,
    });
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
    const parserProfile = validParserProfile(model.parserProfile)
        ? model.parserProfile
        : MINERU_PARSER_PROFILE_ID;
    let cacheKey = model.cacheKey;
    if (!cacheKey) {
        const filePath = await pdfItem?.getFilePathAsync?.();
        if (!filePath) throw new Error('The local PDF file is unavailable');
        cacheKey = await createMarkdownCacheKey(await IOUtils.read(filePath), {
            parserProfile,
        });
    }
    const result = await runtime.savedMarkdownStore.saveSnapshot({
        pdfItem,
        parentItem: pdfItem.parentItem || null,
        markdown: model.markdown,
        assets: model.assets,
        assetBasePath: model.assetBasePath,
        sourceMap: model.sourceMap,
        cacheKey,
        parserProfile,
        containsUserCorrections: Boolean(model.hasCorrections),
        correctionCount: model.correctionCount || 0,
    });
    Zotero.debug('Mktero: saved Markdown snapshot for item ' + pdfItem.id);
    return result;
}

function validParserProfile(value) {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 4_096
        && !/[\u0000-\u001F\u007F]/.test(value);
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

async function copyCode(code) {
    try {
        if (typeof code !== 'string'
            || typeof runtime.clipboard?.writeText !== 'function') {
            throw new Error('Code copy is unavailable');
        }
        await runtime.clipboard.writeText(code);
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
        return 'conversion parsing finished; downloading the result';
    }
    if (resumingTask) {
        return 'resuming an uploaded conversion task; PDF upload skipped';
    }
    if (progress >= CONVERSION_PROGRESS.PARSING) {
        return 'PDF upload completed; conversion service is parsing';
    }
    if (progress >= CONVERSION_PROGRESS.UPLOADING) {
        return 'uploading PDF to conversion service';
    }
    if (progress >= CONVERSION_PROGRESS.PREPARING) {
        return 'preparing conversion request';
    }
    return 'preparing the local PDF';
}

function abortConversion(itemID) {
    runtime.pdfIndexOperations.abort(itemID);
}

function abortAllConversions() {
    runtime.pdfIndexOperations.abortAll();
}

function trackPDFIndexTask(tracker, itemID, options, locator) {
    const task = locator.prepare(itemID, options);
    return tracker.track(itemID, options.signal, task);
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

function createZoteroFilePicker() {
    if (typeof ChromeUtils === 'undefined') {
        throw new Error('The Zotero file picker is unavailable');
    }
    const { FilePicker } = ChromeUtils.importESModule(
        'chrome://zotero/content/modules/filePicker.mjs'
    );
    if (typeof FilePicker !== 'function') {
        throw new Error('The Zotero file picker is unavailable');
    }
    return new FilePicker();
}

function createMarkdownExportID() {
    return globalThis.crypto?.randomUUID?.()
        || String(Date.now()) + '-' + Math.random().toString(36).slice(2);
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
        onOpenCitationGraph: runtime.citationPresenter
            ? openReaderCitationGraph
            : null,
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
    if (error?.code === 'CITATION_PARENT_REQUIRED') {
        return runtimeTranslate('error.citationParentRequired');
    }
    if (error instanceof MinerUConfigurationError) {
        return runtimeTranslate('error.apiTokenMissing');
    }
    if (error instanceof MistralConfigurationError) {
        return runtimeTranslate('error.apiTokenMissing');
    }
    return localizeConversionError(error, runtimeTranslate);
}

function initializeCitationGraph(localization) {
    if (typeof Zotero.Search !== 'function') return;
    try {
        const citationCache = createZoteroCitationGraphCache({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        });
        const citationLibrary = createZoteroCitationLibrary(Zotero);
        const citationGraph = new CitationGraph({
            library: citationLibrary,
            providers: [{
                id: 'semantic-scholar',
                client: new SemanticScholarClient({
                    createAbortController: createZoteroAbortController,
                    requestTimeoutMs: 6_000,
                    maxRetryAttempts: 2,
                }),
                getAPIKey: () => '',
            }, {
                id: 'open-citations',
                client: new OpenCitationsClient({
                    createAbortController: createZoteroAbortController,
                    maxRetryAttempts: 2,
                }),
                getAPIKey: () => '',
            }, {
                id: 'openalex',
                client: new OpenAlexClient({
                    createAbortController: createZoteroAbortController,
                    maxRetryAttempts: 2,
                }),
                getAPIKey: () => '',
            }],
            cache: citationCache,
            createCacheKey: createCitationCacheKey,
            onCacheError: error => Zotero.logError?.(error),
        });
        runtime.citationCache = citationCache;
        runtime.citationLibrary = citationLibrary;
        runtime.citationGraph = citationGraph;
        runtime.citationPresenter = new CitationGraphModalPresenter({
            zotero: Zotero,
            graph: citationGraph,
            library: citationLibrary,
            onOpenPaper: openCitationPaperWithMktero,
            getLibraryName: libraryID => (
                Zotero.Libraries?.get?.(libraryID)?.name
                || runtimeTranslate('graph.title')
            ),
            createAbortController: createZoteroAbortController,
            localization,
        });
    }
    catch (error) {
        Zotero.logError?.(error);
        runtime.citationCache = null;
        runtime.citationLibrary = null;
        runtime.citationGraph = null;
        runtime.citationPresenter = null;
    }
}

function initializeReferenceImport() {
    try {
        const referenceLibrary = createZoteroReferenceLibrary(Zotero);
        const semanticScholarClient = new SemanticScholarClient({
            createAbortController: createZoteroAbortController,
            requestTimeoutMs: 6_000,
            maxRetryAttempts: 2,
        });
        const openAlexClient = new OpenAlexClient({
            createAbortController: createZoteroAbortController,
            requestTimeoutMs: 6_000,
            maxRetryAttempts: 2,
        });
        const openAccessResolver = createOpenAccessResolver({
            semanticScholarClient,
            openAlexClient,
        });
        const referenceImportService = createReferenceImportService({
            library: referenceLibrary,
            openAccessResolver,
            metadataClient: openAlexClient,
            createAbortController: createZoteroAbortController,
        });
        runtime.referenceLibrary = referenceLibrary;
        runtime.referenceImportService = referenceImportService;
        runtime.disposeReferenceObserver = registerReferenceIndexObserver(
            Zotero,
            () => referenceImportService.invalidate(),
            error => Zotero.logError?.(error)
        );
    }
    catch (error) {
        Zotero.logError?.(error);
        runtime.referenceLibrary = null;
        runtime.referenceImportService = null;
    }
}

function registerReferenceIndexObserver(zotero, onChange, onError) {
    if (typeof zotero?.Notifier?.registerObserver !== 'function') {
        return () => {};
    }
    let active = true;
    const observer = {
        notify(_event, type) {
            if (!active || type !== 'item') return;
            try {
                onChange?.();
            }
            catch (error) {
                onError?.(error);
            }
        },
    };
    const observerID = zotero.Notifier.registerObserver(
        observer,
        ['item'],
        'mktero-reference-index'
    );
    return () => {
        if (!active) return;
        active = false;
        zotero.Notifier.unregisterObserver?.(observerID);
    };
}
