import { unzipSync } from 'fflate';
import {
    CONVERSION_PROVIDER_MISTRAL,
    observeConversionProfile,
} from './config/conversion-preferences.js';
import {
    getMinerUCacheEnabled,
    getMinerUApiKey,
    getMinerUEndpoint,
    getMinerULocalApiBase,
    getMinerULocalApiKey,
    getConversionProvider,
    getMistralApiKey,
    MINERU_ENDPOINT_LOCAL,
    getZoteroLocale,
    openMinerUPreferences,
    registerMinerUPreferencesPane,
} from './config/mineru-preferences.js';
import {
    createMarkdownCacheKey,
    createMinerUCacheKey,
    createZoteroMarkdownCache,
    MARKDOWN_CACHE_MAX_AGE_MS,
} from './cache/markdown-cache.js';
import { createMarkdownReadinessController } from './cache/markdown-readiness-controller.js';
import { resolveMarkdownReadinessIdentity } from './cache/markdown-readiness-index.js';
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
    createZoteroMarkdownReadingPositionStore,
} from './cache/markdown-reading-position-store.js';
import {
    AI_TARGET_LANGUAGES,
    getAISettings,
    isSupportedAITargetLanguage,
    observeAITargetLanguage,
} from './config/ai-preferences.js';
import {
    attachAIReasoningCatalogHost,
    bindZoteroWindowFetch,
    createAIReasoningCatalogStore,
} from './config/ai-reasoning-catalog.js';
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
import { createConversionActivity } from './core/conversion-activity.js';
import { createConversionBatch } from './core/conversion-batch.js';
import { createConversionRunRegistry } from './core/conversion-runs.js';
import {
    collectMatchedAnnotationRanges,
    createMarkdownRevisionSessionRegistry,
} from './core/markdown-revision-session.js';
import {
    createSavedMarkdownOpenResolver,
} from './core/saved-markdown-open-resolver.js';
import {
    MINERU_COMPATIBLE_CACHE_PROFILE_IDS,
    MINERU_LOCAL_PARSER_PROFILE_ID,
    MINERU_PARSER_PROFILE_ID,
    MINERU_PREVIOUS_PARSER_PROFILE_IDS,
} from './mineru/parser-profile.js';
import { MISTRAL_PARSER_PROFILE_ID, MISTRAL_PREVIOUS_PARSER_PROFILE_IDS } from './mistral/parser-profile.js';
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
    resolveMarkdownReadingPosition,
} from './markdown/markdown-outline.js';
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
import { MinerULocalClient } from './mineru/local-client.js';
import { MinerULocalConversion } from './mineru/local-conversion.js';
import { LEGACY_FIGURE_PROFILES } from './figures/legacy-figure-profiles.js';
import { decodeMinerUFigureInput } from './mineru/figure-layout-adapter.js';
import { prepareMinerUResult } from './mineru/mineru-result.js';
import { decodeMistralResult, prepareMistralResult } from './mistral/mistral-result.js';
import { FigureRestorationService } from './figures/figure-restoration-service.js';
import { FigureLabelRecoveryService } from './figures/figure-label-recovery.js';
import { FigureReadingOrderService } from './figures/figure-reading-order.js';
import { finalizeRestoredDocument } from './figures/figure-finalization.js';
import { createProgressiveFigureRunner } from './figures/figure-progressive-runner.js';
import { createPDFFigureRegionRenderer } from './pdf/pdfjs-figure-region.js';
import { createWorkerFigureRegionRenderer } from './figures/figure-render-worker-client.js';
import { createZoteroFigureCanvasEnvironment } from './platform/zotero-figure-canvas.js';
import { MistralClient } from './mistral/mistral-client.js';
import { MistralConversion } from './mistral/mistral-conversion.js';
import {
    createZoteroMinerUPendingTaskStore,
} from './mineru/pending-task-store.js';
import { createRuntimeAbortController } from './platform/abort-controller.js';
import {
    createZoteroConversionProgress,
    installZoteroConversionProgressButton,
} from './platform/zotero-conversion-progress.js';
import {
    createZoteroAnnotationActions,
    createZoteroPDFTextLocator,
} from './platform/zotero-annotation-actions.js';
import { PDFAnnotationLocator } from './pdf/pdf-annotation-locator.js';
import {
    PDFIndexOperationTracker,
} from './pdf/pdf-index-operation-tracker.js';
import { createPDFJSTextEngine } from './pdf/pdfjs-text-engine.js';
import { createPDFPageCropRenderer } from './pdf/pdfjs-page-crop.js';
import { createZoteroSourcePeekRenderer } from './platform/zotero-source-peek.js';
import { sha256Hex } from './core/sha256.js';
import {
    createZoteroPDFFileLoader,
    createZoteroTextMeasurer,
} from './platform/zotero-pdf-index-adapters.js';
import {
    createZoteroActionsTagsBridge,
} from './platform/zotero-actions-tags.js';
import {
    createZoteroMarkdownReadinessStore,
} from './platform/zotero-markdown-readiness-store.js';
import {
    createZoteroSourceNavigation,
} from './platform/zotero-source-navigation.js';
import {
    refreshMarkdownReadinessColumn,
    registerMarkdownReadinessColumn,
} from './ui/markdown-readiness-column.js';
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
import {
    registerCollectionContextMenu,
    registerItemContextMenu,
} from './ui/item-context-menu.js';
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
import { conversionStageDetail } from './ui/markdown-loading-state.js';
import { applyProgressiveFigureUpdate } from './ui/figure-restoration-progress.js';
import {
    createConversionFailureChanges,
    createConversionLoadingChanges,
    createConversionProgressChanges,
    createConversionReadyChanges,
    createEmptyTranslationState,
    createTranslationLoadingChanges,
    snapshotReadyResult,
} from './ui/markdown-tab-state.js';

