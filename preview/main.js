// Browser preview entry: mounts the real Mktero reader (createMarkdownTabView)
// inside a Zotero-style window with a sample paper. Nothing here talks to a
// network: conversion, PDF rendering, translation and annotation sync are
// replaced by the fixture, and the page's CSP blocks connections.
import { createMarkdownTabView } from '../src/ui/markdown-window.js';
import { createLocalization } from '../src/i18n/localization.js';
import {
    collectMatchedAnnotationRanges,
    openMarkdownRevisionSession,
} from '../src/core/markdown-revision-session.js';
import {
    createEvidenceSnippet,
    formatEvidenceMarkdown,
} from '../src/markdown/markdown-evidence.js';
import {
    createPaperAnnotationOverlay,
    createPaperSourceMap,
    createPaperTranslation,
    inlineText,
    layoutPaperPages,
    segmentPaperMarkdown,
} from './document.js';
import {
    createFigureAsset,
    createTextMeasure,
    renderPageThumbnail,
} from './render.js';
import { createPreviewShell } from './shell.js';
import { forceLightColorScheme, lightOnlyStyles, postReady } from './embed.js';
import {
    createSelfTest,
    installErrorCapture,
    renderDiagnosticsPanel,
} from './diagnostics.js';
import {
    FIGURE_PATH,
    PAPER_ANNOTATIONS,
    PAPER_CREATORS,
    PAPER_MARKDOWN,
    PAPER_SHORT_TITLE,
    PAPER_TITLE,
    PAPER_TRANSLATIONS_ZH_CN,
    PAPER_YEAR,
} from './fixture/paper.js';

const CACHE_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SOURCE_HASH = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const ITEM_ID = 101;
const ITEM_KEY = 'PREVIEW0';
const TRANSLATION_LANGUAGE = 'zh-CN';

const capture = installErrorCapture(window);
const params = new URLSearchParams(window.location.search);
const language = params.get('lang') === 'zh' ? 'zh' : 'en';
const initialTab = ['library', 'pdf', 'reader'].includes(params.get('tab'))
    ? params.get('tab')
    : 'reader';
document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
if (params.get('frame') === 'desktop') document.documentElement.dataset.frame = 'desktop';
// An embedding page with a fixed light design passes theme=light so the
// reader does not turn dark with the visitor's system setting.
const forceLight = params.get('theme') === 'light';
if (forceLight) {
    document.documentElement.dataset.theme = 'light';
    forceLightColorScheme(window);
}

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
});
window.__mkteroPreview = { ready, capture };

start().catch(error => {
    capture.logError(error);
    rejectReady(error);
    const message = document.createElement('pre');
    message.className = 'preview-fatal';
    message.textContent = `Preview could not start: ${error?.message || error}`;
    document.body.appendChild(message);
});

