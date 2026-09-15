// Zotero-side probe harness. Serialized into the temporary extension, so it
// only uses Zotero globals (Services, IOUtils, zotero, ...).
import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';
import '../src/pdf/pdfjs-text-engine.js';
import { createZoteroFigureCanvasEnvironment } from '../src/platform/zotero-figure-canvas.js';
import { createWorkerFigureRegionRenderer } from '../src/figures/figure-render-worker-client.js';
import { createProgressiveFigureRunner } from '../src/figures/figure-progressive-runner.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';
import { sha256Hex } from '../src/core/sha256.js';
import { createFigureProviderFixture } from '../test/helpers/figure-provider-fixtures.js';
import { replacePendingFigureImages } from '../src/editor/figure-placeholder.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

let probeAssetsPromise = null;
let probeAssetReads = 0;
function loadProbeAssets(root) {
    if (!probeAssetsPromise) {
        probeAssetsPromise = (async () => {
            const directories = [['cMapUrl', 'cmaps'], ['standardFontDataUrl', 'standard_fonts'], ['wasmUrl', 'wasm']];
            const assets = new Map();
            for (const [kind, directory] of directories) {
                const base = `${root}/build/package/pdfjs/${directory}`;
                for (const child of await IOUtils.getChildren(base)) {
                    assets.set(`${kind}:${PathUtils.filename(child)}`, await IOUtils.read(child));
                }
            }
            return assets;
        })();
    }
    return probeAssetsPromise;
}