// Conversions whose OCR is done and only local figure stitching remains must
// keep running after the reader tab is closed, so the next open is instant.
const backgroundFigureRestorations = new Set();
const batchItemWatchers = new Map();
const backgroundContinuations = new Map();
const progressButtonDisposers = new Map();
const cancelledPreparations = new Set();

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
    readiness: null,
    readinessColumn: null,
    disposeConversionProfileObserver: null,
    translationService: null,
    revisionStore: null,
    readingPositions: null,
    revisionSessions: null,
    pdfTextIndexCache: null,
    pdfAnnotationLocator: null,
    sourcePeekRenderer: null,
    figureRegionRenderer: null,
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
    conversionActivity: null,
    conversionRuns: null,
    conversionBatch: null,
    conversionProgress: null,
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
    runtime.conversionActivity = createConversionActivity();
    const readinessReady = initializeMarkdownReadiness(cache, id, rootURI);
    initializeCitationGraph(localization);
    initializeReferenceImport();
    runtime.translationService = new MarkdownTranslationService({
        aiGateway: new AISDKGateway({
            createAbortController: createZoteroAbortController,
            runtimeWindow: Zotero.getMainWindow?.(),
            onDebug: message => Zotero.debug(message),
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
    runtime.readingPositions = createZoteroMarkdownReadingPositionStore({
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
    const loadPDFFile = createZoteroPDFFileLoader(
        Zotero,
        path => IOUtils.read(path)
    );
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
        loadFile: loadPDFFile,
        measureText: createZoteroTextMeasurer(Zotero),
        readerLocator: readerTextLocator,
        onError: error => Zotero.logError?.(error),
    });
    runtime.pdfAnnotationLocator = pdfAnnotationLocator;
    runtime.sourcePeekRenderer = createZoteroSourcePeekRenderer({
        zotero: Zotero,
        cropRenderer: createPDFPageCropRenderer({
            loadFile: loadPDFFile,
            workerSrc: `${rootURI}pdf.worker.mjs`,
            cMapUrl: `${rootURI}pdfjs/cmaps/`,
            standardFontDataUrl: `${rootURI}pdfjs/standard_fonts/`,
            wasmUrl: `${rootURI}pdfjs/wasm/`,
        }),
    });
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
                MINERU_LOCAL_PARSER_PROFILE_ID,
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
    const figureCanvasEnvironment = createZoteroFigureCanvasEnvironment(Zotero);
    const figureFallbackRenderer = createPDFFigureRegionRenderer({
        createCanvas: figureCanvasEnvironment.createCanvas,
        encodePNG: figureCanvasEnvironment.encodePNG,
        decodeImage: figureCanvasEnvironment.decodeImage,
        createAbortController: createZoteroAbortController,
        workerSrc: `${rootURI}pdf.worker.mjs`,
        cMapUrl: `${rootURI}pdfjs/cmaps/`,
        standardFontDataUrl: `${rootURI}pdfjs/standard_fonts/`,
        wasmUrl: `${rootURI}pdfjs/wasm/`,
        readBinaryAsset: (kind, filename) => readFigureBinaryAsset(rootURI, kind, filename),
    });
    const figureRegionRenderer = createWorkerFigureRegionRenderer({
        loadWorkerSource: () => loadFigureWorkerSource(rootURI).catch(error => {
            Zotero.debug(`Mktero: figure worker unavailable, using main-thread rendering (${error.message})`);
            throw error;
        }),
        createWorker: url => new (mainWindowWorker())(url),
        createObjectURL: url => Zotero.getMainWindow().URL.createObjectURL(url),
        revokeObjectURL: url => Zotero.getMainWindow().URL.revokeObjectURL(url),
        loadPdfAssets: () => loadFigurePDFAssets(rootURI).then(assets => {
            Zotero.debug(`Mktero: figure PDF assets loaded (${assets.size})`);
            return assets;
        }).catch(error => {
            Zotero.debug(`Mktero: figure PDF assets unavailable (${error.message}); non-embedded fonts may render incorrectly`);
            throw error;
        }),
        rendererOptions: {
            cMapUrl: `${rootURI}pdfjs/cmaps/`,
            standardFontDataUrl: `${rootURI}pdfjs/standard_fonts/`,
            wasmUrl: `${rootURI}pdfjs/wasm/`,
        },
        fallback: {
            open: (fileData, options) => figureFallbackRenderer.open(fileData, {
                ...options, ...figureCanvasEnvironment,
            }),
        },
        createAbortController: createZoteroAbortController,
    });
    runtime.figureRegionRenderer = figureRegionRenderer;
    runtime.figureFallbackRenderer = figureFallbackRenderer;
    const figureRestoration = new FigureRestorationService({
        openPDF: (fileData, options) => figureRegionRenderer.open(fileData, options),
        hash: sha256Hex,
        createAbortController: createZoteroAbortController,
    });
    const figureLabelRecovery = new FigureLabelRecoveryService({
        openPDF: (fileData, options) => figureRegionRenderer.open(fileData, options),
        hash: sha256Hex,
        createAbortController: createZoteroAbortController,
    });
    const figureReadingOrder = new FigureReadingOrderService({
        openPDF: (fileData, options) => figureRegionRenderer.open(fileData, options),
        hash: sha256Hex,
        createAbortController: createZoteroAbortController,
    });
    const recoverFigures = async (result, context) => figureReadingOrder.recover(
        await figureLabelRecovery.recover(result, context), context
    );
    const prepareWithFigures = (decode, prepare) => async (raw, context) => {
        const input = decode(raw);
        const draft = await figureRestoration.restore(input, context);
        return finalizeRestoredDocument(input, draft, {
            prepare, hash: sha256Hex, signal: context.signal,
        });
    };
    const progressiveWithFigures = (decode, prepare) => async (raw, context) => {
        const input = decode(raw);
        const run = createProgressiveFigureRunner({
            restoration: figureRestoration,
            prepare,
            finalize: finalizeRestoredDocument,
            hash: sha256Hex,
        });
        return run(input, {
            fileData: context.fileData,
            signal: context.signal,
            onEvent: context.onEvent,
        });
    };
    const restoreCachedFigures = (input, context) => createProgressiveFigureRunner({
        restoration: figureRestoration,
        prepare: prepareMinerUResult,
        finalize: finalizeRestoredDocument,
        hash: sha256Hex,
    })(input, {
        fileData: context.fileData,
        signal: context.signal,
        onEvent: context.onEvent,
    });
    const conversion = new MinerUConversion({
        client: new MinerUClient({
            createAbortController: createZoteroAbortController,
        }),
        pendingTasks,
        cache,
        prepareResult: prepareWithFigures(decodeMinerUFigureInput, prepareMinerUResult),
        progressiveResult: progressiveWithFigures(decodeMinerUFigureInput, prepareMinerUResult),
        restoreCachedInput: restoreCachedFigures,
        recoverFigures,
        createPreviousCacheKeys: fileData => Promise.all(
            MINERU_COMPATIBLE_CACHE_PROFILE_IDS.map(parserProfile => (
                createMarkdownCacheKey(fileData, { parserProfile })
            ))
        ),
        onError: error => Zotero.logError?.(error),
    });
    const localConversion = new MinerULocalConversion({
        client: new MinerULocalClient({
            createAbortController: createZoteroAbortController,
        }),
        cache,
        onError: error => Zotero.logError?.(error),
    });
    const mineruConversion = {
        convert(options) {
            if (getMinerUEndpoint(Zotero) !== MINERU_ENDPOINT_LOCAL) {
                return conversion.convert(options);
            }
            return localConversion.convert({
                ...options,
                apiKey: getMinerULocalApiKey(Zotero),
                apiBase: getMinerULocalApiBase(Zotero),
            });
        },
    };
    const mineruExtractor = new MinerUDocumentExtractor({
        zotero: Zotero,
        conversion: mineruConversion,
        getApiKey: () => getMinerUEndpoint(Zotero) === MINERU_ENDPOINT_LOCAL
            ? getMinerULocalApiKey(Zotero)
            : getMinerUApiKey(Zotero),
        getParserProfile: () => currentMinerUParserProfile(),
        getPreviousParserProfiles: () => (
            getMinerUEndpoint(Zotero) === MINERU_ENDPOINT_LOCAL
                ? []
                : [
                    ...MINERU_PREVIOUS_PARSER_PROFILE_IDS,
                    LEGACY_FIGURE_PROFILES.mineru,
                ]
        ),
        prepareResult: result => getMinerUEndpoint(Zotero) === MINERU_ENDPOINT_LOCAL
            && !result?.userEdited
            ? result
            : prepareMinerUResult(result),
        readFile: path => IOUtils.read(path),
        preparePDFIndex: (itemID, options) => preparePDFIndexForItem(
            itemID,
            options,
            pdfAnnotationLocator
        ),
        createCacheKey: (fileData, options) => createMinerUCacheKey(fileData, options),
        createSourceHash: fileData => sha256Hex(fileData),
        readRevision: options => readRevisionSnapshot(options),
        isCacheEnabled: () => getMinerUCacheEnabled(Zotero),
    });
    const mistralConversion = new MistralConversion({
        client: new MistralClient({
            createAbortController: createZoteroAbortController,
        }),
        cache,
        prepareResult: prepareWithFigures(decodeMistralResult, prepareMistralResult),
        recoverFigures,
        createPreviousCacheKeys: fileData => Promise.all(MISTRAL_PREVIOUS_PARSER_PROFILE_IDS.map(parserProfile => (
            createMarkdownCacheKey(fileData, { parserProfile })
        ))),
        onError: error => Zotero.logError?.(error),
    });
    const mistralExtractor = new MistralDocumentExtractor({
        zotero: Zotero,
        conversion: mistralConversion,
        getApiKey: () => getMistralApiKey(Zotero),
        readFile: path => IOUtils.read(path),
        preparePDFIndex: (itemID, options) => preparePDFIndexForItem(
            itemID,
            options,
            pdfAnnotationLocator
        ),
        createCacheKey: (fileData, options) => createMarkdownCacheKey(
            fileData,
            {
                parserProfile: MISTRAL_PARSER_PROFILE_ID,
                ...options,
            }
        ),
        createSourceHash: fileData => sha256Hex(fileData),
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
    runtime.conversionRuns = createConversionRunRegistry({
        createController: createZoteroAbortController,
        execute: executeItemConversion,
    });
    runtime.conversionBatch = createConversionBatch({
        isReady: candidate => itemHasReadableMarkdown(candidate.itemID),
        isActive: candidate => runtime.conversionRuns.isActive(candidate.itemID),
        isBlockedError: conversionNeedsSettings,
        convert: convertBatchItem,
        onEvent: handleBatchEvent,
        createController: createZoteroAbortController,
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
        handleLocalCacheCleared
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
    const runtimeWindow = Zotero.getMainWindow?.();
    runtime.reasoningCatalogStore = createAIReasoningCatalogStore({
        fetch: bindZoteroWindowFetch(Zotero),
        createAbortController: createZoteroAbortController,
        setTimer: typeof runtimeWindow?.setTimeout === 'function'
            ? runtimeWindow.setTimeout.bind(runtimeWindow)
            : undefined,
        clearTimer: typeof runtimeWindow?.clearTimeout === 'function'
            ? runtimeWindow.clearTimeout.bind(runtimeWindow)
            : undefined,
    });
    runtime.disposeReasoningCatalogHost = attachAIReasoningCatalogHost(
        Zotero,
        runtime.reasoningCatalogStore
    );
    void runtime.reasoningCatalogStore.load();
    Promise.resolve(readinessReady)
        .catch(error => Zotero.logError(error))
        .then(() => cache.prune())
        .then(() => cache.listReadableEntries())
        .then(entries => runtime.readiness?.retainLiveEntries(entries))
        .catch(error => Zotero.logError(error));
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

function mainWindowWorker() {
    const win = Zotero.getMainWindow();
    const WorkerType = win?.Worker || globalThis.Worker;
    if (typeof WorkerType !== 'function') throw new Error('Web Workers are unavailable');
    return WorkerType;
}

function logFigureAssetSizes(label, document) {
    const generated = (document?.assets || []).filter(asset => (
        typeof asset?.path === 'string' && asset.path.startsWith('generated/figures/')
    ));
    if (!generated.length) return;
    Zotero.debug(`Mktero: ${label}: figure assets ` + generated.map(asset => (
        `${asset.path.split('/').pop()}=${asset.data?.byteLength ?? '?'}`
    )).join(', '));
}

// PDF.js needs cMap/standard-font/WASM bytes that live inside the XPI. Read
// them from the archive (or a plain directory) once and reuse the map.
let figurePdfAssetsPromise = null;
function loadFigurePDFAssets(rootURI) {
    if (!figurePdfAssetsPromise) {
        figurePdfAssetsPromise = readFigurePDFAssets(rootURI).catch(error => {
            figurePdfAssetsPromise = null;
            throw error;
        });
    }
    return figurePdfAssetsPromise;
}

async function readFigurePDFAssets(rootURI) {
    const directories = [
        ['cMapUrl', 'pdfjs/cmaps/'],
        ['standardFontDataUrl', 'pdfjs/standard_fonts/'],
        ['wasmUrl', 'pdfjs/wasm/'],
    ];
    const assets = new Map();
    if (rootURI.startsWith('jar:')) {
        const inner = rootURI.slice('jar:'.length);
        const separator = inner.indexOf('!/');
        if (separator < 0) throw new Error('Unsupported extension root URI');
        const archivePath = Services.io.newURI(inner.slice(0, separator))
            .QueryInterface(Components.interfaces.nsIFileURL).file.path;
        const base = decodeURIComponent(inner.slice(separator + 2)).replace(/^\/+/u, '');
        const entries = unzipSync(await IOUtils.read(archivePath));
        for (const [kind, directory] of directories) {
            const prefix = base ? `${base}${directory}` : directory;
            for (const [name, data] of Object.entries(entries)) {
                if (name.startsWith(prefix) && !name.endsWith('/')) {
                    assets.set(`${kind}:${name.slice(prefix.length)}`, data);
                }
            }
        }
        if (!assets.size) throw new Error('No PDF assets found in the extension archive');
        return assets;
    }
    if (!rootURI.startsWith('file:')) throw new Error('Unsupported extension asset root');
    const basePath = Services.io.newURI(rootURI)
        .QueryInterface(Components.interfaces.nsIFileURL).file.path;
    for (const [kind, directory] of directories) {
        const path = PathUtils.join(basePath, directory.replace(/\/$/u, ''));
        for (const child of await IOUtils.getChildren(path)) {
            assets.set(`${kind}:${PathUtils.filename(child)}`, await IOUtils.read(child));
        }
    }
    if (!assets.size) throw new Error('No PDF assets found in the extension directory');
    return assets;
}

async function readFigureBinaryAsset(rootURI, kind, filename) {
    const assets = await loadFigurePDFAssets(rootURI);
    return assets.get(`${kind}:${filename}`) || null;
}


async function loadFigureWorkerSource(rootURI) {
    const url = `${rootURI}figure.worker.js`;
    const errors = [];
    if (typeof Zotero.File?.getContentsFromURLAsync === 'function') {
        try {
            const contents = await Zotero.File.getContentsFromURLAsync(url);
            if (typeof contents === 'string' && contents.length) return contents;
            if (ArrayBuffer.isView(contents) && contents.byteLength) {
                return new TextDecoder().decode(contents);
            }
            errors.push('URL read returned no data');
        }
        catch (error) { errors.push(String(error?.message || error)); }
    }
    if (url.startsWith('jar:')) {
        try {
            const inner = url.slice('jar:'.length);
            const separator = inner.indexOf('!/');
            if (separator > 0) {
                const archivePath = Services.io.newURI(inner.slice(0, separator))
                    .QueryInterface(Components.interfaces.nsIFileURL).file.path;
                const entry = decodeURIComponent(inner.slice(separator + 2)).replace(/^\/+/u, '');
                const archive = await IOUtils.read(archivePath);
                const entries = unzipSync(archive);
                const data = entries[entry];
                if (data?.length) return new TextDecoder().decode(data);
                errors.push(`XPI entry ${entry} is missing`);
            }
        }
        catch (error) { errors.push(String(error?.message || error)); }
    }
    try {
        const uri = Services.io.newURI(url);
        if (uri.schemeIs?.('file')) {
            const file = uri.QueryInterface(Components.interfaces.nsIFileURL).file;
            const contents = await IOUtils.readUTF8(file.path);
            if (contents.length) return contents;
        }
    }
    catch (error) { errors.push(String(error?.message || error)); }
    try {
        const contents = await IOUtils.readUTF8(url);
        if (typeof contents === 'string' && contents.length) return contents;
    }
    catch (error) { errors.push(String(error?.message || error)); }
    throw new Error(`Figure worker source unavailable: ${errors.join('; ')}`);
}

globalThis.shutdown = function shutdown() {
    abortAllConversions();
    abortAllTranslations();
    destroyAllRevisionSessions();
    runtime.reasoningCatalogStore?.dispose();
    runtime.disposeReasoningCatalogHost?.();
    runtime.disposeAnnotationObserver?.();
    runtime.disposeReferenceObserver?.();
    runtime.referenceImportService?.dispose?.();
    runtime.disposeCacheObserver?.();
    runtime.disposeAITargetLanguageObserver?.();
    runtime.disposeConversionProfileObserver?.();
    runtime.cache?.setStoreChangeListener?.(null);
    runtime.readinessColumn?.dispose();
    runtime.readiness?.dispose();
    runtime.localAnnotations?.dispose();
    runtime.pdfAnnotationLocator?.dispose();
    void runtime.sourcePeekRenderer?.disposeAll();
    void runtime.figureRegionRenderer?.disposeAll();
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
    runtime.conversionRuns = null;
    runtime.conversionBatch = null;
    runtime.conversionActivity = null;
    runtime.conversionProgress = null;
    runtime.cache = null;
    runtime.readiness = null;
    runtime.readinessColumn = null;
    runtime.disposeConversionProfileObserver = null;
    runtime.translationService = null;
    runtime.translationRequests = null;
    runtime.revisionStore = null;
    runtime.readingPositions = null;
    runtime.revisionSessions = null;
    runtime.pdfTextIndexCache = null;
    runtime.pdfAnnotationLocator = null;
    runtime.sourcePeekRenderer = null;
    runtime.figureRegionRenderer = null;
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
    runtime.reasoningCatalogStore = null;
    runtime.disposeReasoningCatalogHost = null;
    runtime.id = null;
};

globalThis.uninstall = async function uninstall() {};
globalThis.onMainWindowLoad = function onMainWindowLoad({ window }) {
    registerMainWindowContextMenu(window);
    installProgressButton(window);
};
globalThis.onMainWindowUnload = function onMainWindowUnload({ window }) {
    disposeMainWindowContextMenu(window);
    disposeProgressButton(window);
    runtime.citationPresenter?.closeForWindow(window);
};

async function openReaderAsMarkdown(reader, { forceRefresh = false } = {}) {
    return openItemAsMarkdown(reader.itemID, {
        forceRefresh,
        entryPoint: 'reader-toolbar',
    });
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
            releaseTabConversion(itemID, reason);
            void runtime.sourcePeekRenderer?.dispose(itemID);
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
        onTranslateSelection: ({ text, onTextDelta } = {}) => (
            translateSelection(itemID, { text, onTextDelta })
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
        onRenderSourcePeek: (location, options) => (
            runtime.sourcePeekRenderer?.render(itemID, location, options)
        ),
        onDisposeSourcePeek: () => runtime.sourcePeekRenderer?.dispose(itemID),
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
        onReadingPositionChange: anchor => saveReadingPosition(itemID, anchor),
    });
    if (presentation.created) {
        void runtime.actionsTags?.openMarkdownSession({
            sessionID: itemID,
            sourceItemID: itemID,
            entryPoint,
        });
    }
    if (!forceRefresh
        && !presentation.created
        && presentation.model.status === 'loading') return;
    if (!forceRefresh && isItemPreparing(itemID)) {
        await adoptPreparedConversion(presentation, itemID);
        return;
    }
    if (!presentation.created
        && presentation.model.status !== 'error'
        && !forceRefresh) return;

    const previousResult = forceRefresh
        ? snapshotReadyResult(presentation.model)
        : null;
    if (forceRefresh) markConversionActivity(itemID);
    const begun = runtime.conversionRuns.begin({
        itemID,
        owner: 'tab',
        forceRefresh,
    });
    runtime.presenter.update(
        presentation,
        createConversionLoadingChanges(previousResult, runtimeTranslate)
    );
    const unsubscribe = subscribeTabConversion(presentation, itemID, {
        batchOwned: false,
    });
    try {
        const result = await begun.run.promise;
        await publishConversionResult(
            presentation,
            itemID,
            result,
            begun.run.signal
        );
    }
    catch (error) {
        if (begun.run.signal.aborted || presentation.closed) return;
        publishConversionFailure(presentation, itemID, error, previousResult);
    }
    finally {
        unsubscribe();
        clearConversionActivity(itemID);
    }
}

function releaseTabConversion(itemID, reason) {
    if (reason !== MARKDOWN_TAB_CLOSE_REASONS.SHUTDOWN
        && runtime.conversionRuns?.isActive(itemID)) {
        continueConversionInBackground(itemID);
        return;
    }
    runtime.conversionRuns?.release(itemID, 'tab');
}

function continueConversionInBackground(itemID) {
    if (runtime.conversionBatch?.isPreparing(itemID)
        || backgroundContinuations.has(itemID)) {
        runtime.conversionRuns.release(itemID, 'tab', { abortIfLast: false });
        return;
    }
    const run = runtime.conversionRuns.get(itemID);
    if (!run) {
        runtime.conversionRuns.release(itemID, 'tab', { abortIfLast: false });
        return;
    }
    runtime.conversionRuns.attach(itemID, 'background');
    runtime.conversionRuns.release(itemID, 'tab', { abortIfLast: false });
    ensureConversionProgress();
    runtime.conversionProgress?.add(itemID, conversionItemTitle(itemID));
    updateProgressRow(
        runtime.conversionProgress,
        itemID,
        'processing',
        conversionStageDetail(0, {}, runtimeTranslate)
    );
    runtime.conversionProgress?.setStatus(runtimeTranslate('batch.statusHint'));
    runtime.conversionProgress?.open();
    markConversionActivity(itemID);
    const unsubscribe = runtime.conversionRuns.subscribe(itemID, event => {
        if (event.type !== 'progress') return;
        updateProgressRow(
            runtime.conversionProgress,
            itemID,
            'processing',
            conversionStageDetail(event.progress, event.state, runtimeTranslate)
        );
    });
    backgroundContinuations.set(itemID, unsubscribe);
    void run.promise.then(result => {
        void rememberMarkdownReadiness(itemID, result)
            .finally(() => clearConversionActivity(itemID));
        updateProgressRow(
            runtime.conversionProgress,
            itemID,
            'succeeded',
            runtimeTranslate('batch.ready')
        );
    }, error => {
        if (isCancellation(error)) {
            clearConversionActivity(itemID);
            runtime.conversionProgress?.remove(itemID);
            return;
        }
        clearConversionActivity(itemID);
        updateProgressRow(
            runtime.conversionProgress,
            itemID,
            'failed',
            userFacingError(error)
        );
        if (conversionNeedsSettings(error)) openMinerUPreferences(Zotero);
    }).finally(() => {
        unsubscribe();
        backgroundContinuations.delete(itemID);
        runtime.conversionRuns?.release(itemID, 'background', {
            abortIfLast: false,
        });
    });
}

function cancelBackgroundContinuations() {
    cancelPreparation([...backgroundContinuations.keys()]);
}

function cancelPreparation(itemIDs) {
    for (const itemID of itemIDs) {
        cancelledPreparations.add(itemID);
        runtime.conversionRuns?.abort(itemID, 'cancelled');
        forceClearConversionActivity(itemID);
    }
}

function conversionItemTitle(itemID) {
    const item = Zotero.Items?.get?.(itemID);
    const parentID = item?.parentItemID || item?.parentID;
    const parent = item?.parentItem
        || (parentID ? Zotero.Items?.get?.(parentID) : null);
    const title = String(parent?.getDisplayTitle?.()
        || item?.getDisplayTitle?.()
        || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!title) return 'PDF';
    return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

function isItemPreparing(itemID) {
    return runtime.conversionBatch?.isPreparing(itemID) === true
        || runtime.conversionRuns?.isActive(itemID) === true;
}

async function adoptPreparedConversion(presentation, itemID) {
    runtime.conversionRuns?.attach(itemID, 'tab');
    const showQueue = () => {
        const position = runtime.conversionBatch?.position(itemID);
        if (!position || position.status !== 'queued' || presentation.closed) {
            return false;
        }
        runtime.presenter?.update(presentation, {
            ...createConversionLoadingChanges(null, runtimeTranslate),
            batchOwned: true,
            queueAhead: position.ahead,
        });
        return true;
    };
    showQueue();
    const unsubscribeRun = subscribeTabConversion(presentation, itemID, {
        batchOwned: true,
    });
    const stopQueue = watchBatchItem(itemID, () => {
        if (presentation.closed) return;
        showQueue();
        runtime.conversionRuns?.attach(itemID, 'tab');
    });
    try {
        const result = runtime.conversionBatch?.isPreparing(itemID)
            ? await runtime.conversionBatch.wait(itemID)
            : await runtime.conversionRuns.get(itemID)?.promise;
        if (!result) return;
        await publishConversionResult(presentation, itemID, result);
    }
    catch (error) {
        if (isCancellation(error) || presentation.closed) return;
        publishConversionFailure(presentation, itemID, error, null);
    }
    finally {
        unsubscribeRun();
        stopQueue();
    }
}

function watchBatchItem(itemID, listener) {
    let watchers = batchItemWatchers.get(itemID);
    if (!watchers) {
        watchers = new Set();
        batchItemWatchers.set(itemID, watchers);
    }
    watchers.add(listener);
    return () => {
        watchers.delete(listener);
        if (!watchers.size) batchItemWatchers.delete(itemID);
    };
}

function notifyBatchItem(itemID) {
    for (const listener of batchItemWatchers.get(itemID) || []) {
        try {
            listener();
        }
        catch {
            // A closed reader must not stop the preparation queue.
        }
    }
}

function subscribeTabConversion(presentation, itemID, { batchOwned }) {
    let progressivePublished = false;
    return runtime.conversionRuns.subscribe(itemID, event => {
        if (presentation.closed) return;
        if (event.type === 'progress') {
            const progress = normalizeConversionProgress(event.progress);
            if (progress < CONVERSION_PROGRESS.COMPLETE) {
                markConversionActivity(itemID);
            }
            if (progressivePublished) return;
            runtime.presenter?.update(presentation, {
                ...createConversionProgressChanges(progress, event.state),
                batchOwned,
                queueAhead: null,
            });
            return;
        }
        if (event.type !== 'progressive') return;
        applyProgressiveFigureUpdate(presentation, event.event, {
            updateDocument(_presentation, documentEvent) {
                if (progressivePublished) return;
                progressivePublished = true;
                logFigureAssetSizes(
                    `item ${itemID}: progressive`,
                    documentEvent.document
                );
                runtime.presenter?.update(presentation, {
                    ...documentEvent.document,
                    status: 'ready',
                    progress: 100,
                    preserveContent: false,
                    batchOwned,
                    queueAhead: null,
                    figureRestoration: { status: 'pending' },
                    ...(documentEvent.pendingFigureAssets instanceof Map
                        ? {
                            pendingFigureAssets:
                                documentEvent.pendingFigureAssets,
                        }
                        : {}),
                });
            },
            showRestoredFigure(_presentation, figure) {
                presentation.view.showRestoredFigure(figure);
            },
        });
    });
}

async function executeItemConversion(itemID, {
    controller,
    signal,
    forceRefresh,
    onProgress,
    onProgressiveFigures,
}) {
    runtime.pdfIndexOperations.start(itemID, controller);
    let lastLoggedProgress = null;
    Zotero.debug(
        `Mktero: conversion started for item ${itemID} `
        + `(force refresh: ${forceRefresh})`
    );
    try {
        const result = await runtime.service.convert(itemID, {
            signal,
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
                onProgress(normalizedProgress, state);
            },
            onProgressiveFigures(event) {
                if (!event || signal.aborted) return;
                if (event.type === 'figure') {
                    Zotero.debug(
                        `Mktero: item ${itemID}: figure ${event.figure?.id} `
                        + `${event.figure?.status}`
                    );
                    onProgressiveFigures(event);
                    return;
                }
                noteProgressiveDocument(itemID, event);
                onProgressiveFigures(event);
            },
        });
        Zotero.debug(
            result.cacheHit
                ? `Mktero: item ${itemID}: completed from local cache`
                : result.resumedTask
                    ? `Mktero: item ${itemID}: completed from a resumed conversion task`
                    : `Mktero: item ${itemID}: completed through a new conversion request`
        );
        return result;
    }
    finally {
        backgroundFigureRestorations.delete(itemID);
        runtime.pdfIndexOperations.finish(itemID, controller);
    }
}

function noteProgressiveDocument(itemID, event) {
    if (!event || event.type !== 'document') return;
    backgroundFigureRestorations.add(itemID);
    if (event.figureInput) {
        Zotero.debug(`Mktero: item ${itemID}: progressive figures started`);
    }
    if (!(event.figureInput && event.cacheKey && runtime.cache
        && getMinerUCacheEnabled(Zotero))) {
        return;
    }
    runtime.cache.put(event.cacheKey, event.document, {
        figureRestoration: {
            status: 'pending',
            input: event.figureInput,
            completedFigureIds: [],
        },
    }).then(() => rememberMarkdownReadiness(itemID, {
        cacheKey: event.cacheKey,
        parserProfile: currentConversionParserProfile(),
    })).catch(error => Zotero.logError?.(error));
}

async function publishConversionResult(presentation, itemID, result, signal) {
    if (!result || presentation.closed || signal?.aborted) return;
    void rememberMarkdownReadiness(itemID, result);
    const revisionResult = await attachRevisionSession(itemID, result, signal);
    throwIfRevisionAborted(signal);
    if (presentation.closed) return;
    const positionedResult = await attachReadingPosition(revisionResult);
    const readyResult = await attachCachedDocumentTranslation(
        positionedResult,
        signal
    );
    if (presentation.closed || signal?.aborted) return;
    logFigureAssetSizes(`item ${itemID}: final`, readyResult);
    runtime.presenter?.update(
        presentation,
        createConversionReadyChanges(
            localizeConversionResult(readyResult, runtimeTranslate)
        )
    );
}

function publishConversionFailure(presentation, itemID, error, previousResult) {
    if (presentation.closed) return;
    Zotero.debug(
        `Mktero: conversion failed for item ${itemID}: ${userFacingError(error)}`
    );
    Zotero.logError(error);
    if (conversionNeedsSettings(error)) openMinerUPreferences(Zotero);
    runtime.presenter?.update(
        presentation,
        createConversionFailureChanges(
            userFacingError(error),
            previousResult,
            runtimeTranslate,
            {
                errorAction: conversionNeedsSettings(error)
                    ? 'open-settings'
                    : null,
            }
        )
    );
}

function conversionNeedsSettings(error) {
    return error instanceof MinerUConfigurationError
        || error instanceof MistralConfigurationError
        || error?.code === 'MINERU_API_KEY_INVALID'
        || error?.code === 'MISTRAL_API_KEY_INVALID'
        || error?.code === 'MISTRAL_API_KEY_REQUIRED';
}

function prepareSelectedMarkdown(targets) {
    if (!runtime.conversionBatch) return;
    for (const target of targets || []) cancelledPreparations.delete(target.itemID);
    ensureConversionProgress();
    const summary = runtime.conversionBatch.enqueue(targets);
    runtime.conversionProgress?.setStatus(batchStatusMessage(summary));
    if (summary.accepted.length
        || summary.skippedReady.length
        || summary.skippedActive.length
        || summary.skippedQueued.length) {
        runtime.conversionProgress?.open();
    }
    refreshMarkdownReadinessColumn(Zotero);
}

function ensureConversionProgress() {
    if (runtime.conversionProgress || !runtime.conversionBatch) return;
    runtime.conversionProgress = createZoteroConversionProgress({
        zotero: Zotero,
        services: typeof Services === 'undefined' ? null : Services,
        title: runtimeTranslate('batch.windowTitle'),
        onCancel: () => {
            cancelPreparation(runtime.conversionBatch?.cancel() || []);
            cancelBackgroundContinuations();
        },
    });
    installProgressButtons();
}

function installProgressButtons() {
    const windows = Zotero.getMainWindows?.()
        || [Zotero.getMainWindow?.()].filter(Boolean);
    for (const window of windows) installProgressButton(window);
}

function installProgressButton(window) {
    if (!window || !runtime.conversionProgress) return;
    disposeProgressButton(window);
    const rootURI = runtime.rootURI || '';
    const dispose = installZoteroConversionProgressButton({
        zotero: Zotero,
        window,
        title: runtimeTranslate('batch.windowTitle'),
        iconURL: `${rootURI}${rootURI.endsWith('/') ? '' : '/'}ui/icons/mktero.svg`,
    });
    if (dispose) progressButtonDisposers.set(window, dispose);
}

function disposeProgressButton(window) {
    progressButtonDisposers.get(window)?.();
    progressButtonDisposers.delete(window);
}

function disposeProgressButtons() {
    for (const window of [...progressButtonDisposers.keys()]) {
        disposeProgressButton(window);
    }
}

async function convertBatchItem(item, { signal, onProgress }) {
    const begun = runtime.conversionRuns.begin({
        itemID: item.itemID,
        owner: 'batch',
    });
    const unsubscribe = runtime.conversionRuns.subscribe(item.itemID, event => {
        if (event.type === 'progress') onProgress(event.progress, event.state);
    });
    const releaseBatch = () => {
        runtime.conversionRuns.release(item.itemID, 'batch');
    };
    signal.addEventListener('abort', releaseBatch, { once: true });
    try {
        return await begun.run.promise;
    }
    finally {
        signal.removeEventListener('abort', releaseBatch);
        unsubscribe();
        runtime.conversionRuns.release(item.itemID, 'batch', {
            abortIfLast: false,
        });
    }
}

function handleBatchEvent(event) {
    const item = event.item;
    const progress = runtime.conversionProgress;
    if (event.type === 'queued') {
        markConversionActivity(item.itemID, { refresh: false });
        progress?.add(item.itemID, item.title);
        updateProgressRow(progress, item.itemID, 'queued', queueStatus(event.ahead));
    }
    else if (event.type === 'position' && item) {
        updateProgressRow(progress, item.itemID, 'queued', queueStatus(event.ahead));
    }
    else if (event.type === 'started') {
        updateProgressRow(
            progress,
            item.itemID,
            'processing',
            conversionStageDetail(0, {}, runtimeTranslate)
        );
    }
    else if (event.type === 'progress') {
        if (normalizeConversionProgress(event.progress) < CONVERSION_PROGRESS.COMPLETE) {
            markConversionActivity(item.itemID);
        }
        updateProgressRow(
            progress,
            item.itemID,
            'processing',
            conversionStageDetail(event.progress, event.state, runtimeTranslate)
        );
    }
    else if (event.type === 'succeeded') {
        if (cancelledPreparations.has(item.itemID)) return;
        void rememberMarkdownReadiness(item.itemID, event.result)
            .finally(() => clearConversionActivity(item.itemID));
        updateProgressRow(
            progress,
            item.itemID,
            'succeeded',
            runtimeTranslate('batch.ready')
        );
    }
    else if (event.type === 'failed') {
        clearConversionActivity(item.itemID);
        updateProgressRow(
            progress,
            item.itemID,
            'failed',
            userFacingError(event.error)
        );
        if (conversionNeedsSettings(event.error)) {
            openMinerUPreferences(Zotero);
        }
    }
    else if (event.type === 'cancelled' || event.type === 'released') {
        clearConversionActivity(item.itemID);
        progress?.remove(item.itemID);
    }
    if (item) notifyBatchItem(item.itemID);
}

function updateProgressRow(progress, itemID, status, message) {
    if (!progress?.statuses || !progress.update) return;
    progress.update(itemID, progress.statuses[status], message);
}

function queueStatus(ahead) {
    return ahead > 0
        ? runtimeTranslate('batch.queueAhead', { count: ahead })
        : runtimeTranslate('batch.queued');
}

function batchStatusMessage(summary) {
    const parts = [runtimeTranslate('batch.statusHint')];
    if (summary.skippedReady.length) {
        parts.push(runtimeTranslate('batch.skippedReady', {
            count: summary.skippedReady.length,
        }));
    }
    const preparing = summary.skippedActive.length + summary.skippedQueued.length;
    if (preparing) {
        parts.push(runtimeTranslate('batch.skippedActive', { count: preparing }));
    }
    return parts.join(' ');
}

function itemHasReadableMarkdown(itemID) {
    const item = Zotero.Items?.get?.(itemID);
    return runtime.readiness?.isReady(
        item,
        currentConversionParserProfile()
    ) === true;
}

function markConversionActivity(itemID, { refresh = true } = {}) {
    if (cancelledPreparations.has(itemID)) return false;
    const identity = conversionActivityIdentity(itemID);
    if (!identity) return false;
    const changed = runtime.conversionActivity?.mark(identity) === true;
    if (changed && refresh) refreshMarkdownReadinessColumn(Zotero);
    return changed;
}

function clearConversionActivity(itemID) {
    if (isItemPreparing(itemID)) return false;
    return forceClearConversionActivity(itemID);
}

function forceClearConversionActivity(itemID) {
    const identity = conversionActivityIdentity(itemID);
    if (!identity) return false;
    const changed = runtime.conversionActivity?.clear(identity) === true;
    if (changed) refreshMarkdownReadinessColumn(Zotero);
    return changed;
}

function conversionActivityIdentity(itemID) {
    const item = Zotero.Items?.get?.(itemID);
    return resolveMarkdownReadinessIdentity(readinessItem(item));
}

function isCancellation(error) {
    return error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR'
        || error?.code === 'MKTERO_CONVERSION_REPLACED';
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
        onRenderSourcePeek: withSource((itemID, location, options) => (
            runtime.sourcePeekRenderer?.render(itemID, location, options)
        )),
        onDisposeSourcePeek: () => {
            const sourceItemID = currentSourceItemID();
            if (!sourceItemID) return undefined;
            return runtime.sourcePeekRenderer?.dispose(sourceItemID);
        },
        onCopySourcedMarkdown: withSource((itemID, target) => (
            copySourcedMarkdown(itemID, target)
        )),
        onCopyCode: code => copyCode(code),
        onTranslateSelection: ({ text, onTextDelta } = {}) => (
            translateSelection(noteID, { text, onTextDelta })
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

async function attachReadingPosition(result) {
    if (!runtime.readingPositions
        || typeof result?.sourceHash !== 'string'
        || typeof result?.cacheKey !== 'string'
        || typeof result?.markdown !== 'string') {
        return result;
    }
    try {
        const record = await runtime.readingPositions.load(
            result.sourceHash,
            result.cacheKey
        );
        if (!record?.anchor) return result;
        return {
            ...result,
            restoreReadingOffset: resolveMarkdownReadingPosition(
                result.markdown,
                record.anchor
            ),
        };
    }
    catch (error) {
        Zotero.logError?.(error);
        return result;
    }
}

function saveReadingPosition(itemID, anchor) {
    const model = runtime.presenter?.get(itemID)?.model;
    if (!runtime.readingPositions
        || typeof model?.sourceHash !== 'string'
        || typeof model?.cacheKey !== 'string') {
        return;
    }
    Promise.resolve(runtime.readingPositions.save(model.sourceHash, {
        cacheKey: model.cacheKey,
        anchor,
    })).catch(error => Zotero.logError?.(error));
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
            figureMap: result.figureMap || null,
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
                chromeRanges: presentation.model.chromeRanges,
                figureMap: presentation.model.figureMap,
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
                    chromeRanges: snapshot.chromeRanges,
                    figureMap: snapshot.figureMap,
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

function handleLocalCacheCleared() {
    resetOpenDocumentTranslations();
    // Preferences clears a separate cache instance, so the column index
    // does not see that instance's store-change event.
    void runtime.readiness?.clear();
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
                chromeRanges: result.chromeRanges,
                figureMap: result.figureMap,
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
            chromeRanges: presentation.model.chromeRanges,
            figureMap: presentation.model.figureMap,
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
            : currentMinerUParserProfile();
    const cacheKey = await createMarkdownCacheKey(await IOUtils.read(filePath), {
        parserProfile,
    });
    const saved = await runtime.revisionStore.load(cacheKey);
    if (!saved) return null;
    return replaceRevisionSession(itemID, saved.base);
}

function currentMinerUParserProfile() {
    return getMinerUEndpoint(Zotero) === MINERU_ENDPOINT_LOCAL
        ? MINERU_LOCAL_PARSER_PROFILE_ID
        : MINERU_PARSER_PROFILE_ID;
}

function currentConversionParserProfile() {
    return getConversionProvider(Zotero) === CONVERSION_PROVIDER_MISTRAL
        ? MISTRAL_PARSER_PROFILE_ID
        : currentMinerUParserProfile();
}

function initializeMarkdownReadiness(cache, pluginID, rootURI) {
    try {
        const store = createZoteroMarkdownReadinessStore({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        });
        runtime.readiness = createMarkdownReadinessController({
            store,
            onChange: () => refreshMarkdownReadinessColumn(Zotero),
            onError: error => Zotero.logError?.(error),
        });
        cache.setStoreChangeListener?.(event => {
            void runtime.readiness?.handleCacheEvent(event);
        });
        runtime.readinessColumn = registerMarkdownReadinessColumn({
            zotero: Zotero,
            pluginID,
            rootURI,
            isReady: item => runtime.readiness?.isReady(
                item,
                currentConversionParserProfile()
            ) === true,
            isPreparing: item => runtime.conversionActivity?.isActive(item) === true,
            translate: runtimeTranslate,
            onError: error => Zotero.logError?.(error),
        });
        runtime.disposeConversionProfileObserver = observeConversionProfile(
            Zotero,
            () => refreshMarkdownReadinessColumn(Zotero)
        );
        return runtime.readiness.load();
    }
    catch (error) {
        Zotero.logError?.(error);
        return Promise.resolve();
    }
}

async function rememberMarkdownReadiness(itemID, result) {
    if (cancelledPreparations.has(itemID)) return;
    if (!runtime.readiness || !runtime.cache || !result?.cacheKey) return;
    const parserProfile = result.parserProfile || currentConversionParserProfile();
    if (parserProfile !== currentConversionParserProfile()) return;
    try {
        const readable = await runtime.cache.hasReadable(result.cacheKey);
        if (!readable) {
            await runtime.readiness.forgetCacheKeys(result.cacheKey);
            return;
        }
        const item = Zotero.Items?.get?.(itemID)
            || await Zotero.Items?.getAsync?.(itemID);
        const identity = resolveMarkdownReadinessIdentity(readinessItem(item));
        if (!identity) return;
        await runtime.readiness.remember({
            ...identity,
            cacheKey: result.cacheKey,
            parserProfile,
            expiresAt: readable.expiresAt || (Date.now() + MARKDOWN_CACHE_MAX_AGE_MS),
        });
    }
    catch (error) {
        Zotero.logError?.(error);
    }
}

function readinessItem(item) {
    if (!item) return null;
    const parentID = item.parentItemID || item.parentID;
    const parent = item.parentItem
        || (parentID ? Zotero.Items?.get?.(parentID) : null);
    return {
        libraryID: item.libraryID,
        key: item.key,
        parentItem: parent ? {
            libraryID: parent.libraryID ?? item.libraryID,
            key: parent.key,
        } : null,
    };
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
        : currentMinerUParserProfile();
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
        figureMap: model.figureMap,
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
            figureMap: model.figureMap,
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
    runtime.conversionBatch?.cancel();
    cancelBackgroundContinuations();
    runtime.conversionRuns?.abortAll('shutdown');
    runtime.pdfIndexOperations.abortAll();
    if (runtime.conversionActivity?.clearAll()) {
        refreshMarkdownReadinessColumn(Zotero);
    }
    runtime.conversionProgress?.cancel();
    disposeProgressButtons();
}

function trackPDFIndexTask(tracker, itemID, options, locator) {
    const task = locator.prepare(itemID, options);
    return tracker.track(itemID, options.signal, task);
}

function preparePDFIndexForItem(itemID, options, locator) {
    const task = trackPDFIndexTask(
        runtime.pdfIndexOperations,
        itemID,
        options,
        locator
    );
    void Promise.resolve(task).then(index => {
        applyPdfOutlineToOpenMarkdown(itemID, index?.outline);
    }).catch(() => {});
    return task;
}

function applyPdfOutlineToOpenMarkdown(itemID, outline) {
    const presentation = runtime.presenter?.get(itemID)
        || runtime.presenter?.getForSourceItem?.(itemID);
    if (!presentation || presentation.closed) return;
    runtime.presenter.update(presentation, {
        pdfOutline: Array.isArray(outline) ? outline : [],
    });
}

function registerMainWindowContextMenu(window) {
    if (!window || !runtime.id || runtime.contextMenus.has(window)) return;
    const disposeItemMenu = registerItemContextMenu({
        zotero: Zotero,
        window,
        rootURI: runtime.rootURI,
        onOpen: openItemAsMarkdown,
        onPrepare: prepareSelectedMarkdown,
        onOpenSavedNote: openSavedMarkdownNote,
        isPreparing: isItemPreparing,
        isSavedMarkdownNote: item => (
            runtime.savedMarkdownStore?.isSavedMarkdownNote(item) || false
        ),
        onError: handleOpenError,
        translate: runtimeTranslate,
    });
    const disposeCollectionMenu = registerCollectionContextMenu({
        zotero: Zotero,
        window,
        onPrepare: prepareSelectedMarkdown,
        onError: handleOpenError,
        translate: runtimeTranslate,
    });
    if (!disposeItemMenu && !disposeCollectionMenu) return;
    runtime.contextMenus.set(window, () => {
        disposeItemMenu?.();
        disposeCollectionMenu?.();
    });
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
