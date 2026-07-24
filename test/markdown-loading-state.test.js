import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoadingPresentation } from '../src/ui/markdown-loading-state.js';

test('describes the visible MinerU loading stages', () => {
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
        detail: 'Preparing the PDF for MinerU.',
        hint: 'This can take a few minutes. Keep this tab open while MinerU finishes.',
    });

    assert.equal(
        createLoadingPresentation({ status: 'loading', progress: 7 }).detail,
        'Uploading the PDF to MinerU.'
    );
    assert.equal(
        createLoadingPresentation({ status: 'loading', progress: 42 }).detail,
        'MinerU is parsing the document.'
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
        detail: 'MinerU is parsing the document.',
        hint: 'The current Markdown remains available until the new result is ready.',
    });
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
