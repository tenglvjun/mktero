import test from 'node:test';
import assert from 'node:assert/strict';
import { translateMessage } from '../src/i18n/localization.js';
import {
    createConversionFailureChanges,
    createConversionLoadingChanges,
    createConversionProgressChanges,
    createConversionReadyChanges,
    createTranslationLoadingChanges,
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
        provider: 'mistral',
        parserProfile: 'mistral-profile-v1',
        cacheHit: true,
        cacheKey: 'a'.repeat(64),
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: 14,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 180] }],
        }],
        extractedPages: 2,
        totalPages: 2,
        annotationOverlay: {
            matched: [{ id: 'HIGH0001', ranges: [{ from: 0, to: 6 }] }],
            unmatched: [],
        },
        warnings: [],
        editableBlocks: [{
            id: 'block-0',
            type: 'heading',
            from: 0,
            to: 14,
        }],
        correctedBlockIDs: ['block-0'],
        correctionCount: 1,
        hasCorrections: true,
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
    assert.equal(loading.provider, 'mistral');
    assert.equal(loading.parserProfile, 'mistral-profile-v1');
    assert.equal(loading.resumingTask, false);
    assert.deepEqual(loading.annotationOverlay, current.annotationOverlay);
    assert.equal(loading.sourceMap, current.sourceMap);
    assert.deepEqual(loading.editableBlocks, current.editableBlocks);
    assert.deepEqual(loading.correctedBlockIDs, ['block-0']);
    assert.equal(loading.correctionCount, 1);
    assert.equal(loading.hasCorrections, true);
    assert.equal(loading.translationView, 'original');
    assert.equal(loading.translationStatus, 'none');
});

test('tracks whether loading progress belongs to a resumed task', () => {
    assert.deepEqual(createConversionProgressChanges(42, {
        resumingTask: true,
    }), {
        status: 'loading',
        progress: 42,
        resumingTask: true,
        operation: null,
    });
    assert.deepEqual(createConversionProgressChanges(5), {
        status: 'loading',
        progress: 5,
        resumingTask: false,
        operation: null,
    });
});

test('starts translation work from the completed blocks that remain visible', () => {
    const model = {
        translationProgress: 67,
        translationCompletedBlocks: 2,
        translationTotalBlocks: 3,
        translationTargetLanguage: 'zh-CN',
        translationFailedBlocks: [{ id: 'failed' }],
    };
    const previous = {
        targetLanguage: 'zh-CN',
        failedBlocks: [{ id: 'failed' }],
    };

    assert.deepEqual(createTranslationLoadingChanges({
        model,
        previousTranslation: previous,
        targetLanguage: 'zh-CN',
        retryBlockIDs: ['failed'],
    }), {
        translationProgress: 67,
        translationCompletedBlocks: 2,
        translationTotalBlocks: 3,
    });
    assert.deepEqual(createTranslationLoadingChanges({
        model,
        previousTranslation: previous,
        targetLanguage: 'zh-CN',
        retryBlockIDs: ['successful'],
    }), {
        translationProgress: 33,
        translationCompletedBlocks: 1,
        translationTotalBlocks: 3,
    });
    assert.deepEqual(createTranslationLoadingChanges({
        model,
        previousTranslation: previous,
        targetLanguage: 'zh-CN',
        forceRetranslate: true,
    }), {
        translationProgress: 0,
        translationCompletedBlocks: 0,
        translationTotalBlocks: 3,
    });
    assert.deepEqual(createTranslationLoadingChanges({
        model,
        previousTranslation: previous,
        targetLanguage: 'ja-JP',
    }), {
        translationProgress: 0,
        translationCompletedBlocks: 0,
        translationTotalBlocks: 0,
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
    assert.equal(failure.warningAction, null);
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
        sourceHash: null,
        sourceMap: [],
        figureMap: null,
        figureRestoration: null,
        pendingFigureAssets: null,
        annotationOverlay: { matched: [], unmatched: [] },
        warnings: [],
        editableBlocks: [],
        correctedBlockIDs: [],
        correctionCount: 0,
        hasCorrections: false,
        correctionMode: false,
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
        error: '',
        errorAction: null,
        warningAction: null,
        preserveContent: false,
        resumingTask: false,
        operation: null,
    });
    assert.deepEqual(createConversionFailureChanges('Conversion failed', null), {
        status: 'error',
        error: 'Conversion failed',
        errorAction: null,
        warningAction: null,
        preserveContent: false,
        resumingTask: false,
        operation: null,
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
        sourceHash: null,
        sourceMap: [],
        documentStructure: null,
        figureMap: null,
        figureRestoration: null,
        pendingFigureAssets: null,
        annotationOverlay: { matched: [], unmatched: [] },
        editableBlocks: [],
        correctedBlockIDs: [],
        correctionCount: 0,
        hasCorrections: false,
        correctionMode: false,
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
        title: 'Reparsed paper',
        markdown: '# Reparsed',
        sourceKind: 'markdown',
        status: 'ready',
        progress: 100,
        preserveContent: false,
        resumingTask: false,
        operation: null,
        errorAction: null,
        warningAction: null,
    });
});

test('keeps import progress local and clears the operation after success or failure', () => {
    const operation = 'import-llm-cache';
    const previousResult = {
        status: 'ready', title: 'Paper', markdown: '# Previous', warnings: [], operation,
    };
    assert.deepEqual(createConversionProgressChanges(42, { operation }), {
        status: 'loading', progress: 42, resumingTask: false, operation,
    });
    assert.equal(createConversionProgressChanges(5, { operation: 'convert' }).operation, 'convert');
    assert.equal(snapshotReadyResult(previousResult).operation, undefined);
    for (const changes of [
        createConversionLoadingChanges(previousResult),
        createConversionReadyChanges(previousResult),
        createConversionFailureChanges('Failed', previousResult),
        createConversionFailureChanges('Failed', null),
    ]) {
        assert.equal(changes.operation, null);
        assert.equal({ ...previousResult, ...changes }.operation, null);
    }
});

test('describes a failed import while restoring previous Markdown', () => {
    for (const [locale, expected] of [
        ['en-US', 'Local import failed: Broken cache'],
        ['zh-CN', '本地导入失败：Broken cache'],
    ]) {
        const translate = (key, variables) => translateMessage(locale, key, variables);
        const previousResult = snapshotReadyResult({
            status: 'ready', markdown: '# Previous', warnings: ['Existing warning.'],
        });
        const changes = createConversionFailureChanges(
            'Broken cache', previousResult, translate, { errorAction: 'local-import' }
        );
        assert.equal(changes.status, 'ready');
        assert.equal(changes.markdown, '# Previous');
        assert.equal(changes.operation, null);
        assert.deepEqual(changes.warnings, ['Existing warning.', expected]);
        assert.equal(changes.errorAction, null);
        assert.equal(changes.warningAction, 'local-import');
        const failure = createConversionFailureChanges(
            'Broken cache', null, translate, { errorAction: 'local-import' }
        );
        assert.equal(failure.status, 'error');
        assert.equal(failure.errorAction, 'local-import');
        assert.equal(failure.operation, null);
    }
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
    assert.equal(
        createConversionFailureChanges(
            'Token 无效',
            snapshot,
            translate,
            { errorAction: 'open-settings' }
        ).warningAction,
        'open-settings'
    );
});
