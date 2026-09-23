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

test('publishes one provisional document, patches each figure, and prepares twice', async () => {
    const { input } = makeFigureInput();
    let prepares = 0;
    const events = [];
    const runner = createProgressiveFigureRunner({
        restoration: progressiveService(),
        prepare: value => { prepares += 1; return prepareMinerUResult(value); },
        hash,
        finalize: async (source, draft, { prepare }) => ({
            ...(await prepare(draft.input)), figureMap: { version: 1, stub: true },
        }),
    });
    await runner(input, { fileData: Uint8Array.of(1), onEvent: event => events.push(event) });
    assert.equal(events.filter(event => event.type === 'document').length, 1);
    const composed = events.find(event => event.type === 'figure' && event.figure.status === 'composed');
    assert.ok(composed.figure.crop?.data);
    assert.ok(composed.figure.panelAssetPaths.includes(
        input.blocks.find(block => block.role === 'panel').assetPath
    ));
    assert.equal(events.at(-1).type, 'complete');
    assert.equal(prepares, 2);
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
