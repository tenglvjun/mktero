import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { sha256Hex } from '../src/core/sha256.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';
import { createProgressiveFigureRunner } from '../src/figures/figure-progressive-runner.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });

function progressiveService() {
    const session = {
        getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
            rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
            viewBox: [0, 0, 1000, 1000], mediaBox: null, viewportTransform: [1, 0, 0, -1, 0, 1000] }),
        renderPageCrops: async request => ({
            dpi: request.dpi,
            crops: request.regions.map(region => ({ id: region.id,
                crop: { data: createTestPNG(800, 750), mimeType: 'image/png', width: 800, height: 750 } })),
        }),
        close: async () => {},
    };
    return new FigureRestorationService({ hash, openPDF: async () => session });
}

test('publishes provisionally, rebuilds per figure and completes with a figure map', async () => {
    const { input } = makeFigureInput();
    const runner = createProgressiveFigureRunner({
        restoration: progressiveService(),
        prepare: prepareMinerUResult,
        hash,
        finalize: async (source, draft, { prepare }) => ({
            ...(await prepare(draft.input)), figureMap: { version: 1, stub: true },
        }),
    });
    const events = [];
    const document = await runner(input, { fileData: Uint8Array.of(1),
        onEvent: event => events.push(event) });
    const first = events[0];
    assert.equal(first.type, 'document');
    assert.ok(first.pendingFigureAssets instanceof Map);
    const panel = input.blocks.find(block => block.role === 'panel');
    assert.ok(first.pendingFigureAssets.has(panel.assetPath));
    assert.equal(first.document.figureRestoration.status, 'pending');
    assert.ok(events.some(event => event.type === 'figure' && event.figure.status === 'composed'));
    const rebuilt = events.filter(event => event.type === 'document');
    assert.ok(rebuilt.length >= 2, 'document is rebuilt after a figure completes');
    assert.equal(rebuilt.at(-1).pendingFigureAssets.size, 0);
    const complete = events.at(-1);
    assert.equal(complete.type, 'complete');
    assert.equal(complete.document.figureMap.stub, true);
    assert.equal(document.figureMap.stub, true);
});

test('progressive final document matches the synchronous restoration path', async () => {
    const { input } = makeFigureInput();
    const syncDraft = await progressiveService().restore(input, { fileData: Uint8Array.of(1) });
    const syncDocument = await finalizeRestoredDocument(input, syncDraft, {
        prepare: prepareMinerUResult, hash,
    });
    const runner = createProgressiveFigureRunner({
        restoration: progressiveService(), prepare: prepareMinerUResult, hash,
    });
    const progressiveDocument = await runner(input, { fileData: Uint8Array.of(1) });
    assert.equal(progressiveDocument.markdown, syncDocument.markdown);
    assert.deepEqual(progressiveDocument.figureMap, syncDocument.figureMap);
});
