import { MarkdownTabPresenter } from '../src/ui/markdown-tab-presenter.js';
import { createMarkdownTabView } from '../src/ui/markdown-window.js';
import {
    collectMarkdownTranslationBlocks, createDocumentTranslationViews,
} from '../src/markdown/markdown-translation-blocks.js';
import { createZoteroSavedMarkdownStore } from '../src/platform/zotero-saved-markdown-store.js';
import { createZoteroMarkdownExporter } from '../src/platform/zotero-markdown-exporter.js';
import { createZoteroSourceNavigation, normalizedBBoxToPDFRect } from '../src/platform/zotero-source-navigation.js';
import { MINERU_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';
import { collectFigureImageNodes } from '../src/figures/figure-model.js';

export async function runFigureReaderValidation({
    zotero, rootURI, stylesheetText, documents, cycles = 100,
    onProgress = () => {}, onOpenSource = null, listenerSnapshot = () => null,
    ownerWindow = zotero.getMainWindow(), onSaveSnapshot = null, onExportMarkdown = null,
    captureScreenshot = null, ownerWindows = [ownerWindow],
}) {
    let owner = ownerWindow;
    const report = { cycles: 0, windows: ownerWindows.length, layouts: [], sourceNavigations: 0, closeCallbacks: 0 };
    const document = documents.find(value => value.provider === 'mineru' && value.caseID === 'grid-2x2')?.document;
    if (!document) throw new Error('Restored reader fixture is missing');
    const figure = document.figureMap.figures[0];
    const blocks = collectMarkdownTranslationBlocks(document.markdown);
    const views = createDocumentTranslationViews(document.markdown, blocks,
        blocks.filter(block => block.translatable).map(block => ({
            id: block.id,
            markdown: block.requestMarkdown.replace('Treatment response in all panels.', 'Translated treatment response.'),
        })), { figureMap: document.figureMap });
    const urlTrackers = ownerWindows.map(trackObjectURLs);
    const activeURLs = () => urlTrackers.reduce((total, tracker) => total + tracker.active.size, 0);
    const presenter = new MarkdownTabPresenter({
        zotero: Object.assign(Object.create(zotero), { getMainWindow: () => owner }), rootURI,
        createView: options => createMarkdownTabView({ ...options, stylesheetText }),
    });
    let serial = 0;
    let sourceNavigation;
    let snapshotOperation;
    let exportOperation;
    const open = () => {
        const id = `figure-validation-${++serial}`;
        let presentation;
        presentation = presenter.open(id, {
            sourceItemID: 'figure-validation-pdf',
            onClose: () => { report.closeCallbacks++; },
            onTranslateDocument: () => {},
            onSaveSnapshot: onSaveSnapshot ? () => snapshotOperation = onSaveSnapshot(document) : null,
            onExportMarkdown: onExportMarkdown ? () => exportOperation = onExportMarkdown(document) : null,
            onSetTranslationView: translationView => presenter.update(presentation, { translationView }),
            onOpenSourceInPDF: location => sourceNavigation = (async () => {
                requireCondition(location.pageIndex === figure.pageIndex
                    && sameBox(location.bbox, figure.visualBBox), 'Figure source location differs from its PDF region');
                await onOpenSource?.(location);
                report.sourceNavigations++;
            })(),
        });
        presenter.update(presentation, {
            ...document, title: 'Figure validation', status: 'ready', progress: 100,
            sourceKind: 'markdown', renderMode: 'markdown', translationStatus: 'ready', translationView: 'original',
            translationBlocks: blocks, translatedMarkdown: views.translatedMarkdown,
            comparisonMarkdown: views.comparisonMarkdown, translationBlockRanges: views.blockRanges,
            translationTargetLanguage: 'en-US', translationConfiguredTargetLanguage: 'en-US',
        });
        return presentation;
    };
    const close = async presentation => {
        presentation.tabs.close(presentation.tabID);
        await settle(owner);
        requireCondition(!presenter.get(presentation.model.documentID), 'Closed figure tab remains registered');
        requireCondition(!presentation.view.root.isConnected, 'Closed figure view remains attached');
        requireCondition(activeURLs() === 0, 'Closed figure view retains object URLs');
    };
    try {
        for (const window of ownerWindows) {
            owner = window;
            owner.focus();
            await close(open());
        }
        owner = ownerWindow;
        owner.focus();
        report.listenerBeforeWorkflows = ownerWindows.flatMap(window => listenerSnapshot(window) || []);
        report.urlBaseline = activeURLs();
        const presentation = open();
        try {
            for (const width of [300, 520, 760, 1200]) {
                Object.assign(presentation.view.host.style, { width: `${width}px`, maxWidth: `${width}px` });
                for (const mode of ['original', 'translated', 'compare']) {
                    const shadow = readerShadow(presentation);
                    shadow.querySelector(`[data-translation-view="${mode}"]`).click();
                    requireCondition(presentation.model.translationView === mode, 'Translation control did not change the reader');
                    const listMode = shadow.querySelector('[data-outline-segment="figures"]');
                    requireCondition(listMode, 'Figure directory control is missing');
                    listMode.click();
                    const targets = shadow.querySelectorAll('[data-asset-type="figure"]');
                    requireCondition(targets.length === 1, 'Figure directory duplicated or lost the figure');
                    targets[0].click();
                    await settle(owner);
                    await waitForImages(shadow, owner);
                    const images = [...shadow.querySelectorAll('.cm-content figure img:not([aria-hidden="true"])')];
                    requireCondition(images.length === 1, 'Reader duplicated or lost the complete image');
                    const image = images[0];
                    const rect = image.getBoundingClientRect();
                    const host = shadow.querySelector('.markdown-editor-host').getBoundingClientRect();
                    const readerWidth = presentation.view.host.getBoundingClientRect().width;
                    requireCondition(Math.abs(readerWidth - width) <= 1, 'Reader fixture width was not applied');
                    requireCondition(rect.width > 0 && rect.height > 0, 'Reader image has no visible size');
                    requireCondition(Math.abs(rect.width / rect.height - image.naturalWidth / image.naturalHeight) < 0.01,
                        'Reader changed the figure aspect ratio');
                    requireCondition(rect.left >= host.left - 1 && rect.right <= host.right + 1,
                        'Reader image exceeds its reading pane');
                    const captions = [...shadow.querySelectorAll('.cm-content figcaption')];
                    requireCondition(captions.length === 1, 'Reader duplicated or lost the figure caption');
                    if (mode === 'compare') {
                        requireCondition(shadow.querySelector('.cm-content').textContent.includes('Translated treatment response.'),
                            'Comparison reader lost the translated caption');
                    }
                    report.layouts.push({ width, mode, imageWidth: rect.width, imageHeight: rect.height });
                    if (captureScreenshot && mode === 'original') {
                        await captureScreenshot(presentation.view.host, `reader-${width}.png`);
                    }
                }
            }
            presenter.update(presentation, { translationView: 'original' });
            presentation.view.editor.scrollToOffset(figure.render.range.from);
            await settle(owner);
            const enlargedShadow = readerShadow(presentation);
            const sourceImage = enlargedShadow.querySelector('.cm-content figure img:not([aria-hidden="true"])');
            sourceImage.dispatchEvent(new owner.MouseEvent('click', { bubbles: true, button: 0 }));
            await waitForImages(enlargedShadow, owner);
            const enlarged = enlargedShadow.querySelector('.mktero-image-preview');
            requireCondition(enlarged?.querySelector('img')?.naturalWidth === sourceImage.naturalWidth,
                'Image enlargement did not load the complete PNG');
            enlarged.querySelectorAll('button')[1].click();
            requireCondition(enlarged.querySelector('output').textContent === '125%', 'Image zoom did not change');
            owner.dispatchEvent(new owner.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            requireCondition(!enlarged.isConnected, 'Enlarged image did not close');
            report.imageZoom = true;
            presentation.view.editor.scrollToOffset(document.markdown.indexOf('See Fig.'));
            await settle(owner);
            const shadow = readerShadow(presentation);
            const reference = shadow.querySelector('.cm-mktero-figure-reference');
            requireCondition(reference, 'Figure reference is missing');
            reference.dispatchEvent(new owner.MouseEvent('mouseover', { bubbles: true }));
            await waitForImages(shadow, owner);
            const popup = shadow.querySelector('.mktero-figure-preview-popup');
            requireCondition(popup?.querySelectorAll('img').length === 1, 'Figure preview lost the complete image');
            const sourceButton = popup.querySelector('.mktero-figure-source-button');
            requireCondition(sourceButton, 'Figure source navigation is missing');
            sourceButton.click();
            await sourceNavigation;
            await settle(owner);
            requireCondition(report.sourceNavigations === 1, 'Figure source navigation did not complete');
            presentation.tabs.select(presentation.tabID);
            if (onSaveSnapshot) {
                shadow.querySelector('#mktero-document-actions').click();
                shadow.querySelector('#mktero-save-snapshot').click();
                requireCondition(snapshotOperation, 'Snapshot control did not start saving');
                await snapshotOperation;
                await settle(owner);
                report.snapshot = true;
            }
            if (onExportMarkdown) {
                shadow.querySelector('#mktero-document-actions').click();
                shadow.querySelector('#mktero-export-markdown').click();
                requireCondition(exportOperation, 'Export control did not start exporting');
                await exportOperation;
                await settle(owner);
                report.export = true;
            }
        }
        finally { await close(presentation); }
        // PDF navigation and snapshot saving initialize Zotero's shared UI once.
        // Measure repeated reader cleanup after those workflows have settled.
        report.listenerBaseline = ownerWindows.flatMap(window => listenerSnapshot(window) || []);
        for (let index = 0; index < cycles; index++) {
            owner = ownerWindows[index % ownerWindows.length];
            owner.focus();
            const current = open();
            await settle(owner);
            const mode = ['original', 'translated', 'compare'][index % 3];
            readerShadow(current).querySelector(`[data-translation-view="${mode}"]`).click();
            await close(current);
            report.cycles++;
            if ((index + 1) % 10 === 0) await onProgress({ cycles: report.cycles });
        }
        owner = ownerWindows[0];
        const first = open();
        owner = ownerWindows.at(-1);
        const replacement = open();
        requireCondition(!first.view.root.isConnected && !presenter.get(first.model.documentID),
            'Opening the same PDF in another window retained the old figure tab');
        await close(replacement);
        report.sourceReplacement = true;
        report.listenerFinal = ownerWindows.flatMap(window => listenerSnapshot(window) || []);
        report.urlFinal = activeURLs();
        requireCondition(noAdditionalListeners(report.listenerBaseline, report.listenerFinal),
            'Figure reader retained listeners after repeated tab closes');
        requireCondition(report.closeCallbacks === cycles + 3 + ownerWindows.length,
            'A tab close callback was lost or repeated');
        report.passed = true;
        return report;
    }
    finally {
        presenter.dispose();
        for (const tracker of urlTrackers) tracker.restore();
    }
}

export async function createFigureWorkflowValidation({ zotero, root, output, document, ownerWindow }) {
    const parent = new zotero.Item('journalArticle');
    parent.libraryID = zotero.Libraries.userLibraryID;
    parent.setField('title', 'Figure restoration validation');
    await parent.saveTx();
    const pdf = await zotero.Attachments.importFromFile({
        file: root + '/test/fixtures/figures/compound-figures.pdf', parentItemID: parent.id,
    });
    const store = createZoteroSavedMarkdownStore({ zotero,
        readFile: path => IOUtils.read(path),
        writeTemporaryFile: async ({ name, data }) => {
            const file = output + '/temporary-' + name;
            await IOUtils.write(file, data);
            return { path: file, cleanup: () => IOUtils.remove(file, { ignoreAbsent: true }) };
        },
        createBlob: (parts, options) => new ownerWindow.Blob(parts, options),
        now: () => new Date().toISOString(),
    });
    const exportRoot = output + '/exports';
    await IOUtils.makeDirectory(exportRoot, { ignoreExisting: true });
    const exporter = createZoteroMarkdownExporter({ ioUtils: IOUtils, pathUtils: PathUtils,
        createID: () => 'figure-validation',
        createFilePicker: () => ({ modeGetFolder: 2, returnCancel: 1, init() {},
            show: async () => 0, file: exportRoot }),
    });
    let openedReader;
    let savedNote;
    const navigation = createZoteroSourceNavigation(zotero);
    const report = { navigation: false, snapshot: false, export: false };
    return {
        report,
        async onOpenSource(location) {
            openedReader = await zotero.Reader.open(pdf.id);
            let actual;
            const navigate = openedReader.navigate;
            openedReader.navigate = function (value) { actual = value; return navigate.call(this, value); };
            try { await navigation.open(pdf.id, location); }
            finally { openedReader.navigate = navigate; }
            const app = openedReader._internalReader._primaryView._iframeWindow.PDFViewerApplication;
            const viewport = app.pdfViewer.getPageView(location.pageIndex).viewport;
            requireCondition(actual?.position?.pageIndex === location.pageIndex
                && sameBox(actual.position.rects[0], normalizedBBoxToPDFRect(location.bbox, viewport)),
            'Native PDF navigation did not receive the expected region');
            report.navigation = true;
            await openedReader.close();
            openedReader = null;
        },
        async onSaveSnapshot() {
            const saved = await store.saveSnapshot({ ...document, pdfItem: pdf, parentItem: parent,
                cacheKey: 'a'.repeat(64), parserProfile: MINERU_PARSER_PROFILE_ID });
            savedNote = saved.note;
            const restored = await store.read(saved.noteID);
            requireCondition(restored.sourceAvailable && restored.assetsComplete
                && restored.markdown === document.markdown, 'Native snapshot did not preserve the document');
            requireCondition(JSON.stringify(restored.figureMap) === JSON.stringify(document.figureMap),
                'Native snapshot lost figure identity');
            requireCondition(collectFigureImageNodes(restored.markdown).length === 1,
                'Native snapshot duplicated figure images');
            report.snapshot = true;
            return { status: 'saved' };
        },
        async onExportMarkdown() {
            const exported = await exporter.export({ ownerWindow, title: 'Figure validation',
                markdown: document.markdown, assets: document.assets, assetBasePath: document.assetBasePath });
            requireCondition(exported.status === 'exported' && exported.assetCount === document.assets.length,
                'Native Markdown export lost document assets');
            const markdown = await IOUtils.readUTF8(exported.path);
            const images = collectFigureImageNodes(markdown);
            requireCondition(images.length === 1, 'Exported Markdown did not contain one figure');
            const asset = await IOUtils.read(PathUtils.join(PathUtils.parent(exported.path),
                ...images[0].assetPath.split('/')));
            const original = document.assets.find(value => value.path === document.figureMap.figures[0].render.assetPath).data;
            requireCondition(asset.length === original.length && asset.every((byte, index) => byte === original[index]),
                'Export changed the complete PNG');
            report.export = true;
            return exported;
        },
        async dispose() {
            await openedReader?.close();
            if (savedNote) await store.deleteSavedNote(savedNote);
            await parent.eraseTx();
        },
    };
}

function trackObjectURLs(owner) {
    const originalCreate = owner.URL.createObjectURL;
    const originalRevoke = owner.URL.revokeObjectURL;
    const active = new Set();
    owner.URL.createObjectURL = function (blob) {
        const url = originalCreate.call(this, blob);
        active.add(url);
        return url;
    };
    owner.URL.revokeObjectURL = function (url) {
        active.delete(url);
        return originalRevoke.call(this, url);
    };
    return { active, restore() {
        owner.URL.createObjectURL = originalCreate;
        owner.URL.revokeObjectURL = originalRevoke;
    } };
}

async function waitForImages(root, owner) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const images = [...root.querySelectorAll('img[src]')]
            .filter(image => image.getAttribute('src'));
        if (images.every(image => image.complete && image.naturalWidth > 0)) return;
        await new Promise(resolve => owner.setTimeout(resolve, 20));
    }
    const pending = [...root.querySelectorAll('img[src]')]
        .filter(image => image.getAttribute('src') && (!image.complete || !image.naturalWidth))
        .map(image => ({ className: image.className, namespace: image.namespaceURI,
            complete: image.complete, width: image.naturalWidth }));
    throw new Error(`Reader images did not finish decoding: ${JSON.stringify(pending)}`);
}

async function settle(owner) {
    await new Promise(resolve => {
        let frame;
        const finish = () => {
            owner.clearTimeout(timer);
            owner.cancelAnimationFrame(frame);
            resolve();
        };
        // Hidden macOS windows may suspend animation frames entirely.
        const timer = owner.setTimeout(finish, 100);
        frame = owner.requestAnimationFrame(() => { frame = owner.requestAnimationFrame(finish); });
    });
}

function requireCondition(value, message) {
    if (!value) throw new Error(message);
}

function noAdditionalListeners(baseline, current) {
    if (!baseline || !current) return baseline === current;
    return current.every((types, index) => {
        const remaining = [...baseline[index]];
        return types.every(type => {
            const position = remaining.indexOf(type);
            if (position < 0) return false;
            remaining.splice(position, 1);
            return true;
        });
    });
}

function sameBox(left, right) {
    return Array.isArray(left) && left.length === 4
        && left.every((value, index) => Math.abs(value - right[index]) < 1e-6);
}

function readerShadow(presentation) {
    return presentation.view.root.querySelector('.mktero-tab-host').shadowRoot;
}