export async function runWorkerProbe(root, output, zotero, pdfPath) {
    await zotero.initializationPromise;
    await zotero.uiReadyPromise;
    const win = zotero.getMainWindow();
    const stage = value => IOUtils.writeUTF8(output + '/probe-stage.json', JSON.stringify({ stage: value }));
    const report = { zotero: zotero.version, firefox: Services.appinfo.platformVersion,
        strategies: [], mainThreadGlobals: {} };

    const workerSource = await IOUtils.readUTF8(output + '/worker.js');

    const globalNames = ['Worker', 'ChromeWorker', 'OffscreenCanvas', 'createImageBitmap', 'ImageBitmap',
        'FontFace', 'Path2D', 'DOMMatrix', 'ImageData', 'fetch', 'structuredClone', 'Blob', 'URL'];
    for (const name of globalNames) {
        report.mainThreadGlobals[name] = {
            scope: typeof globalThis[name],
            window: typeof win[name],
        };
    }

    const candidates = [];
    const seen = new Set();
    for (const [where, ctor] of [['scope', globalThis.Worker], ['window', win.Worker]]) {
        if (typeof ctor !== 'function' || seen.has(ctor)) continue;
        seen.add(ctor);
        try {
            const blobURL = win.URL.createObjectURL(new win.Blob([workerSource], { type: 'application/javascript' }));
            candidates.push({ where, kind: 'blob', ctor, url: blobURL });
        }
        catch (error) {
            report.strategies.push({ where, kind: 'blob', ok: false, error: `blob:${error.message}` });
        }
        try {
            const file = zotero.File.pathToFile(output + '/worker.js');
            candidates.push({ where, kind: 'file', ctor, url: Services.io.newFileURI(file).spec });
        }
        catch (error) {
            report.strategies.push({ where, kind: 'file', ok: false, error: `file:${error.message}` });
        }
    }

    const request = (worker, message, timeoutMs) => new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        let done = false;
        const timer = win.setTimeout(() => {
            if (done) return;
            done = true;
            cleanup();
            reject(new Error('probe timeout'));
        }, timeoutMs);
        const cleanup = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
        };
        const onMessage = event => {
            if (event.data?.id !== id || done) return;
            done = true;
            win.clearTimeout(timer);
            cleanup();
            if (event.data.ok) resolve(event.data.value);
            else reject(new Error(`${event.data.error}\n${event.data.stack || ''}`));
        };
        const onError = event => {
            if (done) return;
            done = true;
            win.clearTimeout(timer);
            cleanup();
            reject(new Error(`worker error: ${event.message || event}`));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({ id, type: message.type, payload: message.payload });
    });

    let worker = null;
    for (const candidate of candidates) {
        await stage(`worker:${candidate.where}:${candidate.kind}`);
        try {
            const created = new candidate.ctor(candidate.url);
            const value = await request(created, { type: 'capabilities' }, 20000);
            report.strategies.push({ where: candidate.where, kind: candidate.kind, ok: true, capabilities: value });
            report.chosen = { where: candidate.where, kind: candidate.kind };
            worker = created;
            break;
        }
        catch (error) {
            report.strategies.push({ where: candidate.where, kind: candidate.kind, ok: false,
                error: String((error && error.message) || error) });
        }
    }
    if (!worker) {
        await IOUtils.writeUTF8(output + '/probe-result.json', JSON.stringify(report, null, 2));
        return report;
    }

    try {
        await stage('offscreen');
        report.offscreen = await request(worker, { type: 'offscreen' }, 20000);
    }
    catch (error) { report.offscreen = { error: String((error && error.message) || error) }; }

    // FontFace is what PDF.js uses to bind non-embedded standard fonts. Test the
    // API directly with packaged font bytes, then whether the worker can fetch
    // the standard-font URL PDF.js uses, then render a non-embedded-font PDF.
    const standardFontDir = root + '/build/package/pdfjs/standard_fonts';
    const fontPath = standardFontDir + '/LiberationSans-Regular.ttf';
    try {
        await stage('fontface');
        const fontBytes = await IOUtils.read(fontPath);
        report.fontFace = await request(worker, { type: 'fontFace',
            payload: { bytes: fontBytes.buffer, family: 'MkteroProbeSans' } }, 30000);
    }
    catch (error) { report.fontFace = { error: String((error && error.message) || error) }; }
    try {
        const fontFile = zotero.File.pathToFile(fontPath);
        const fontUrl = Services.io.newFileURI(fontFile).spec;
        report.fetchUrl = { url: fontUrl,
            ...await request(worker, { type: 'fetchUrl', payload: { url: fontUrl } }, 30000) };
    }
    catch (error) { report.fetchUrl = { error: String((error && error.message) || error) }; }
    try {
        await stage('standard-font-render');
        const fixtureBytes = await IOUtils.read(root + '/test/fixtures/figures/compound-figures.pdf');
        const dir = zotero.File.pathToFile(standardFontDir);
        const standardFontDataUrl = Services.io.newFileURI(dir).spec.replace(/\/?$/u, '/');
        const rendered = await request(worker, { type: 'renderStandardFont',
            payload: { data: fixtureBytes.buffer, standardFontDataUrl } }, 60000);
        const { data, ...summary } = rendered;
        if (data) await IOUtils.write(output + '/worker-standard-font.png', new Uint8Array(data));
        report.standardFontRender = { ...summary, standardFontDataUrl, pngSaved: Boolean(data) };
    }
    catch (error) { report.standardFontRender = { error: String((error && error.message) || error) }; }

    // Real offline render of the pathological page-17 figure while the Zotero
    // main thread keeps a 20 ms heartbeat running.
    try {
        await stage('render');
        const bytes = await IOUtils.read(pdfPath);
        let ticks = 0;
        let maxGap = 0;
        let last = win.performance.now();
        const heartbeat = win.setInterval(() => {
            const now = win.performance.now();
            maxGap = Math.max(maxGap, now - last);
            last = now;
            ticks++;
        }, 20);
        const started = win.performance.now();
        let rendered;
        try {
            rendered = await request(worker, { type: 'render', payload: {
                data: bytes.buffer,
                pageIndex: 17,
                bbox: [512.7058823529412, 71.23232323232324, 622.9150326797386, 190.13131313131314],
                dpi: 192,
            } }, 120000);
        }
        finally {
            win.clearInterval(heartbeat);
        }
        const { data, ...summary } = rendered;
        if (data) await IOUtils.write(output + '/worker-render.png', new Uint8Array(data));
        report.render = { ...summary, wallMs: win.performance.now() - started,
            heartbeatTicks: ticks, heartbeatMaxGapMs: maxGap,
            pngSaved: Boolean(data) };
    }
    catch (error) { report.render = { error: String((error && error.message) || error) }; }

    // Main-thread parity baseline for the same region, measured on the real
    // Zotero main thread with the same production renderer flags.
    try {
        await stage('main-thread-render');
        const environment = createZoteroFigureCanvasEnvironment(zotero);
        const renderer = createPDFFigureRegionRenderer({
            createCanvas: environment.createCanvas,
            encodePNG: environment.encodePNG,
            decodeImage: environment.decodeImage,
            readBinaryAsset: async (kind, filename) => (
                (probeAssetReads++, await loadProbeAssets(root)).get(`${kind}:${filename}`) || null
            ),
            workerSrc: Services.io.newFileURI(
                zotero.File.pathToFile(root + '/build/package/pdf.worker.mjs')).spec,
            cMapUrl: Services.io.newFileURI(
                zotero.File.pathToFile(root + '/build/package/pdfjs/cmaps')).spec + '/',
            standardFontDataUrl: Services.io.newFileURI(
                zotero.File.pathToFile(root + '/build/package/pdfjs/standard_fonts')).spec + '/',
        });
        const bytes = await IOUtils.read(pdfPath);
        const started = win.performance.now();
        const session = await renderer.open(bytes, { signal: undefined });
        const crop = await session.renderRegion({
            pageIndex: 17, bbox: [512.7058823529412, 71.23232323232324, 622.9150326797386, 190.13131313131314],
            coordinateFrame: 'display-cropbox', rotation: 0, dpi: 192,
        });
        report.mainThreadRender = { width: crop.width, height: crop.height,
            bytes: crop.data.byteLength, wallMs: win.performance.now() - started };
        report.fig1 = {};
        for (const dpi of [192, 300]) {
            const figureCrop = await session.renderRegion({
                pageIndex: 0,
                bbox: [506.16993464052285, 217.6969696969697, 921.9346405228758, 377],
                coordinateFrame: 'display-cropbox', rotation: 0, dpi,
            });
            await IOUtils.write(`${output}/fig1-${dpi}.png`, figureCrop.data);
            report.fig1[dpi] = { width: figureCrop.width, height: figureCrop.height,
                bytes: figureCrop.data.byteLength };
        }
        await session.close();
        await renderer.disposeAll();
    }
    catch (error) { report.mainThreadRender = { error: String((error && error.message) || error) }; }

    // End-to-end progressive restoration with the production worker client:
    // provisional document + placeholders, per-figure events, final consistency.
    let progressiveStep = 'start';
    try {
        await stage('progressive');
        progressiveStep = 'fixtures';
        const fixtureRoot = root + '/test/fixtures/figures';
        const fixturePdf = await IOUtils.read(fixtureRoot + '/compound-figures.pdf');
        const manifest = JSON.parse(new TextDecoder().decode(
            await IOUtils.read(fixtureRoot + '/compound-figures.expected.json')));
        const caseID = Object.keys(manifest.cases)[0];
        const fixture = await createFigureProviderFixture(caseID, 'mineru', {
            fileData: fixturePdf, manifest,
        });
        progressiveStep = 'client';
        const packageRoot = root + '/build/package';
        const fileUrl = value => Services.io.newFileURI(zotero.File.pathToFile(value)).spec;
        const WorkerType = win.Worker || globalThis.Worker;
        const client = createWorkerFigureRegionRenderer({
            loadWorkerSource: () => IOUtils.readUTF8(output + '/figure.worker.js'),
            createWorker: url => new WorkerType(url),
            loadPdfAssets: () => loadProbeAssets(root),
            setTimeout: win.setTimeout.bind(win),
            clearTimeout: win.clearTimeout.bind(win),
            createAbortController: () => new win.AbortController(),
            rendererOptions: {
                cMapUrl: fileUrl(packageRoot + '/pdfjs/cmaps') + '/',
                standardFontDataUrl: fileUrl(packageRoot + '/pdfjs/standard_fonts') + '/',
                wasmUrl: fileUrl(packageRoot + '/pdfjs/wasm') + '/',
            },
        });
        const hash = data => sha256Hex(data, { crypto: win.crypto || globalThis.crypto });
        const service = new FigureRestorationService({
            openPDF: (fileData, options) => client.open(fileData, options),
            hash,
            setTimeout: win.setTimeout.bind(win),
            clearTimeout: win.clearTimeout.bind(win),
            createAbortController: () => new win.AbortController(),
        });
        const runner = createProgressiveFigureRunner({
            restoration: service, prepare: prepareMinerUResult, hash,
        });
        progressiveStep = 'run';
        const events = [];
        const finalDocument = await runner(fixture.input, {
            fileData: fixture.fileData,
            onEvent: event => events.push(event),
        });
        progressiveStep = 'sync';
        const firstDocument = events.find(event => event.type === 'document');
        const composed = events.filter(event => (
            event.type === 'figure' && event.figure.status === 'composed'
        ));
        const syncDraft = await service.restore(fixture.input, { fileData: fixture.fileData });
        const syncDocument = await finalizeRestoredDocument(fixture.input, syncDraft, {
            prepare: prepareMinerUResult, hash,
        });
        progressiveStep = 'dom';
        const html = renderMarkdownHTML(firstDocument.document.markdown, {
            resolveImageURL: path => `blob:${path}`,
            exposeImageAssetPath: true,
        });
        const parsed = new win.DOMParser().parseFromString(
            `<!doctype html><html><body>${html}</body></html>`, 'text/html');
        const container = parsed.body;
        const placeholders = replacePendingFigureImages(container, firstDocument.pendingFigureAssets);
        report.progressive = {
            caseID,
            provisionalFigures: firstDocument.pendingFigureAssets.size,
            composed: composed.length,
            finalFigures: finalDocument.figureMap?.figures?.length ?? 0,
            expectedFigures: fixture.expected.figures,
            consistent: finalDocument.markdown === syncDocument.markdown
                && JSON.stringify(finalDocument.figureMap) === JSON.stringify(syncDocument.figureMap),
            placeholders,
            placeholderIcons: container.querySelectorAll('svg.lucide-image, svg.lucide-loader-circle').length,
            pdfAssets: (await loadProbeAssets(root)).size,
            assetReads: probeAssetReads,
        };
        const workerSession = await client.open(await IOUtils.read(pdfPath));
        const workerFigure = await workerSession.renderRegion({
            pageIndex: 0,
            bbox: [506.16993464052285, 217.6969696969697, 921.9346405228758, 377],
            coordinateFrame: 'display-cropbox', rotation: 0, dpi: 192,
        });
        await IOUtils.write(`${output}/fig1-worker-192.png`, workerFigure.data);
        report.fig1Worker = { width: workerFigure.width, height: workerFigure.height,
            bytes: workerFigure.data.byteLength };
        await workerSession.close();
        await client.disposeAll();
    }
    catch (error) { report.progressive = { error: String((error && error.message) || error), step: progressiveStep, name: String(error && error.name), stack: String(error && error.stack) }; }

    worker.terminate();
    await IOUtils.writeUTF8(output + '/probe-result.json', JSON.stringify(report, null, 2));
    return report;
}
