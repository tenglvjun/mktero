import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createFigureProviderFixture } from './helpers/figure-provider-fixtures.js';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';
import { prepareMistralResult } from '../src/mistral/mistral-result.js';
import { createMarkdownExportPlan } from '../src/markdown/markdown-export.js';
import { collectFigureImageNodes } from '../src/figures/figure-model.js';
import { serializeFigureMap, parseFigureMapJSON } from '../src/figures/figure-map-serialization.js';
import { sha256Hex } from '../src/core/sha256.js';

const root = new URL('./fixtures/figures/', import.meta.url);
const fileData = new Uint8Array(await readFile(new URL('compound-figures.pdf', root)));
const manifest = JSON.parse(await readFile(new URL('compound-figures.expected.json', root), 'utf8'));
const hash = value => sha256Hex(value, { crypto: webcrypto });
for (const provider of ['mineru', 'mistral']) {
    for (const caseID of Object.keys(manifest.cases)) {
        test(`${provider} restores ${caseID} through the provider and portable export pipeline`, async () => {
            const fixture = await createFigureProviderFixture(caseID, provider, { fileData, manifest });
            const service = new FigureRestorationService({ hash, openPDF: async () => ({
                getPageGeometry: async index => fixture.pageGeometries[index],
                renderRegion: async () => ({ data: createTestPNG(400, 350),
                    mimeType: 'image/png', width: 400, height: 350 }),
                close: async () => {},
            }) });
            const draft = await service.restore(fixture.input, { fileData });
            const document = await finalizeRestoredDocument(fixture.input, draft, {
                prepare: provider === 'mineru' ? prepareMinerUResult : prepareMistralResult, hash,
            });
            assert.equal(document.figureMap.figures.length, fixture.expected.figures,
                JSON.stringify(document.figureMap.preserved));
            assert.deepEqual(document.figureMap.figures.map(figure => figure.panels.length), fixture.expected.panelCounts);
            for (const text of fixture.expected.retainedTexts) assert.ok(document.markdown.includes(text), text);
            for (const text of fixture.expected.consumedTexts) assert.ok(!document.markdown.includes(text), text);
            if (fixture.expected.preserve) assert.equal(draft.input.markdown, fixture.input.markdown);
            const stored = await serializeFigureMap(document.figureMap, document, { hash });
            assert.deepEqual(await parseFigureMapJSON(stored.json, document, { hash }), document.figureMap);
            const exported = createMarkdownExportPlan({ markdown: document.markdown, assets: document.assets,
                assetBasePath: document.assetBasePath, assetDirectoryName: 'paper.assets' });
            for (const node of collectFigureImageNodes(exported.markdown)) {
                const image = exported.assets.find(asset => 'paper.assets/' + asset.relativePath === node.assetPath);
                assert.ok(image, node.assetPath);
                assert.deepEqual([...image.data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
            }
        });
    }
}
