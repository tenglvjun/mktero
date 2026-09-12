import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';
// Match bootstrap's bundled in-process worker registration in Zotero sandboxes.
import '../src/pdf/pdfjs-text-engine.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createZoteroFigureCanvasEnvironment } from '../src/platform/zotero-figure-canvas.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { createFigureProviderFixture } from '../test/helpers/figure-provider-fixtures.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';
import { prepareMistralResult } from '../src/mistral/mistral-result.js';
import { sha256Hex } from '../src/core/sha256.js';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import { analyzeDocumentFigures } from '../src/figures/figure-analysis.js';
import { collectMarkdownTranslationBlocks, createDocumentTranslationViews } from '../src/markdown/markdown-translation-blocks.js';
export { runFigureReaderValidation, createFigureWorkflowValidation } from './figure-region-reader-harness.mjs';

let renderer;
let editor;
const objectURLs = [];
export const validationDocuments = [];

export async function runFigureValidation({ fixtureRoot, resourceRoot, outputRoot = null, signal,
    ownerDocument = globalThis.document || globalThis.Zotero?.getMainWindow()?.document,
    read = null, write = null, providers = ['mineru', 'mistral'], caseIDs = null } = {}) {
    await disposeFigureValidation();
    validationDocuments.length = 0;
    const readBytes = read || (globalThis.IOUtils
        ? path => IOUtils.read(path)
        : async url => new Uint8Array(await (await fetch(url)).arrayBuffer()));
    const writeBytes = write || (globalThis.IOUtils && outputRoot
        ? async (name, data) => {
            await IOUtils.makeDirectory(outputRoot, { ignoreExisting: true });
            await IOUtils.write(outputRoot + '/' + name, data);
        } : null);
    const fileData = await readBytes(fixtureRoot + '/compound-figures.pdf');
    const manifest = JSON.parse(new TextDecoder().decode(await readBytes(fixtureRoot + '/compound-figures.expected.json')));
    const resources = trackRenderResources(ownerDocument.defaultView);
    const environment = resources.environment;
    renderer = createPDFFigureRegionRenderer({ ...environment, ...resources.options,
        workerSrc: resourceRoot + '/pdf.worker.mjs', cMapUrl: resourceRoot + '/pdfjs/cmaps/',
        standardFontDataUrl: resourceRoot + '/pdfjs/standard_fonts/', wasmUrl: resourceRoot + '/pdfjs/wasm/' });
    const hash = data => sha256Hex(data, { crypto: ownerDocument.defaultView.crypto });
    const renderErrors = [];
    const service = new FigureRestorationService({ openPDF: async (data, options) => {
        try {
            const session = await renderer.open(data, options);
            return { ...session, renderRegion: async (...args) => {
                try { return await session.renderRegion(...args); }
                catch (error) {
                    renderErrors.push({ stage: 'render', message: String(error), stack: error.stack });
                    throw error;
                }
            } };
        }
        catch (error) {
            renderErrors.push({ stage: 'open', message: String(error), stack: error.stack });
            throw error;
        }
    }, hash });
    const report = { environment: ownerDocument.defaultView.navigator.userAgent, cases: [] };
    try {
        for (const provider of providers) {
            for (const caseID of caseIDs || Object.keys(manifest.cases)) {
                const started = performance.now();
                const fixture = await createFigureProviderFixture(caseID, provider, { fileData, manifest });
                const draft = await service.restore(fixture.input, { fileData, signal });
                const document = await finalizeRestoredDocument(fixture.input, draft, { hash, signal,
                    prepare: provider === 'mineru' ? prepareMinerUResult : prepareMistralResult });
                const record = { provider, caseID, coordinateEvidence: fixture.coordinateEvidence,
                    passed: true, figures: document.figureMap.figures.length,
                    expectedFigures: fixture.expected.figures, crops: [], errors: renderErrors.splice(0) };
                if (record.figures !== record.expectedFigures) {
                    record.passed = false;
                    record.reasons = document.figureMap.preserved.map(value => value.reason);
                }
                for (const [index, figure] of document.figureMap.figures.entries()) {
                    const asset = document.assets.find(value => value.path === figure.render.assetPath);
                    const page = fixture.scene.pages.find(value => value.pageIndex === figure.pageIndex);
                    const image = await decodePNG(environment, asset.data);
                    try {
                        const inspection = inspectCrop(image.canvas, figure, page);
                        record.crops.push(inspection);
                        if (!inspection.passed) record.passed = false;
                    }
                    finally {
                        image.canvas.width = image.canvas.height = 0;
                    }
                    await writeBytes?.(`${provider}-${caseID}-${index}.png`, asset.data);
                }
                record.elapsedMs = Math.round(performance.now() - started);
                report.cases.push(record);
                validationDocuments.push({ provider, caseID, document });
                await writeBytes?.(`${provider}-${caseID}.md`, new TextEncoder().encode(document.markdown));
                await writeBytes?.(`${provider}-${caseID}.figure-map.json`, new TextEncoder().encode(JSON.stringify(document.figureMap)));
            }
        }
    }
    finally {
        await renderer.disposeAll();
        renderer = null;
    }
    report.resources = resources.snapshot();
    report.passed = report.cases.every(record => record.passed) && resources.released();
    await writeBytes?.('report.json', new TextEncoder().encode(JSON.stringify(report, null, 2)));
    return report;
}

