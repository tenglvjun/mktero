const READY_RESULT_FIELDS = [
    'title',
    'markdown',
    'assets',
    'assetBasePath',
    'sourceKind',
    'cacheHit',
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

export function createConversionLoadingChanges(previousResult) {
    if (previousResult) {
        return {
            ...previousResult,
            title: 'Reparsing PDF…',
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
        warnings: [],
        error: '',
        preserveContent: false,
    };
}

export function createConversionReadyChanges(result) {
    return {
        assets: [],
        assetBasePath: '',
        ...result,
        status: 'ready',
        progress: 100,
        preserveContent: false,
    };
}

export function createConversionFailureChanges(message, previousResult) {
    if (previousResult) {
        return {
            ...previousResult,
            status: 'ready',
            progress: 100,
            warnings: [
                ...(previousResult.warnings || []),
                `Reparse failed: ${message}`,
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