async function start() {
    await document.fonts?.ready;
    const localization = createLocalization({
        zoteroLocale: language === 'zh' ? 'zh-CN' : 'en-US',
    });
    const measure = createTextMeasure(document);
    const segments = segmentPaperMarkdown(PAPER_MARKDOWN);
    const pages = layoutPaperPages(segments, { measure });
    const sourceMap = createPaperSourceMap(segments, pages);
    const figureData = await createFigureAsset(document);
    const figureImage = await decodeImage(figureData);
    const assets = [{ path: FIGURE_PATH, mimeType: 'image/png', data: figureData }];

    const session = await openMarkdownRevisionSession({
        baseDocument: {
            itemID: ITEM_ID,
            cacheKey: CACHE_KEY,
            markdown: PAPER_MARKDOWN,
            sourceMap,
            assets,
            assetBasePath: '',
            extractedPages: pages.length,
            totalPages: pages.length,
        },
        store: createMemoryRevisionStore(),
        onError: error => capture.logError(error),
    });

    const annotationState = {
        deleted: new Set(),
        colors: new Map(),
        comments: new Map(),
        local: [],
        sequence: 0,
    };
    const thumbnails = new Map();
    let view = null;
    let shell = null;
    let model = null;
    let selectionTimers = [];

    const update = changes => {
        Object.assign(model, changes);
        view?.render(model);
    };

    const pdfAnnotations = () => PAPER_ANNOTATIONS
        .filter(annotation => !annotationState.deleted.has(annotation.id))
        .map(annotation => ({
            ...annotation,
            color: annotationState.colors.get(annotation.id) || annotation.color,
        }));

    const overlayFor = (markdown, snapshotSourceMap) => {
        const fixture = createPaperAnnotationOverlay(markdown, pdfAnnotations(), snapshotSourceMap);
        for (const annotation of fixture.matched) {
            if (annotationState.comments.has(annotation.id)) {
                annotation.comment = annotationState.comments.get(annotation.id);
            }
        }
        const matched = [...fixture.matched];
        const unmatched = [...fixture.unmatched];
        for (const local of annotationState.local) {
            const from = markdown.indexOf(local.text);
            if (from < 0) {
                unmatched.push({ ...local, ranges: undefined, reason: 'not-found' });
                continue;
            }
            matched.push({ ...local, ranges: [{ from, to: from + local.text.length }] });
        }
        return { matched, unmatched };
    };

    const translationFields = (markdown, translationView = 'original') => {
        const translation = createPaperTranslation(markdown, PAPER_TRANSLATIONS_ZH_CN);
        for (const missing of translation.missing) {
            capture.warnings.push({ kind: 'fixture', message: `No translation for ${missing}` });
        }
        for (const invalid of translation.invalid) {
            capture.errors.push({ kind: 'fixture', message: `Invalid translation ${invalid.id}: ${invalid.message}` });
        }
        return {
            translationView,
            translationStatus: 'ready',
            translationProgress: 100,
            translationCompletedBlocks: translation.translations.length,
            translationTotalBlocks: translation.translations.length,
            translationStage: 'complete',
            translationTargetLanguage: TRANSLATION_LANGUAGE,
            translationConfiguredTargetLanguage: TRANSLATION_LANGUAGE,
            translationRequestedTargetLanguage: '',
            translationCachedLanguages: [TRANSLATION_LANGUAGE],
            translationPartialLanguages: [],
            translationKey: 'preview-translation',
            translationSettingsIdentity: 'preview',
            translationBlocks: translation.translations,
            translationSourceBlocks: [],
            translationFailedBlocks: [],
            translationBlockRanges: translation.views.blockRanges,
            translatedMarkdown: translation.views.translatedMarkdown,
            comparisonMarkdown: translation.views.comparisonMarkdown,
            comparisonSourceRanges: translation.views.comparisonSourceRanges,
            comparisonTranslationRanges: translation.views.comparisonTranslationRanges,
            translationError: '',
            restoredTranslation: translation,
        };
    };

    const applyRevision = snapshot => {
        const { annotationRangeMappings: _mappings, ...document } = snapshot;
        update({
            ...document,
            itemID: ITEM_ID,
            annotationOverlay: overlayFor(document.markdown, document.sourceMap),
            ...translationFields(document.markdown, model.translationView),
        });
        return document;
    };

    const locationForAnnotation = id => {
        const annotation = model.annotationOverlay.matched.find(entry => entry.id === id);
        const range = annotation?.ranges?.[0];
        if (!range) return null;
        const entry = model.sourceMap.find(candidate => (
            range.from >= candidate.markdownFrom && range.from < candidate.markdownTo
        ));
        return entry?.locations?.[0] || null;
    };

    const writeClipboard = async text => {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        }
        catch {
            return false;
        }
    };

    const translateSelection = ({ text, onTextDelta } = {}) => {
        for (const timer of selectionTimers) window.clearTimeout(timer);
        selectionTimers = [];
        const translated = translatedTextFor(model, inlineText(String(text || '')));
        if (!translated) return Promise.resolve({ text: shell.copy.translationOnly });
        return new Promise(resolve => {
            let shown = 0;
            const step = () => {
                const next = Math.min(translated.length, shown + 6);
                onTextDelta?.(translated.slice(shown, next), translated.slice(0, next));
                shown = next;
                if (shown >= translated.length) {
                    resolve({ text: translated });
                    return;
                }
                selectionTimers.push(window.setTimeout(step, 28));
            };
            selectionTimers.push(window.setTimeout(step, 260));
        });
    };

    model = {
        itemID: ITEM_ID,
        documentID: ITEM_ID,
        sourceItemID: ITEM_ID,
        title: PAPER_TITLE,
        status: 'ready',
        progress: 100,
        sourceKind: 'markdown',
        provider: 'mktero',
        renderMode: 'markdown',
        cacheHit: true,
        cacheKey: CACHE_KEY,
        sourceHash: SOURCE_HASH,
        figureMap: null,
        chromeRanges: [],
        warnings: [],
        error: '',
        errorAction: null,
        warningAction: null,
        preserveContent: false,
        resumingTask: false,
        snapshotHTML: '',
        snapshotAssets: [],
        snapshotModified: false,
        ...session.snapshot(),
        correctionMode: false,
        annotationOverlay: overlayFor(PAPER_MARKDOWN, sourceMap),
        ...translationFields(PAPER_MARKDOWN),

        onSetTranslationView: translationView => update({ translationView }),
        onSelectTranslationLanguage: selected => {
            if (selected === TRANSLATION_LANGUAGE) update({ translationView: 'translated' });
            else shell.showToast(shell.copy.translationOnly);
        },
        onTranslateDocument: () => update({ translationView: 'translated' }),
        onCancelDocumentTranslation: () => false,
        onSetCorrectionMode: enabled => update({ correctionMode: Boolean(enabled) }),
        onCommitCorrection: async correction => {
            const { annotationRanges: mappedAnnotationRanges = [], ...revisionCorrection } = correction || {};
            const snapshot = await session.commit({
                ...revisionCorrection,
                annotationRanges: collectMatchedAnnotationRanges(model.annotationOverlay),
                mappedAnnotationRanges,
            });
            return applyRevision(snapshot);
        },
        onRestoreCorrection: async blockID => applyRevision(await session.restore(blockID, {
            annotationRanges: collectMatchedAnnotationRanges(model.annotationOverlay),
        })),
        onRestoreAllCorrections: async () => applyRevision(await session.restoreAll({
            annotationRanges: collectMatchedAnnotationRanges(model.annotationOverlay),
        })),

        onOpenSourceInPDF: location => shell.revealPDFLocation(location),
        onOpenAnnotationInPDF: id => {
            const location = locationForAnnotation(id);
            if (location) shell.revealPDFLocation(location);
        },
        onRenderSourcePeek: (peek, options) => {
            let dataURL = thumbnails.get(peek.pageIndex);
            if (!dataURL) {
                dataURL = renderPageThumbnail(pages[peek.pageIndex], {
                    segments,
                    runningTitle: PAPER_TITLE,
                    annotations: pdfAnnotations(),
                    figureImage,
                }, { createCanvas: options.createCanvas });
                thumbnails.set(peek.pageIndex, dataURL);
            }
            return { dataURL, pageIndex: peek.pageIndex };
        },
        onDisposeSourcePeek: () => thumbnails.clear(),

        onCreateMarkdownAnnotation: async draft => {
            const annotation = {
                id: `mktero-preview-${++annotationState.sequence}`,
                source: 'markdown',
                type: 'highlight',
                text: draft.text,
                comment: draft.comment || '',
                color: draft.color || '#ffd400',
                ranges: draft.ranges,
                matchKind: 'local',
                sortIndex: String(draft.ranges?.[0]?.from || 0).padStart(12, '0'),
            };
            annotationState.local.push(annotation);
            return annotation;
        },
        onUpdateMarkdownAnnotation: async (id, changes) => {
            const annotation = annotationState.local.find(entry => entry.id === id);
            if (annotation) Object.assign(annotation, changes);
            return null;
        },
        onDeleteMarkdownAnnotation: async id => {
            annotationState.local = annotationState.local.filter(entry => entry.id !== id);
        },
        onDeleteAnnotation: async id => {
            annotationState.deleted.add(id);
            thumbnails.clear();
            shell.refreshPDF();
        },
        onChangeAnnotationColor: async (id, color) => {
            annotationState.colors.set(id, color);
            thumbnails.clear();
            shell.refreshPDF();
        },
        onUpdateAnnotationComment: async (id, comment) => {
            annotationState.comments.set(id, comment);
        },

        onCopyCode: code => writeClipboard(code),
        onCopySelectionTranslation: text => writeClipboard(text),
        onCopySourcedMarkdown: async target => {
            const snippet = createEvidenceSnippet({
                markdown: model.markdown,
                sourceMap: model.sourceMap,
                target,
            });
            const markdown = formatEvidenceMarkdown(snippet, {
                title: PAPER_TITLE,
                pages: snippet.pageIndexes.map(pageIndex => ({
                    pageIndex,
                    pageNumber: pageIndex + 1,
                    href: `zotero://open-pdf/library/items/${ITEM_KEY}?page=${pageIndex + 1}`,
                })),
            }, localization.t.bind(localization));
            if (!await writeClipboard(markdown)) throw new Error('Clipboard is unavailable');
        },
        onTranslateSelection: translateSelection,
        onCancelSelectionTranslation: () => {
            for (const timer of selectionTimers) window.clearTimeout(timer);
            selectionTimers = [];
        },
        shouldAutoTranslateSelection: () => false,
        onReadingPositionChange: () => {},
    };

    shell = createPreviewShell({
        document,
        root: document.getElementById('preview-root'),
        language,
        localization,
        paper: {
            title: PAPER_TITLE,
            shortTitle: PAPER_SHORT_TITLE,
            creators: PAPER_CREATORS,
            year: PAPER_YEAR,
        },
        pages,
        segments,
        getAnnotations: pdfAnnotations,
        figureImage,
    });

    view = createMarkdownTabView({
        document,
        model,
        zotero: {
            launchURL(url) {
                if (/^https?:\/\//i.test(String(url))) window.open(url, '_blank', 'noopener,noreferrer');
            },
            logError: error => capture.logError(error),
            debug: () => {},
        },
        localization,
        // The preview has no Zotero library, so it has no notes column. It
        // opens on the annotations segment to show the sample highlights.
        panelLayout: { outlineSegment: 'annotations' },
    });
    if (forceLight) {
        const styles = view.host.shadowRoot.querySelector('style[data-mktero-styles]');
        if (styles) styles.textContent = lightOnlyStyles(styles.textContent);
    }
    shell.readerPane.appendChild(view.root);
    shell.activate(initialTab);
    view.render(model);

    const selfTest = createSelfTest({
        window,
        view,
        shell,
        model: () => model,
        markdown: PAPER_MARKDOWN,
        capture,
    });
    Object.assign(window.__mkteroPreview, {
        view,
        shell,
        get model() {
            return model;
        },
        pages,
        sourceMap,
        selfTest,
        report: () => ({
            userAgent: navigator.userAgent,
            errors: [...capture.errors],
            warnings: [...capture.warnings],
        }),
    });
    resolveReady(true);
    postReady(window);
    if (params.get('diagnostics') === '1') {
        const report = await selfTest();
        renderDiagnosticsPanel(document, report);
        // The title is readable from the window list when automation is off.
        const failed = report.results.filter(result => !result.passed)
            .map(result => `${result.name}(${result.error.slice(0, 70)})`);
        const passed = report.results.length - failed.length;
        document.title = `${report.passed ? 'PASS' : 'FAIL'} ${passed}/${report.results.length}`
            + (failed.length ? ` ${failed.join(',')}` : '')
            + (report.errors.length ? ` errors=${report.errors.length}: ${report.errors[0].message.slice(0, 80)}` : '');
    }
}

function createMemoryRevisionStore() {
    const records = new Map();
    return {
        load: async key => records.get(key) || null,
        save: async (key, value) => {
            records.set(key, value);
        },
        delete: async key => {
            records.delete(key);
        },
    };
}

// The decoded image stays referenced by the PDF pane for the page lifetime,
// so its object URL is not revoked.
async function decodeImage(data) {
    const image = new Image();
    image.src = URL.createObjectURL(new Blob([data], { type: 'image/png' }));
    await image.decode();
    return image;
}

// The translated plain text of the block a reader selection falls in.
function translatedTextFor(model, selectedText) {
    const probe = selectedText.slice(0, 40);
    if (!probe) return '';
    const block = model.restoredTranslation.blocks.find(candidate => (
        candidate.translatable && inlineText(candidate.markdown).includes(probe)
    ));
    const range = block && model.translationBlockRanges.find(entry => entry.id === block.id);
    return range
        ? inlineText(model.translatedMarkdown.slice(range.translatedFrom, range.translatedTo))
        : '';
}
