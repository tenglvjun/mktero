import test from 'node:test';
import assert from 'node:assert/strict';
import { translateMessage } from '../src/i18n/localization.js';
import { createLoadingPresentation } from '../src/ui/markdown-loading-state.js';

test('describes provider-neutral loading stages', () => {
    assert.deepEqual(createLoadingPresentation({
        status: 'loading',
        progress: 0,
        preserveContent: false,
    }), {
        visible: true,
        preserveContent: false,
        progress: 0,
        progressLabel: '0%',
        title: 'Converting PDF…',
        detail: 'Preparing the PDF.',
        hint: 'This can take a few minutes. Keep this tab open until conversion finishes.',
    });

    assert.equal(
        createLoadingPresentation({ status: 'loading', progress: 7 }).detail,
        'Uploading the PDF for conversion.'
    );
    assert.equal(
        createLoadingPresentation({ status: 'loading', progress: 42 }).detail,
        'The PDF is being converted to Markdown.'
    );
    assert.equal(
        createLoadingPresentation({ status: 'loading', progress: 97 }).detail,
        'Downloading and preparing the Markdown result.'
    );
});

test('uses a compact loading presentation while reparsing existing Markdown', () => {
    assert.deepEqual(createLoadingPresentation({
        status: 'loading',
        progress: 23.6,
        preserveContent: true,
    }), {
        visible: true,
        preserveContent: true,
        progress: 24,
        progressLabel: '24%',
        title: 'Reparsing PDF…',
        detail: 'The PDF is being converted to Markdown.',
        hint: 'The current Markdown remains available until the new result is ready.',
    });
    assert.doesNotMatch(
        JSON.stringify(createLoadingPresentation({ status: 'loading', progress: 42 })),
        /mineru/i
    );
});

test('makes resumed conversion work visible without exposing task details', () => {
    assert.deepEqual(createLoadingPresentation({
        status: 'loading',
        progress: 42,
        preserveContent: false,
        resumingTask: true,
    }), {
        visible: true,
        preserveContent: false,
        progress: 42,
        progressLabel: '42%',
        title: 'Resuming PDF conversion…',
        detail: 'Continuing the previous conversion task.',
        hint: 'The PDF has already been uploaded and will not be uploaded again.',
    });
    assert.equal(createLoadingPresentation({
        status: 'loading',
        progress: 97,
        resumingTask: true,
    }).detail, 'Downloading and preparing the Markdown result.');
});

test('hides the loading presentation outside conversion and clamps invalid progress', () => {
    assert.equal(createLoadingPresentation({ status: 'ready' }).visible, false);
    assert.equal(
        createLoadingPresentation({ status: 'loading', progress: 150 }).progress,
        100
    );
    assert.equal(
        createLoadingPresentation({ status: 'loading', progress: Number.NaN }).progress,
        0
    );
});

test('localizes conversion progress', () => {
    const presentation = createLoadingPresentation({
        status: 'loading',
        progress: 42,
        preserveContent: false,
    }, (key, variables) => translateMessage('zh-CN', key, variables));

    assert.equal(presentation.title, '正在转换 PDF…');
    assert.equal(presentation.detail, '正在将 PDF 转换为 Markdown。');
    assert.equal(
        presentation.hint,
        '这可能需要几分钟。转换完成前请保持此标签页打开。'
    );

    const resumed = createLoadingPresentation({
        status: 'loading',
        progress: 42,
        resumingTask: true,
    }, (key, variables) => translateMessage('zh-CN', key, variables));
    assert.equal(resumed.title, '正在恢复上次 PDF 转换…');
    assert.equal(resumed.detail, '正在继续查询上次的转换任务。');
    assert.equal(resumed.hint, 'PDF 已完成上传，不会再次上传。');
});
