import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import { translateEnglish } from '../i18n/localization.js';

const READY_RESULT_FIELDS = [
    'title',
    'markdown',
    'assets',
    'assetBasePath',
    'sourceKind',
    'provider',
    'parserProfile',
    'cacheHit',
    'cacheKey',
    'sourceHash',
    'sourceMap',
    'figureMap',
    'pdfOutline',
    'extractedPages',
    'totalPages',
    'annotationOverlay',
    'warnings',
    'editableBlocks',
    'correctedBlockIDs',
    'correctionCount',
    'hasCorrections',
    'correctionMode',
    'translationView',
    'translationStatus',
    'translationProgress',
    'translationCompletedBlocks',
    'translationTotalBlocks',
    'translationStage',
    'translationTargetLanguage',
    'translationConfiguredTargetLanguage',
    'translationRequestedTargetLanguage',
    'translationCachedLanguages',
    'translationPartialLanguages',
    'translationKey',
    'translationSettingsIdentity',
    'translationBlocks',
    'translationSourceBlocks',
    'translationFailedBlocks',
    'translationBlockRanges',
    'translatedMarkdown',
    'comparisonMarkdown',
    'comparisonSourceRanges',
    'comparisonTranslationRanges',
    'translationError',
];

export function snapshotReadyResult(model) {
    if (model?.status !== 'ready') return null;
    const snapshot = {};
    for (const field of READY_RESULT_FIELDS) {
        if (field === 'provider' || field === 'parserProfile') {
            const value = boundedIdentity(
                model[field],
                field === 'provider' ? 64 : 4_096
            );
            if (value) snapshot[field] = value;
            continue;
        }
        if (model[field] !== undefined) snapshot[field] = model[field];
    }
    snapshot.warnings = [...(model.warnings || [])];
    return snapshot;
}

export function createConversionLoadingChanges(
    previousResult,
    translate = translateEnglish
) {
    if (previousResult) {
        return {
            ...previousResult,
            title: translate('loading.reparsingTitle'),
            status: 'loading',
            progress: 0,
            error: '',
            errorAction: null,
            warningAction: null,
            preserveContent: true,
            resumingTask: false,
            ...createEmptyTranslationState(),
        };
    }
    return {
        status: 'loading',
        progress: 0,
        markdown: '',
        assets: [],
        assetBasePath: '',
        cacheHit: false,
        cacheKey: null,
        sourceHash: null,
        sourceMap: [],
        figureMap: null,
        annotationOverlay: createEmptyAnnotationOverlay(),
        warnings: [],
        editableBlocks: [],
        correctedBlockIDs: [],
        correctionCount: 0,
        hasCorrections: false,
        correctionMode: false,
        ...createEmptyTranslationState(),
        error: '',
        errorAction: null,
        warningAction: null,
        preserveContent: false,
        resumingTask: false,
    };
}

export function createConversionProgressChanges(progress, state = {}) {
    return {
        status: 'loading',
        progress,
        resumingTask: Boolean(state?.resumingTask),
    };
}

export function createTranslationLoadingChanges({
    model,
    previousTranslation,
    targetLanguage,
    retryBlockIDs = null,
    forceRetranslate = false,
}) {
    const continuingTarget = previousTranslation?.targetLanguage
        === targetLanguage;
    if (!previousTranslation || !continuingTarget) {
        return {
            translationProgress: 0,
            translationCompletedBlocks: 0,
            translationTotalBlocks: 0,
        };
    }
    const requestedIDs = new Set(
        Array.isArray(retryBlockIDs) ? retryBlockIDs.map(String) : []
    );
    const previousFailureIDs = new Set(
        (previousTranslation.failedBlocks || []).map(failure => failure.id)
    );
    const retranslatedSuccessfulBlocks = [...requestedIDs].filter(
        id => !previousFailureIDs.has(id)
    ).length;
    const total = Math.max(0, Number(model.translationTotalBlocks) || 0);
    const completed = forceRetranslate
        ? 0
        : Math.max(
            0,
            (Number(model.translationCompletedBlocks) || 0)
                - retranslatedSuccessfulBlocks
        );
    return {
        translationProgress: total
            ? Math.round(Math.min(completed, total) / total * 100)
            : 0,
        translationCompletedBlocks: Math.min(completed, total),
        translationTotalBlocks: total,
    };
}

export function createConversionReadyChanges(result) {
    const changes = {
        assets: [],
        assetBasePath: '',
        cacheKey: null,
        sourceHash: null,
        sourceMap: [],
        figureMap: null,
        annotationOverlay: createEmptyAnnotationOverlay(),
        editableBlocks: [],
        correctedBlockIDs: [],
        correctionCount: 0,
        hasCorrections: false,
        correctionMode: false,
        ...createEmptyTranslationState(),
        ...result,
        status: 'ready',
        progress: 100,
        preserveContent: false,
        resumingTask: false,
        errorAction: null,
        warningAction: null,
    };
    if (changes.provider !== undefined) {
        changes.provider = boundedIdentity(changes.provider, 64);
        if (!changes.provider) delete changes.provider;
    }
    if (changes.parserProfile !== undefined) {
        changes.parserProfile = boundedIdentity(changes.parserProfile, 4_096);
        if (!changes.parserProfile) delete changes.parserProfile;
    }
    return changes;
}

export function createConversionFailureChanges(
    message,
    previousResult,
    translate = translateEnglish,
    { errorAction = null } = {}
) {
    if (previousResult) {
        return {
            ...previousResult,
            status: 'ready',
            progress: 100,
            warnings: [
                ...(previousResult.warnings || []),
                translate('tab.reparseFailed', { message }),
            ],
            error: '',
            errorAction: null,
            warningAction: errorAction,
            preserveContent: false,
            resumingTask: false,
            ...createEmptyTranslationState(),
        };
    }
    return {
        status: 'error',
        error: message,
        errorAction,
        warningAction: null,
        preserveContent: false,
        resumingTask: false,
    };
}

export function createEmptyTranslationState() {
    return {
        translationView: 'original',
        translationStatus: 'none',
        translationProgress: 0,
        translationCompletedBlocks: 0,
        translationTotalBlocks: 0,
        translationStage: '',
        translationTargetLanguage: '',
        translationConfiguredTargetLanguage: '',
        translationRequestedTargetLanguage: '',
        translationCachedLanguages: [],
        translationPartialLanguages: [],
        translationKey: null,
        translationSettingsIdentity: '',
        translationBlocks: [],
        translationSourceBlocks: [],
        translationFailedBlocks: [],
        translationBlockRanges: [],
        translatedMarkdown: '',
        comparisonMarkdown: '',
        comparisonSourceRanges: [],
        comparisonTranslationRanges: [],
        translationError: '',
    };
}

function boundedIdentity(value, maxLength) {
    if (typeof value !== 'string'
        || !value
        || value.length > maxLength
        || /[\u0000-\u001F\u007F]/.test(value)) {
        return null;
    }
    return value;
}
