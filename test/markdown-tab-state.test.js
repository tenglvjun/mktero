import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createConversionFailureChanges,
    createConversionLoadingChanges,
    createConversionReadyChanges,
    snapshotReadyResult,
} from '../src/ui/markdown-tab-state.js';

test('keeps the current Markdown visible while a forced reparse is running', () => {
    const current = {
        itemID: 42,
        title: 'Paper',
        status: 'ready',
        progress: 100,
        markdown: '# Cached paper',
        assets: [{ path: 'figure.png' }],
        assetBasePath: 'result',
        sourceKind: 'markdown',
        cacheHit: true,
        extractedPages: 2,
        totalPages: 2,
        warnings: [],
        error: '',
        onReparse: () => {},
    };
    const snapshot = snapshotReadyResult(current);

    const loading = createConversionLoadingChanges(snapshot);

    assert.equal(loading.status, 'loading');
    assert.equal(loading.preserveContent, true);
    assert.equal(loading.markdown, '# Cached paper');
    assert.equal(loading.cacheHit, true);
});

test('restores the previous result with a warning when reparse fails', () => {
    const snapshot = snapshotReadyResult({
        title: 'Paper',
        status: 'ready',
        markdown: '# Cached paper',
        assets: [],
        assetBasePath: '',
        sourceKind: 'markdown',
        cacheHit: true,
        extractedPages: 1,
        totalPages: 1,
        warnings: ['Existing warning.'],
    });

    const failure = createConversionFailureChanges('MinerU is unavailable', snapshot);

    assert.equal(failure.status, 'ready');
    assert.equal(failure.markdown, '# Cached paper');
    assert.equal(failure.cacheHit, true);
    assert.equal(failure.preserveContent, false);
    assert.deepEqual(failure.warnings, [
        'Existing warning.',
        'Reparse failed: MinerU is unavailable',
    ]);
});

test('uses the normal empty and error states without a previous result', () => {
    assert.deepEqual(createConversionLoadingChanges(null), {
        status: 'loading',
        progress: 0,
        markdown: '',
        assets: [],
        assetBasePath: '',
        cacheHit: false,
        warnings: [],
        error: '',
        preserveContent: false,
    });
    assert.deepEqual(createConversionFailureChanges('Conversion failed', null), {
        status: 'error',
        error: 'Conversion failed',
        preserveContent: false,
    });
});

test('clears figures when a successful reparse has no assets', () => {
    assert.deepEqual(createConversionReadyChanges({
        title: 'Reparsed paper',
        markdown: '# Reparsed',
        sourceKind: 'markdown',
    }), {
        assets: [],
        assetBasePath: '',
        title: 'Reparsed paper',
        markdown: '# Reparsed',
        sourceKind: 'markdown',
        status: 'ready',
        progress: 100,
        preserveContent: false,
    });
});
