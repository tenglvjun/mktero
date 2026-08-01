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
        annotationOverlay: createEmptyAnnotationOverlay(),
        warnings: [],
        error: '',
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
        annotationOverlay: createEmptyAnnotationOverlay(),
        ...result,
        status: 'ready',
        progress: 100,
        preserveContent: false,
        resumingTask: false,
    };
}

export function createConversionFailureChanges(
    message,
    previousResult,
    translate = translateEnglish
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
            preserveContent: false,
            resumingTask: false,
        };
    }
    return {
        status: 'error',
        error: message,
        preserveContent: false,
        resumingTask: false,
    };
}
