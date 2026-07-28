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
        warnings: [],
        error: '',
        preserveContent: false,
    };
}

export function createConversionReadyChanges(result) {
    return {
        assets: [],
        assetBasePath: '',
        cacheKey: null,
        ...result,
        status: 'ready',
        progress: 100,
        preserveContent: false,
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
        };
    }
    return {
        status: 'error',
        error: message,
        preserveContent: false,
    };
}
