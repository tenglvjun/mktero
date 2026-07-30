import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAnnotationOverlayRefresher,
} from '../src/ui/annotation-overlay-refresher.js';

test('keeps the newest PDF annotation state across overlapping refreshes', async () => {
    const presentation = readyPresentation(42);
    const pending = [];
    const updates = [];
    const refresher = createAnnotationOverlayRefresher({
        presenter: {
            get: itemID => itemID === 42 ? presentation : null,
            list: () => [presentation],
            update(_presentation, changes) {
                updates.push(changes.annotationOverlay);
                Object.assign(presentation.model, changes);
            },
        },
        service: {
            resolveAnnotations() {
                return new Promise(resolve => pending.push(resolve));
            },
        },
    });

    const first = refresher.refresh([42]);
    const second = refresher.refresh([42]);
    pending[1](annotationResult('second'));
    await second;
    const third = refresher.refresh([42]);
    pending[0](annotationResult('stale-first'));
    await first;
    pending[2](annotationResult('third'));
    await third;

    assert.deepEqual(
        updates.map(overlay => overlay.matched[0].comment),
        ['second', 'third']
    );
    assert.equal(
        presentation.model.annotationOverlay.matched[0].comment,
        'third'
    );
});

test('refreshes every affected open PDF and stops updates after disposal', async () => {
    const presentations = new Map([
        [42, readyPresentation(42)],
        [43, readyPresentation(43)],
    ]);
    const updates = [];
    const refresher = createAnnotationOverlayRefresher({
        presenter: {
            get: itemID => presentations.get(itemID) || null,
            list: () => [...presentations.values()],
            update(presentation) {
                updates.push(presentation.model.itemID);
            },
        },
        service: {
            async resolveAnnotations(itemID) {
                return annotationResult(`PDF ${itemID}`);
            },
        },
    });

    await refresher.refresh([42, 43, 42]);
    refresher.dispose();
    await refresher.refresh(null);

    assert.deepEqual(updates.sort(), [42, 43]);
});

function readyPresentation(itemID) {
    return {
        closed: false,
        model: {
            itemID,
            status: 'ready',
            markdown: `# PDF ${itemID}`,
            annotationOverlay: { matched: [], unmatched: [] },
        },
    };
}

function annotationResult(comment) {
    return {
        annotationOverlay: {
            matched: [{ id: 'ANN00001', comment }],
            unmatched: [],
        },
        warnings: [],
    };
}
