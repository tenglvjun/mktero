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
    'cacheHit',
    'cacheKey',
    'sourceMap',
    'extractedPages',
    'totalPages',
    'annotationOverlay',
    'warnings',
];

export function snapshotReadyResult(model) {
    if (model?.status !== 'ready') return null;
    const snapshot = {};
    for (const field of READY_RESULT_FIELDS) snapshot[field] = model[field];
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
        sourceMap: [],
        annotationOverlay: createEmptyAnnotationOverlay(),
        warnings: [],
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

export function createConversionReadyChanges(result) {
    return {
        assets: [],
        assetBasePath: '',
        cacheKey: null,
        sourceMap: [],
        annotationOverlay: createEmptyAnnotationOverlay(),
        ...result,
        status: 'ready',
        progress: 100,
        preserveContent: false,
        resumingTask: false,
        errorAction: null,
        warningAction: null,
    };
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