export async function runFigureRenderLifecycleValidation({ fileData, resourceRoot, ownerWindows,
    cycles = 100, onProgress = () => {} }) {
    const report = { cycles: 0, cancelled: 0, encodingCancelled: 0, windows: ownerWindows.length, resources: [] };
    for (const owner of ownerWindows) {
        const tracked = trackRenderResources(owner);
        const renderer = createPDFFigureRegionRenderer({ ...tracked.environment, ...tracked.options,
            workerSrc: resourceRoot + '/pdf.worker.mjs', cMapUrl: resourceRoot + '/pdfjs/cmaps/',
            standardFontDataUrl: resourceRoot + '/pdfjs/standard_fonts/', wasmUrl: resourceRoot + '/pdfjs/wasm/' });
        const count = Math.floor(cycles / ownerWindows.length)
            + (report.resources.length < cycles % ownerWindows.length ? 1 : 0);
        try {
            for (let index = 0; index < count; index++) {
                const controller = new owner.AbortController();
                const cancellation = index % 3;
                const shouldCancel = cancellation !== 0;
                const session = await renderer.open(fileData, { signal: controller.signal });
                try {
                    const geometry = await session.getPageGeometry(0);
                    // Abort only after the real PDF.js render task has been created.
                    tracked.onRender = cancellation === 1 ? () => controller.abort() : null;
                    tracked.onEncode = cancellation === 2 ? () => controller.abort() : null;
                    let cancelled = false;
                    try {
                        await session.renderRegion({ pageIndex: 0, bbox: [80, 160, 920, 710],
                            coordinateFrame: 'display-cropbox', rotation: geometry.rotation, dpi: 72 });
                    }
                    catch (error) {
                        if (!shouldCancel || error.name !== 'AbortError') throw error;
                        cancelled = true;
                        report.cancelled++;
                        if (cancellation === 2) report.encodingCancelled++;
                    }
                    if (cancelled !== shouldCancel) throw new Error('Native render cancellation did not propagate');
                }
                finally { await session.close(); }
                if (!tracked.released()) throw new Error('Native render retained resources: '
                    + JSON.stringify(tracked.snapshot()));
                report.cycles++;
                if (report.cycles % 10 === 0) await onProgress({ renderCycles: report.cycles });
            }
        }
        finally { await renderer.disposeAll(); }
        report.resources.push(tracked.snapshot());
    }
    report.passed = report.cycles === cycles && report.cancelled > 0;
    return report;
}

