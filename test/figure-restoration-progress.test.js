import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProgressiveFigureUpdate } from '../src/ui/figure-restoration-progress.js';

test('a figure patch does not update the document', () => {
    const calls = [];
    const presentation = { closed: false };
    applyProgressiveFigureUpdate(presentation, {
        type: 'figure',
        figure: { id: 'fig-a', status: 'composed', crop: { data: new Uint8Array([1]) } },
    }, {
        updateDocument: () => calls.push('document'),
        showRestoredFigure: () => calls.push('figure'),
    });
    assert.deepEqual(calls, ['figure']);
});

test('a closed presentation ignores figure patches', () => {
    let called = false;
    applyProgressiveFigureUpdate({ closed: true }, {
        type: 'figure', figure: { status: 'composed', crop: { data: new Uint8Array([1]) } },
    }, { updateDocument() {}, showRestoredFigure() { called = true; } });
    assert.equal(called, false);
});

test('a document event updates the document and not the figure', () => {
    const calls = [];
    applyProgressiveFigureUpdate({ closed: false }, {
        type: 'document',
        document: { markdown: '# Paper' },
    }, {
        updateDocument: () => calls.push('document'),
        showRestoredFigure: () => calls.push('figure'),
    });
    assert.deepEqual(calls, ['document']);
});

test('a preserved figure does not patch the reader', () => {
    let called = false;
    applyProgressiveFigureUpdate({ closed: false }, {
        type: 'figure',
        figure: { id: 'fig-a', status: 'preserved' },
    }, {
        updateDocument() {},
        showRestoredFigure() { called = true; },
    });
    assert.equal(called, false);
});
