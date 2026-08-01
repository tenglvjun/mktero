import test from 'node:test';
import assert from 'node:assert/strict';
import { translateMessage } from '../src/i18n/localization.js';
import {
    createConversionFailureChanges,
    createConversionLoadingChanges,
    createConversionProgressChanges,
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
        cacheKey: 'a'.repeat(64),
        extractedPages: 2,
        totalPages: 2,
        annotationOverlay: {
            matched: [{ id: 'HIGH0001', ranges: [{ from: 0, to: 6 }] }],
            unmatched: [],
        },
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
    assert.equal(loading.cacheKey, 'a'.repeat(64));
    assert.equal(loading.resumingTask, false);
    assert.deepEqual(loading.annotationOverlay, current.annotationOverlay);
});

test('tracks whether loading progress belongs to a resumed task', () => {
    assert.deepEqual(createConversionProgressChanges(42, {
        resumingTask: true,
    }), {
        status: 'loading',
        progress: 42,
        resumingTask: true,
    });
    assert.deepEqual(createConversionProgressChanges(5), {
        status: 'loading',
        progress: 5,
        resumingTask: false,
    });
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
    assert.equal(failure.resumingTask, false);
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
        cacheKey: null,
        annotationOverlay: { matched: [], unmatched: [] },
        warnings: [],
        error: '',
        preserveContent: false,
        resumingTask: false,
    });
    assert.deepEqual(createConversionFailureChanges('Conversion failed', null), {
        status: 'error',
        error: 'Conversion failed',
        preserveContent: false,
        resumingTask: false,
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
        cacheKey: null,
        annotationOverlay: { matched: [], unmatched: [] },
        title: 'Reparsed paper',
        markdown: '# Reparsed',
        sourceKind: 'markdown',
        status: 'ready',
        progress: 100,
        preserveContent: false,
        resumingTask: false,
    });
});

test('localizes reparse loading and failure states', () => {
    const translate = (key, variables) => translateMessage('zh-CN', key, variables);
    const snapshot = snapshotReadyResult({
        title: '论文',
        status: 'ready',
        markdown: '# 论文',
        warnings: [],
    });

    assert.equal(
        createConversionLoadingChanges(snapshot, translate).title,
        '正在重新解析 PDF…'
    );
    assert.deepEqual(
        createConversionFailureChanges('服务不可用', snapshot, translate).warnings,
        ['重新解析失败：服务不可用']
    );
});