function trackRenderResources(owner) {
    const environment = createZoteroFigureCanvasEnvironment({ getMainWindow: () => owner });
    const canvases = new Set();
    const loads = new Set();
    const renders = new Set();
    const timers = new Set();
    const listeners = new Set();
    let canvasCount = 0;
    const state = {
        onRender: null, onEncode: null,
        environment: { ...environment, createCanvas(width, height) {
            const canvas = environment.createCanvas(width, height);
            canvases.add(canvas);
            canvasCount++;
            return canvas;
        }, encodePNG(canvas, options) {
            const operation = environment.encodePNG(canvas, options);
            state.onEncode?.();
            return operation;
        } },
        options: {
            createAbortController() {
                const controller = new owner.AbortController();
                const signal = controller.signal;
                const add = signal.addEventListener.bind(signal);
                const remove = signal.removeEventListener.bind(signal);
                signal.addEventListener = (type, listener, options) => {
                    if (type === 'abort') listeners.add(listener);
                    add(type, listener, options);
                };
                signal.removeEventListener = (type, listener, options) => {
                    if (type === 'abort') listeners.delete(listener);
                    remove(type, listener, options);
                };
                return controller;
            },
            setTimeout(callback, delay) {
                const timer = owner.setTimeout(() => { timers.delete(timer); callback(); }, delay);
                timers.add(timer);
                return timer;
            },
            clearTimeout(timer) { timers.delete(timer); owner.clearTimeout(timer); },
            loadDocument(options) {
                const task = getDocument(options);
                loads.add(task);
                let destruction;
                return {
                    promise: task.promise.then(document => ({
                        numPages: document.numPages,
                        async getPage(number) {
                            const page = await document.getPage(number);
                            return {
                                rotate: page.rotate, userUnit: page.userUnit, view: page.view,
                                getViewport: options => page.getViewport(options),
                                cleanup: () => page.cleanup(),
                                render(options) {
                                    const render = page.render(options);
                                    renders.add(render);
                                    render.promise.then(() => renders.delete(render), () => renders.delete(render));
                                    state.onRender?.();
                                    return render;
                                },
                            };
                        },
                    })),
                    destroy() {
                        destruction ||= Promise.resolve(task.destroy()).finally(() => loads.delete(task));
                        return destruction;
                    },
                };
            },
        },
        snapshot() {
            for (const canvas of canvases) {
                if (!canvas.width && !canvas.height) canvases.delete(canvas);
            }
            return { loadingTasks: loads.size, renderTasks: renders.size, canvases: canvases.size,
                timers: timers.size, abortListeners: listeners.size, canvasesCreated: canvasCount };
        },
        released() {
            const { canvasesCreated, ...active } = state.snapshot();
            return Object.values(active).every(value => value === 0);
        },
    };
    return state;
}

function inspectCrop(canvas, figure, page) {
    const context = canvas.getContext('2d');
    const [left, top, right, bottom] = figure.visualBBox;
    const contains = box => box[0] >= left && box[1] >= top && box[2] <= right && box[3] <= bottom;
    const project = ([x, y]) => [
        Math.max(0, Math.min(canvas.width - 1, Math.floor((x - left) / (right - left) * canvas.width))),
        Math.max(0, Math.min(canvas.height - 1, Math.floor((y - top) / (bottom - top) * canvas.height))),
    ];
    const probes = [...page.pixelProbes, ...page.featureProbes].filter(probe => contains(
        probe.bbox || [...probe.point, ...probe.point]
    )).map(probe => {
        if (probe.point) {
            const [x, y] = project(probe.point);
            const color = [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
            return { name: probe.name, color,
                passed: probe.color.every((value, index) => Math.abs(value - color[index]) <= 8) };
        }
        const [x0, y0] = project(probe.bbox.slice(0, 2));
        const [x1, y1] = project(probe.bbox.slice(2));
        const pixels = context.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
        let darkPixels = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            // The fixed raster's antialiased one-pixel axes reach RGB 140;
            // every panel background remains above 200 in all channels.
            if (pixels[i] < 160 && pixels[i + 1] < 160 && pixels[i + 2] < 160 && pixels[i + 3] > 0) {
                darkPixels++;
            }
        }
        return { name: probe.name, darkPixels, passed: darkPixels >= probe.minDark };
    });
    const matchesExpectedBounds = page.expectedBoxes.some(box => box.every((value, index) => (
        Math.abs(value - figure.visualBBox[index]) < 1e-6
    )));
    const excludesExternalContent = [page.bodyBBox, ...page.groups.map(group => group.captionBBox),
        ...page.headings.map(heading => heading.bbox), ...(page.columns || []).map(column => column.bbox)]
        .every(box => box[0] >= right || box[2] <= left || box[1] >= bottom || box[3] <= top);
    const expectedRatio = (right - left) * page.width / ((bottom - top) * page.height);
    const matchesRatio = Math.abs(canvas.width / canvas.height - expectedRatio) < 0.01;
    return {
        width: canvas.width, height: canvas.height, matchesExpectedBounds, excludesExternalContent, matchesRatio,
        probes, passed: probes.length > 0 && probes.every(probe => probe.passed)
            && matchesExpectedBounds && excludesExternalContent && matchesRatio,
    };
}

export function showValidationDocument(parent, { caseID = 'grid-4x4', provider = 'mineru', view = 'original' } = {}) {
    editor?.destroy();
    editor = null;
    releaseURLs();
    const source = validationDocuments.find(value => value.caseID === caseID && value.provider === provider)?.document;
    if (!source) throw new Error('Validation document is unavailable');
    const ownerWindow = parent.ownerDocument.defaultView;
    const urls = new Map(source.assets.map(asset => {
        const url = ownerWindow.URL.createObjectURL(new ownerWindow.Blob([asset.data], { type: asset.mimeType }));
        objectURLs.push({ ownerWindow, url });
        return [asset.path, url];
    }));
    const blocks = collectMarkdownTranslationBlocks(source.markdown);
    const views = createDocumentTranslationViews(source.markdown, blocks,
        blocks.filter(block => block.translatable).map(block => ({ id: block.id,
            markdown: block.requestMarkdown.replace('Treatment response in all panels.', 'Translated treatment response.') })),
        { figureMap: source.figureMap });
    const markdown = view === 'comparison' ? views.comparisonMarkdown
        : view === 'translation' ? views.translatedMarkdown : source.markdown;
    const figureViews = analyzeDocumentFigures(markdown, { figureMap: source.figureMap,
        viewRanges: views.blockRanges, viewKind: view });
    editor = createInlineMarkdownEditor({ parent, initialMarkdown: '', resolveImageURL: path => urls.get(path) || null });
    editor.setDocument({ markdown, figureViews, sourceMap: view === 'original' ? source.sourceMap : [],
        translationRanges: view === 'comparison' ? views.comparisonTranslationRanges : [] });
    if (figureViews[0]) editor.scrollToOffset(figureViews[0].from);
    return { figures: figureViews.length, sourceIds: figureViews.map(figure => figure.sourceId) };
}

export async function disposeFigureValidation() {
    editor?.destroy();
    editor = null;
    releaseURLs();
    await renderer?.disposeAll();
    renderer = null;
}

export async function showValidationComparison(parent, { fileData, resourceRoot, caseID = 'grid-4x4' }) {
    const document = validationDocuments.find(value => value.provider === 'mineru' && value.caseID === caseID)?.document;
    const figure = document?.figureMap?.figures[0];
    if (!figure) throw new Error('Comparison figure is unavailable');
    const environment = createZoteroFigureCanvasEnvironment({ getMainWindow: () => parent.ownerDocument.defaultView });
    const renderer = createPDFFigureRegionRenderer({ ...environment,
        workerSrc: resourceRoot + '/pdf.worker.mjs', cMapUrl: resourceRoot + '/pdfjs/cmaps/',
        standardFontDataUrl: resourceRoot + '/pdfjs/standard_fonts/', wasmUrl: resourceRoot + '/pdfjs/wasm/' });
    let page;
    let crop;
    try {
        const session = await renderer.open(fileData);
        const geometry = await session.getPageGeometry(figure.pageIndex);
        const source = await session.renderRegion({ pageIndex: figure.pageIndex, bbox: [0, 0, 1000, 1000],
            coordinateFrame: 'display-cropbox', rotation: geometry.rotation, dpi: 72 });
        page = await decodePNG(environment, source.data);
        crop = await decodePNG(environment, document.assets.find(asset => asset.path === figure.render.assetPath).data);
        const canvas = environment.createCanvas(1200, 900);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        const draw = (image, x, title) => {
            const scale = Math.min(550 / image.width, 790 / image.height);
            const width = image.width * scale;
            const height = image.height * scale;
            context.fillStyle = '#202428';
            context.font = '18px sans-serif';
            context.fillText(title, x, 32);
            context.drawImage(image, x, 60, width, height);
            return { x, y: 60, width, height };
        };
        const sourceRect = draw(page.canvas, 20, 'Original PDF page');
        draw(crop.canvas, 620, 'Restored PNG');
        const [left, top, right, bottom] = figure.visualBBox;
        context.strokeStyle = '#c61d36';
        context.lineWidth = 2;
        context.strokeRect(sourceRect.x + left / 1000 * sourceRect.width,
            sourceRect.y + top / 1000 * sourceRect.height,
            (right - left) / 1000 * sourceRect.width, (bottom - top) / 1000 * sourceRect.height);
        parent.replaceChildren(canvas);
    }
    finally {
        await renderer.disposeAll();
        if (page) page.canvas.width = page.canvas.height = 0;
        if (crop) crop.canvas.width = crop.canvas.height = 0;
    }
}

function releaseURLs() {
    for (const { ownerWindow, url } of objectURLs.splice(0)) ownerWindow.URL.revokeObjectURL(url);
}

async function decodePNG(environment, data) {
    const window = environment.ownerDocument.defaultView;
    const url = window.URL.createObjectURL(new window.Blob([data], { type: 'image/png' }));
    try {
        const image = new window.Image();
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
        const canvas = environment.createCanvas(image.naturalWidth, image.naturalHeight);
        canvas.getContext('2d').drawImage(image, 0, 0);
        return { canvas };
    }
    finally {
        window.URL.revokeObjectURL(url);
    }
}
