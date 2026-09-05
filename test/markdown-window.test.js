import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createLocalization } from '../src/i18n/localization.js';
import { createMarkdownTabView } from '../src/ui/markdown-window.js';
import { createEvidenceSnippet } from '../src/markdown/markdown-evidence.js';
import { selectExportMarkdown } from '../src/markdown/export-markdown-selector.js';

const MARKDOWN_STYLES = readFileSync(
    new URL('../ui/markdown.css', import.meta.url),
    'utf8'
);

function createModel(changes = {}) {
    return {
        itemID: 42,
        title: 'Converting PDF…',
        status: 'loading',
        progress: 0,
        markdown: '',
        assets: [],
        assetBasePath: '',
        sourceKind: null,
        cacheHit: false,
        cacheKey: null,
        sourceMap: [],
        annotationOverlay: { matched: [], unmatched: [] },
        preserveContent: false,
        warnings: [],
        error: '',
        errorAction: null,
        warningAction: null,
        onReparse: null,
        onOpenSettings: null,
        ...changes,
    };
}

function createView(model = createModel(), zotero = {}, options = {}) {
    const { document } = parseHTML('<html><body></body></html>');
    if (options.xul) {
        document.createXULElement = tagName => {
            options.xulCalls?.push(tagName);
            const element = document.createElement(tagName);
            element.setAttribute('data-test-xul-element', 'true');
            return element;
        };
    }
    options.configureWindow?.(document.defaultView);
    const view = createMarkdownTabView({
        document,
        rootURI: 'jar:file:///profile/extensions/mktero.xpi!/',
        model,
        zotero,
        stylesheetText: options.stylesheetText ?? MARKDOWN_STYLES,
        editorFactory: options.editorFactory ?? createTestInlineEditor,
        localization: options.localization,
        readerFont: options.readerFont,
        readerFontSize: options.readerFontSize,
        onReaderFontChange: options.onReaderFontChange,
        onReaderFontSizeChange: options.onReaderFontSizeChange,
    });
    view.render(model);
    return { document, view, shadow: view.host.shadowRoot };
}

function createTestInlineEditor({ document, parent, initialMarkdown }) {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const scroller = document.createElement('div');
    scroller.className = 'cm-scroller';
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.setAttribute('contenteditable', 'false');
    content.textContent = initialMarkdown;
    scroller.appendChild(content);
    editor.appendChild(scroller);
    parent.appendChild(editor);
    return {
        getMarkdown: () => content.textContent,
        setMarkdown(markdown) {
            content.textContent = markdown;
        },
        setDocument({ markdown }) {
            content.textContent = markdown;
        },
        focus: () => content.focus(),
        refreshRendering: () => {},
        destroy: () => editor.remove(),
    };
}

function dispatchMouseEvent(target, type, clientX, clientY = 0, buttons) {
    const ownerWindow = target.ownerDocument?.defaultView || target;
    const event = new ownerWindow.Event(type, {
        bubbles: true,
        cancelable: true,
    });
    Object.defineProperties(event, {
        button: { value: 0 },
        clientX: { value: clientX },
        clientY: { value: clientY },
    });
    if (buttons !== undefined) {
        Object.defineProperty(event, 'buttons', { value: buttons });
    }
    target.dispatchEvent(event);
}

function dispatchKeyboardEvent(target, key) {
    const event = new target.ownerDocument.defaultView.Event('keydown', {
        bubbles: true,
        cancelable: true,
    });
    Object.defineProperty(event, 'key', { value: key });
    target.dispatchEvent(event);
}

function dispatchWindowKeyboardEvent(window, key) {
    const event = new window.Event('keydown', {
        bubbles: true,
        cancelable: true,
    });
    Object.defineProperty(event, 'key', { value: key });
    window.dispatchEvent(event);
}

test('shows Markdown without editing controls', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nEditable.',
        sourceKind: 'markdown',
    }));

    try {
        assert.ok(shadow.querySelector('#mktero-editor .cm-editor'));
        assert.equal(
            shadow.querySelector('.cm-content').textContent,
            '# Paper\n\nEditable.'
        );
        assert.equal(shadow.querySelector('#mktero-show-preview'), null);
        assert.equal(shadow.querySelector('#mktero-show-source'), null);
        assert.equal(shadow.querySelector('#mktero-preview'), null);
        assert.equal(shadow.querySelector('#mktero-source'), null);
        assert.ok(!shadow.querySelector('.app-header'));
        assert.ok(!shadow.querySelector('#mktero-editor-toolbar'));
        assert.ok(!shadow.querySelector('#mktero-save'));
    }
    finally {
        view.destroy();
    }
});

test('shows the current-paper citation graph button in the reader', async () => {
    const opened = [];
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        onOpenCitationGraph: itemID => opened.push(itemID),
    }));

    try {
        const button = shadow.querySelector('#mktero-citation-graph');
        assert.equal(button.hidden, false);
        assert.equal(
            button.querySelector('[data-lucide]').dataset.lucide,
            'network'
        );
        button.click();
        await Promise.resolve();
        assert.deepEqual(opened, [42]);
    }
    finally {
        view.destroy();
    }
});

test('passes reference library callbacks and the current source item to the editor', async () => {
    const calls = [];
    const callbacks = {
        onListReferenceLibraries(options) {
            calls.push(['libraries', options]);
            return { libraries: [], defaultLibraryID: 1 };
        },
        onGetReferenceStatus(reference, options) {
            calls.push(['status', reference, options]);
            return { state: 'unknown' };
        },
        onSearchReferenceMetadata(reference, options) {
            calls.push(['search', reference, options]);
            return { status: 'unresolved', candidates: [] };
        },
        onImportReference(reference, options) {
            calls.push(['import', reference, options]);
            return { state: 'failed' };
        },
        onOpenReferenceMatch(match) {
            calls.push(['open', match]);
            return match.itemID;
        },
        onSubscribeReferenceUpdates(listener) {
            calls.push(['subscribe', listener]);
            return () => {};
        },
    };
    let editorOptions;
    const { view } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        sourceItemID: 42,
        ...callbacks,
    }), {}, {
        editorFactory(options) {
            editorOptions = options;
            return createTestInlineEditor(options);
        },
    });

    try {
        const signal = new AbortController().signal;
        await editorOptions.onListReferenceLibraries({ signal });
        await editorOptions.onGetReferenceStatus({ id: 'r' }, { signal });
        await editorOptions.onSearchReferenceMetadata({ id: 'r' }, { signal });
        await editorOptions.onImportReference({ id: 'r' }, { signal });
        await editorOptions.onOpenReferenceMatch({ itemID: 7 });
        editorOptions.onSubscribeReferenceUpdates(() => {});
        assert.equal(calls[0][0], 'libraries');
        assert.equal(calls[0][1].sourceItemID, 42);
        assert.equal(calls[1][0], 'status');
        assert.equal(calls[2][0], 'search');
        assert.equal(calls[3][0], 'import');
        assert.equal(calls[4][0], 'open');
        assert.equal(calls[5][0], 'subscribe');
    }
    finally {
        view.destroy();
    }
});

test('toggles block correction mode and restores all saved corrections', async () => {
    const modeChanges = [];
    const editorStates = [];
    let restoreCalls = 0;
    const markdown = '# Paper\n\nThe sample included 5O people.';
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown,
        sourceKind: 'markdown',
        editableBlocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: markdown.indexOf('The sample'),
            to: markdown.length,
        }],
        correctedBlockIDs: ['paragraph-1'],
        correctionCount: 1,
        hasCorrections: true,
        correctionMode: false,
        onSetCorrectionMode: enabled => modeChanges.push(enabled),
        onCommitCorrection: async () => {},
        onRestoreCorrection: async () => {},
        onRestoreAllCorrections: async () => { restoreCalls++; },
    });
    const { view, shadow } = createView(model, {}, {
        editorFactory() {
            return {
                setDocument() {},
                setCorrectionState(state) {
                    editorStates.push(state);
                },
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    const toggle = shadow.querySelector('#mktero-correction-toggle');
    const restoreAll = shadow.querySelector('#mktero-restore-corrections');
    assert.equal(toggle.hidden, false);
    assert.match(toggle.textContent, /Manage corrections/);
    assert.equal(restoreAll.hidden, false);
    assert.equal(
        shadow.querySelector('.markdown-correction-banner').hidden,
        true
    );

    toggle.click();
    assert.deepEqual(modeChanges, [true]);
    view.render({ ...model, correctionMode: true });
    assert.equal(editorStates.at(-1).enabled, true);
    assert.match(toggle.textContent, /Finish correction/);
    assert.match(
        shadow.querySelector('.markdown-correction-banner').textContent,
        /double-click text or a table cell/i
    );

    restoreAll.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restoreCalls, 0);
    const confirmation = shadow.querySelector('.mktero-confirmation-dialog');
    assert.equal(
        confirmation.querySelector('.mktero-confirmation-title').textContent,
        'Restore all corrections?'
    );
    assert.equal(
        confirmation.querySelector('.mktero-confirmation-message').textContent,
        'Restore all 1 corrections to the original recognition result?'
    );
    confirmation.querySelector('[data-confirmation-action="confirm"]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(restoreCalls, 1);

    view.destroy();
});

test('adds matched annotation ranges to correction protection state', () => {
    const markdown = 'Editable before protected text and after.';
    const protectedFrom = markdown.indexOf('protected text');
    const editorStates = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown,
        sourceKind: 'markdown',
        correctionMode: true,
        editableBlocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: 0,
            to: markdown.length,
            markdown,
        }],
        annotationOverlay: {
            matched: [{
                id: 'mktero-local-1',
                source: 'markdown',
                ranges: [{
                    from: protectedFrom,
                    to: protectedFrom + 'protected text'.length,
                }],
            }],
            unmatched: [],
        },
    });
    const { view } = createView(model, {}, {
        editorFactory() {
            return {
                setDocument() {},
                setCorrectionState(state) {
                    editorStates.push(state);
                },
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    assert.deepEqual(editorStates.at(-1).annotationRanges, [{
        id: 'mktero-local-1',
        source: 'markdown',
        rangeIndex: 0,
        from: protectedFrom,
        to: protectedFrom + 'protected text'.length,
    }]);
    assert.deepEqual(editorStates.at(-1).blocks[0].protectedRanges, [{
        from: protectedFrom,
        to: protectedFrom + 'protected text'.length,
        kind: 'annotation',
    }]);

    view.destroy();
});

test('translates the document and switches between three reading modes', async () => {
    const actions = [];
    const editors = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nTranslate this paragraph.',
        sourceKind: 'markdown',
        translationStatus: 'none',
        translationView: 'original',
        onTranslateDocument: options => actions.push(
            options?.forceRetranslate ? 'retranslate-all' : 'translate'
        ),
        onCancelDocumentTranslation: () => actions.push('cancel'),
        onSetTranslationView: view => actions.push(view),
    });
    const { view, shadow } = createView(model, {}, {
        editorFactory(options) {
            const editor = {
                parent: options.parent,
                renderedDocuments: [],
                destroyed: false,
                setDocument(document) {
                    this.renderedDocuments.push(document);
                },
                setCorrectionState() {},
                refreshRendering() {},
                destroy() {
                    this.destroyed = true;
                },
            };
            editors.push(editor);
            return editor;
        },
    });

    try {
        const controls = shadow.querySelector('.markdown-translation-controls');
        const translate = shadow.querySelector('#mktero-translate-document');
        const selector = shadow.querySelector('#mktero-translation-view');
        const status = shadow.querySelector('.markdown-translation-status');
        const failureNavigation = shadow.querySelector(
            '.markdown-translation-failure-navigation'
        );
        const retranslateDocument = shadow.querySelector(
            '#mktero-retranslate-document'
        );
        const failurePosition = shadow.querySelector(
            '.markdown-translation-failure-position'
        );
        const originalMode = shadow.querySelector(
            '[data-translation-view="original"]'
        );
        const translatedMode = shadow.querySelector(
            '[data-translation-view="translated"]'
        );
        const compareMode = shadow.querySelector(
            '[data-translation-view="compare"]'
        );
        assert.equal(controls.hidden, false);
        assert.equal(translate.hidden, false);
        assert.equal(translate.textContent, 'Translate document');
        assert.equal(
            translate.querySelector('.markdown-translation-idle-icon')
                ?.hasAttribute('hidden'),
            false
        );
        assert.equal(
            translate.querySelector('.markdown-translation-loading-icon')
                ?.hasAttribute('hidden'),
            true
        );
        assert.equal(translate.classList.contains('is-translating'), false);
        assert.equal(translate.getAttribute('aria-busy'), 'false');
        assert.equal(translate.getAttribute('aria-label'), 'Translate document');
        assert.equal(translate.getAttribute('title'), 'Translate document');
        assert.equal(
            translate.querySelector('svg')?.getAttribute('data-lucide'),
            'languages'
        );
        assert.equal(selector.hidden, true);
        assert.equal(status.hidden, true);
        assert.equal(
            shadow.querySelector('.markdown-translation-language'),
            null
        );
        assert.equal(retranslateDocument.hidden, true);
        assert.equal(selector.getAttribute('role'), 'radiogroup');
        assert.equal(originalMode.getAttribute('role'), 'radio');
        assert.equal(originalMode.getAttribute('aria-checked'), 'true');
        assert.equal(translatedMode.getAttribute('aria-checked'), 'false');
        assert.equal(compareMode.getAttribute('aria-checked'), 'false');
        assert.equal(originalMode.disabled, true);
        assert.equal(translatedMode.disabled, true);
        assert.equal(compareMode.disabled, true);

        translate.click();
        assert.deepEqual(actions, ['translate']);

        view.render({
            ...model,
            translationStatus: 'loading',
            translationProgress: 37,
            translationCompletedBlocks: 42,
            translationTotalBlocks: 113,
            translationStage: 'reasoning',
            translationRequestedTargetLanguage: 'ja-JP',
        });
        assert.equal(translate.disabled, false);
        assert.equal(translate.getAttribute('aria-busy'), 'true');
        assert.equal(
            translate.getAttribute('aria-label'),
            'Cancel translation (model is reasoning…)'
        );
        assert.equal(
            translate.querySelector('.markdown-translation-action-label')
                ?.textContent,
            'Cancel'
        );
        assert.equal(translate.classList.contains('is-translating'), true);
        assert.equal(
            shadow.querySelector('.markdown-reader-toolbar')
                ?.classList.contains('is-translating'),
            true
        );
        assert.equal(
            translate.querySelector('.markdown-translation-idle-icon')
                ?.hasAttribute('hidden'),
            true
        );
        const loadingIcon = translate.querySelector(
            '.markdown-translation-loading-icon'
        );
        assert.equal(loadingIcon?.hasAttribute('hidden'), false);
        assert.equal(loadingIcon?.getAttribute('data-lucide'), 'loader-circle');
        assert.equal(status.hidden, false);
        assert.equal(
            status.textContent,
            'Japanese · 42/113 · 37%'
        );
        assert.equal(selector.hidden, true);

        translate.click();
        assert.deepEqual(actions, ['translate', 'cancel']);

        const translatedModel = {
            ...model,
            translationStatus: 'ready',
            translationCompletedBlocks: 2,
            translationTotalBlocks: 2,
            translationTargetLanguage: 'zh-CN',
            translationBlocks: [{
                id: 'translation-0-0-7-heading',
                markdown: '# 论文',
            }, {
                id: 'translation-1-9-34-paragraph',
                markdown: '翻译这一段。',
            }],
            translatedMarkdown: '# 论文\n\n翻译这一段。',
            comparisonMarkdown: [
                '# Paper',
                '',
                '# 论文',
                '',
                'Translate this paragraph.',
                '',
                '翻译这一段。',
            ].join('\n'),
            comparisonSourceRanges: [{
                sourceFrom: 0,
                sourceTo: 7,
                comparisonFrom: 0,
            }, {
                sourceFrom: 9,
                sourceTo: 34,
                comparisonFrom: 15,
            }],
            comparisonTranslationRanges: [{ from: 9, to: 13 }, {
                from: 42,
                to: 48,
            }],
            translationBlockRanges: [{
                id: 'translation-0-0-7-heading',
                type: 'heading',
                sourceFrom: 0,
                sourceTo: 7,
                translatedFrom: 0,
                translatedTo: 4,
                comparisonSourceFrom: 0,
                comparisonSourceTo: 7,
                comparisonTranslationFrom: 9,
                comparisonTranslationTo: 13,
            }, {
                id: 'translation-1-9-34-paragraph',
                type: 'paragraph',
                sourceFrom: 9,
                sourceTo: 34,
                translatedFrom: 6,
                translatedTo: 12,
                comparisonSourceFrom: 15,
                comparisonSourceTo: 40,
                comparisonTranslationFrom: 42,
                comparisonTranslationTo: 48,
            }],
        };
        view.render(translatedModel);
        assert.equal(
            shadow.querySelector('.markdown-reader-toolbar')
                ?.classList.contains('is-translating'),
            false
        );
        assert.equal(translate.hidden, true);
        assert.equal(translate.getAttribute('aria-label'), 'Translated');
        assert.equal(translate.getAttribute('title'), 'Translated');
        assert.equal(selector.hidden, false);
        assert.equal(status.hidden, true);
        assert.equal(status.textContent, '');
        assert.equal(translatedMode.textContent, 'Simplified Chinese');
        assert.equal(
            translatedMode.getAttribute('aria-label'),
            'Translation: Simplified Chinese'
        );
        assert.equal(
            translatedMode.getAttribute('title'),
            'Translation: Simplified Chinese'
        );
        assert.equal(retranslateDocument.hidden, false);
        assert.equal(originalMode.disabled, false);
        assert.equal(translatedMode.disabled, false);
        assert.equal(compareMode.disabled, false);

        view.render({
            ...translatedModel,
            translationView: 'translated',
            translationConfiguredTargetLanguage: 'ja-JP',
        });
        assert.equal(translate.hidden, true);
        assert.equal(translate.getAttribute('aria-label'), 'Translate document');
        assert.equal(selector.hidden, false);
        assert.equal(translatedMode.textContent, 'Simplified Chinese');
        assert.equal(
            editors[0].renderedDocuments.at(-1).markdown,
            '# \u8bba\u6587\n\n\u7ffb\u8bd1\u8fd9\u4e00\u6bb5\u3002'
        );

        view.render({
            ...translatedModel,
            translationTargetLanguage: 'pt-BR',
        });
        assert.equal(translatedMode.textContent, 'Portuguese (Brazil)');
        assert.equal(
            translatedMode.getAttribute('title'),
            'Translation: Portuguese (Brazil)'
        );

        translatedMode.click();
        assert.deepEqual(actions, ['translate', 'cancel', 'translated']);

        view.render({ ...translatedModel, translationView: 'translated' });
        assert.equal(originalMode.getAttribute('aria-checked'), 'false');
        assert.equal(translatedMode.getAttribute('aria-checked'), 'true');
        assert.equal(compareMode.getAttribute('aria-checked'), 'false');
        assert.equal(originalMode.getAttribute('tabindex'), '-1');
        assert.equal(translatedMode.getAttribute('tabindex'), '0');
        assert.equal(compareMode.getAttribute('tabindex'), '-1');
        assert.equal(
            shadow.querySelector('[data-comparison-pane="original"]')
                .getAttribute('aria-label'),
            'Translation'
        );
        assert.equal(
            shadow.querySelector('[data-comparison-pane="original"]')
                .getAttribute('lang'),
            'zh-CN'
        );
        assert.equal(
            editors[0].renderedDocuments.at(-1).markdown,
            '# 论文\n\n翻译这一段。'
        );
        assert.deepEqual(editors[0].renderedDocuments.at(-1).sourceMap, []);
        assert.deepEqual(editors[0].renderedDocuments.at(-1).annotationOverlay, {
            matched: [],
            unmatched: [],
        });

        compareMode.click();
        assert.deepEqual(actions, [
            'translate',
            'cancel',
            'translated',
            'compare',
        ]);
        view.render({ ...translatedModel, translationView: 'compare' });
        const readingLayout = shadow.querySelector('.markdown-reading-layout');
        const originalPane = shadow.querySelector(
            '[data-comparison-pane="original"]'
        );
        assert.equal(readingLayout.classList.contains('is-comparing'), true);
        assert.equal(originalPane.getAttribute('aria-label'), 'Bilingual');
        assert.equal(originalPane.hasAttribute('lang'), false);
        assert.equal(editors.length, 1);
        assert.equal(
            editors[0].renderedDocuments.at(-1).markdown,
            translatedModel.comparisonMarkdown
        );
        assert.deepEqual(
            editors[0].renderedDocuments.at(-1).sourceMap,
            []
        );
        assert.deepEqual(
            editors[0].renderedDocuments.at(-1).translationRanges,
            translatedModel.comparisonTranslationRanges.map(range => ({
                ...range,
                language: 'zh-CN',
            }))
        );
        assert.deepEqual(
            editors[0].renderedDocuments.at(-1).translationPairs,
            translatedModel.translationBlockRanges.map(range => ({
                id: range.id,
                sourceFrom: range.comparisonSourceFrom,
                sourceTo: range.comparisonSourceTo,
                translatedFrom: range.comparisonTranslationFrom,
                translatedTo: range.comparisonTranslationTo,
            }))
        );
        assert.deepEqual(
            [...shadow.querySelectorAll('.markdown-outline-link')]
                .map(link => link.textContent),
            ['Paper']
        );

        view.render({
            ...translatedModel,
            translationStatus: 'partial',
            translationView: 'compare',
            translationCompletedBlocks: 1,
            translationFailedBlocks: [{
                id: 'translation-1-9-34-paragraph',
            }],
        });
        assert.equal(translate.hidden, false);
        assert.equal(translate.disabled, false);
        assert.equal(
            translate.getAttribute('aria-label'),
            'Retry incomplete translation'
        );
        assert.equal(originalMode.disabled, false);
        assert.equal(translatedMode.disabled, false);
        assert.equal(compareMode.disabled, false);
        assert.equal(status.textContent, '1 untranslated');
        assert.equal(failureNavigation.hidden, false);
        assert.equal(failurePosition.textContent, '1/1');
        assert.equal(
            failurePosition.getAttribute('aria-label'),
            'Untranslated block 1 of 1'
        );
        assert.equal(
            failureNavigation.querySelectorAll('button').length,
            2
        );
        assert.equal(
            editors[0].renderedDocuments.at(-1).markdown,
            translatedModel.comparisonMarkdown
        );
        assert.deepEqual(
            editors[0].renderedDocuments.at(-1).translationFailures,
            [{
                id: 'translation-1-9-34-paragraph',
                from: 15,
                to: 40,
            }]
        );
        assert.deepEqual(
            editors[0].renderedDocuments.at(-1).translationPairs,
            [{
                id: 'translation-0-0-7-heading',
                sourceFrom: 0,
                sourceTo: 7,
                translatedFrom: 9,
                translatedTo: 13,
            }, {
                id: 'translation-1-9-34-paragraph',
                sourceFrom: 15,
                sourceTo: 40,
                translatedFrom: 42,
                translatedTo: 48,
            }]
        );

        shadow.querySelector('#mktero-document-actions').click();
        retranslateDocument.click();
        assert.deepEqual(actions, [
            'translate',
            'cancel',
            'translated',
            'compare',
            'retranslate-all',
        ]);

        originalMode.click();
        view.render({ ...translatedModel, translationView: 'original' });
        assert.equal(readingLayout.classList.contains('is-comparing'), false);
        assert.equal(
            editors[0].renderedDocuments.at(-1).markdown,
            '# Paper\n\nTranslate this paragraph.'
        );
        assert.deepEqual(
            editors[0].renderedDocuments.at(-1).translationRanges,
            []
        );

        view.render({ ...model, onTranslateDocument: undefined });
        assert.equal(controls.hidden, true);
    }
    finally {
        view.destroy();
        assert.equal(editors.length, 1);
        assert.equal(editors.every(editor => editor.destroyed), true);
    }
});

test('chooses translated, incomplete, and new languages from the translated tab', () => {
    const selectedLanguages = [];
    const canceledTranslations = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        translationStatus: 'ready',
        translationView: 'original',
        translationTargetLanguage: 'zh-CN',
        translationCachedLanguages: [
            'zh-CN',
            'ja-JP',
            'unsupported',
            'ja-JP',
        ],
        translationPartialLanguages: ['fr-FR', 'unsupported'],
        translationBlocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# \u8bba\u6587',
        }],
        translatedMarkdown: '# \u8bba\u6587',
        comparisonMarkdown: '# Paper\n\n# \u8bba\u6587',
        onTranslateDocument: () => {},
        onCancelDocumentTranslation: () => {
            canceledTranslations.push('cancel');
        },
        onSetTranslationView: () => {},
        onSelectTranslationLanguage: language => {
            selectedLanguages.push(language);
        },
    });
    const first = createView(model);
    const second = createView(model);
    const trigger = first.shadow.querySelector(
        '[data-translation-view="translated"]'
    );
    const menu = first.shadow.querySelector(
        '#mktero-translation-language-options'
    );
    const options = () => [...menu.querySelectorAll(
        '[data-translation-language]'
    )];

    try {
        let focused = '';
        trigger.focus = () => { focused = 'trigger'; };
        for (const option of options()) {
            const language = option.getAttribute('data-translation-language');
            option.focus = () => { focused = language; };
        }
        assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(
            trigger.querySelector('[data-lucide="chevron-down"]')?.hidden,
            false
        );
        assert.equal(menu.hidden, true);

        trigger.click();
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(menu.hidden, false);
        assert.deepEqual([...menu.querySelectorAll(
            '.markdown-translation-language-group-label'
        )].map(label => label.textContent), ['Translated', 'Translate to']);
        assert.deepEqual(options().map(option => ({
            language: option.getAttribute('data-translation-language'),
            label: option.textContent.trim(),
            status: option.getAttribute('data-translation-status'),
            selected: option.getAttribute('aria-checked'),
        })), [{
            language: 'zh-CN',
            label: 'Simplified Chinese',
            status: 'complete',
            selected: 'true',
        }, {
            language: 'ja-JP',
            label: 'Japanese',
            status: 'complete',
            selected: 'false',
        }, {
            language: 'zh-TW',
            label: 'Traditional Chinese',
            status: 'missing',
            selected: 'false',
        }, {
            language: 'ko-KR',
            label: 'Korean',
            status: 'missing',
            selected: 'false',
        }, {
            language: 'es-ES',
            label: 'Spanish',
            status: 'missing',
            selected: 'false',
        }, {
            language: 'fr-FR',
            label: 'French',
            status: 'partial',
            selected: 'false',
        }, {
            language: 'pt-BR',
            label: 'Portuguese (Brazil)',
            status: 'missing',
            selected: 'false',
        }]);
        assert.equal(
            second.shadow.querySelector('#mktero-translation-language-options')
                .hidden,
            true
        );

        options()[1].click();
        assert.deepEqual(selectedLanguages, ['ja-JP']);
        assert.equal(menu.hidden, true);
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');

        dispatchKeyboardEvent(trigger, 'ArrowDown');
        assert.equal(menu.hidden, false);
        assert.equal(focused, 'zh-CN');
        dispatchKeyboardEvent(options()[0], 'ArrowDown');
        assert.equal(focused, 'ja-JP');
        dispatchKeyboardEvent(options()[1], 'Escape');
        assert.equal(menu.hidden, true);
        assert.equal(focused, 'trigger');

        trigger.click();
        const outside = first.document.createElement('div');
        first.document.body.appendChild(outside);
        outside.dispatchEvent(new first.document.defaultView.Event('mousedown', {
            bubbles: true,
        }));
        assert.equal(menu.hidden, true);

        first.view.render({
            ...model,
            translationStatus: 'loading',
            translationRequestedTargetLanguage: 'ko-KR',
            translationCachedLanguages: [],
        });
        assert.equal(
            first.shadow.querySelector('#mktero-translate-document').hidden,
            true
        );
        assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
        trigger.click();
        assert.equal(menu.hidden, false);
        assert.equal(
            options()[0].getAttribute('data-translation-status'),
            'complete'
        );
        assert.equal(options().every(option => option.disabled), true);
        const cancel = menu.querySelector(
            '#mktero-cancel-translation-language'
        );
        assert.equal(cancel.hidden, false);
        cancel.click();
        assert.deepEqual(canceledTranslations, ['cancel']);
        assert.equal(menu.hidden, true);
    }
    finally {
        first.view.destroy();
        second.view.destroy();
    }
});

test('cycles translated reading modes with arrow keys and roving focus', () => {
    const modes = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Original.',
        sourceKind: 'markdown',
        translationStatus: 'ready',
        translationView: 'original',
        translationBlocks: [{ id: 'translation-0' }],
        translatedMarkdown: 'Translation.',
        comparisonMarkdown: 'Original.\n\nTranslation.',
        translationBlockRanges: [{
            id: 'translation-0',
            sourceFrom: 0,
            sourceTo: 9,
            translatedFrom: 0,
            translatedTo: 12,
            comparisonSourceFrom: 0,
            comparisonSourceTo: 9,
            comparisonTranslationFrom: 11,
            comparisonTranslationTo: 23,
        }],
        onTranslateDocument: () => {},
        onSetTranslationView: mode => modes.push(mode),
    });
    const { view, shadow } = createView(model);
    const original = shadow.querySelector(
        '[data-translation-view="original"]'
    );
    const translated = shadow.querySelector(
        '[data-translation-view="translated"]'
    );
    const compare = shadow.querySelector(
        '[data-translation-view="compare"]'
    );
    let focused = null;
    for (const button of [original, translated, compare]) {
        button.focus = () => { focused = button; };
    }

    try {
        dispatchKeyboardEvent(original, 'ArrowRight');
        assert.deepEqual(modes, ['translated']);
        assert.equal(focused, translated);

        view.render({ ...model, translationView: 'translated' });
        assert.equal(original.getAttribute('tabindex'), '-1');
        assert.equal(translated.getAttribute('tabindex'), '0');
        dispatchKeyboardEvent(translated, 'ArrowDown');
        assert.deepEqual(modes, ['translated', 'compare']);
        assert.equal(focused, compare);

        view.render({ ...model, translationView: 'compare' });
        dispatchKeyboardEvent(compare, 'ArrowRight');
        assert.deepEqual(modes, ['translated', 'compare', 'original']);
        assert.equal(focused, original);

        dispatchKeyboardEvent(compare, 'ArrowLeft');
        assert.deepEqual(modes, [
            'translated',
            'compare',
            'original',
            'translated',
        ]);
    }
    finally {
        view.destroy();
    }
});

test('navigates failed translation blocks with wraparound', () => {
    const scrolledOffsets = [];
    const highlightedBlocks = [];
    let editorOptions;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'First.\n\nSecond.\n\nThird.',
        sourceKind: 'markdown',
        translationStatus: 'partial',
        translationView: 'compare',
        translationCompletedBlocks: 1,
        translationTotalBlocks: 3,
        translationTargetLanguage: 'zh-CN',
        translationBlocks: [{ id: 'first' }, { id: 'second' }, { id: 'third' }],
        translationFailedBlocks: [{ id: 'first' }, { id: 'third' }],
        translatedMarkdown: 'First.\n\n第二。\n\nThird.',
        comparisonMarkdown: 'First.\n\nFirst.\n\nSecond.\n\n第二。\n\nThird.\n\nThird.',
        comparisonTranslationRanges: [{ from: 23, to: 26 }],
        translationBlockRanges: [{
            id: 'first',
            sourceFrom: 0,
            sourceTo: 6,
            translatedFrom: 0,
            translatedTo: 6,
            comparisonSourceFrom: 0,
            comparisonSourceTo: 6,
            comparisonTranslationFrom: 8,
            comparisonTranslationTo: 14,
        }, {
            id: 'second',
            sourceFrom: 8,
            sourceTo: 15,
            translatedFrom: 8,
            translatedTo: 11,
            comparisonSourceFrom: 16,
            comparisonSourceTo: 23,
            comparisonTranslationFrom: 25,
            comparisonTranslationTo: 28,
        }, {
            id: 'third',
            sourceFrom: 17,
            sourceTo: 23,
            translatedFrom: 13,
            translatedTo: 19,
            comparisonSourceFrom: 30,
            comparisonSourceTo: 36,
            comparisonTranslationFrom: 38,
            comparisonTranslationTo: 44,
        }],
        onTranslateDocument: () => {},
        onSetTranslationView: () => {},
    });
    const { view, shadow } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            const editor = createTestInlineEditor(options);
            editor.scrollToOffset = offset => scrolledOffsets.push(offset);
            editor.highlightTranslationBlock = blockID => (
                highlightedBlocks.push(blockID)
            );
            return editor;
        },
    });
    const previous = shadow.querySelector(
        '[aria-label="Previous untranslated block"]'
    );
    const next = shadow.querySelector(
        '[aria-label="Next untranslated block"]'
    );
    const position = shadow.querySelector(
        '.markdown-translation-failure-position'
    );

    try {
        assert.equal(position.textContent, '1/2');
        next.click();
        assert.equal(position.textContent, '2/2');
        next.click();
        assert.equal(position.textContent, '1/2');
        previous.click();
        assert.equal(position.textContent, '2/2');
        previous.click();
        assert.equal(position.textContent, '1/2');
        assert.deepEqual(scrolledOffsets, [30, 0, 30, 0]);
        assert.deepEqual(highlightedBlocks, ['third', 'first', 'third', 'first']);

        editorOptions.onViewportChange(20);
        next.click();
        previous.click();
        assert.deepEqual(scrolledOffsets.slice(-2), [30, 0]);
    }
    finally {
        view.destroy();
    }
});

test('only exposes selection translation callbacks when the model provides them', () => {
    let editorOptions;
    const { view } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Paper text.',
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            editorOptions = options;
            return createTestInlineEditor(options);
        },
    });

    try {
        assert.equal(editorOptions.translateSelection, null);
        assert.equal(editorOptions.cancelSelectionTranslation, null);
        assert.equal(editorOptions.shouldAutoTranslateSelection, null);
        assert.equal(editorOptions.copySelectionTranslation, null);
    }
    finally {
        view.destroy();
    }
});

test('keeps a partial translation readable while retrying the document', () => {
    const updates = [];
    let editorOptions;
    const block = {
        id: 'translation-0',
        sourceFrom: 0,
        sourceTo: 9,
        translatedFrom: 0,
        translatedTo: 9,
        comparisonSourceFrom: 0,
        comparisonSourceTo: 9,
        comparisonTranslationFrom: 11,
        comparisonTranslationTo: 20,
    };
    const partialModel = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Fallback.',
        sourceKind: 'markdown',
        translationStatus: 'partial',
        translationView: 'translated',
        translationCompletedBlocks: 0,
        translationTotalBlocks: 1,
        translationTargetLanguage: 'zh-CN',
        translationBlocks: [{ id: block.id }],
        translationFailedBlocks: [{ id: block.id }],
        translationBlockRanges: [block],
        translatedMarkdown: 'Fallback.',
        comparisonMarkdown: 'Fallback.\n\nFallback.',
        onTranslateDocument: () => {},
        onCancelDocumentTranslation: () => {},
        onSetTranslationView: () => {},
    });
    const { view, shadow } = createView(partialModel, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument(document) {
                    updates.push(document);
                },
                setCorrectionState() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    try {
        assert.equal(editorOptions.retryTranslationBlock, undefined);

        view.render({
            ...partialModel,
            translationStatus: 'loading',
            translationProgress: 0,
            translationStage: 'requesting',
            translationRequestedTargetLanguage: 'ja-JP',
        });
        assert.equal(updates.at(-1).markdown, 'Fallback.');
        assert.equal(
            shadow.querySelector('[data-translation-view="translated"]')
                .textContent,
            'Simplified Chinese'
        );
        assert.equal(
            shadow.querySelector('.markdown-translation-status').textContent,
            'Japanese · 0/1 · 0%'
        );
        assert.deepEqual(updates.at(-1).translationFailures, [{
            id: block.id,
            from: 0,
            to: 9,
        }]);
        assert.equal(
            shadow.querySelector('#mktero-translation-view').hidden,
            false
        );
        assert.equal(
            shadow.querySelector('[data-translation-view="translated"]')
                .disabled,
            false
        );
        assert.equal(
            shadow.querySelector('.markdown-translation-status').textContent,
            'Japanese · 0/1 · 0%'
        );
        view.render({
            ...partialModel,
            translationStatus: 'loading',
            translationProgress: 0,
            translationCompletedBlocks: 0,
            translationTotalBlocks: 0,
            translationStage: 'preparing',
            translationRequestedTargetLanguage: 'ja-JP',
        });
        assert.equal(
            shadow.querySelector('.markdown-translation-status').textContent,
            'Japanese · 0/0 · 0%'
        );
        assert.equal(
            shadow.querySelector(
                '[aria-label="Previous untranslated block"]'
            ).disabled,
            false
        );

    }
    finally {
        view.destroy();
    }
});

test('offers a short undo action after deleting a correction block', async () => {
    let editorOptions;
    const restored = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Delete this paragraph.',
        sourceKind: 'markdown',
        onCommitCorrection: async correction => {
            assert.equal(correction.replacementMarkdown, ' \t');
        },
        onRestoreCorrection: async blockID => {
            restored.push(blockID);
        },
    });
    const { view, shadow } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                setCorrectionState() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    try {
        await editorOptions.onCommitCorrection({
            blockID: 'paragraph-1',
            replacementMarkdown: ' \t',
        });

        const undo = shadow.querySelector('.markdown-correction-undo');
        const button = shadow.querySelector('.markdown-correction-undo-button');
        assert.equal(undo.hidden, false);
        assert.equal(
            shadow.querySelector('.markdown-correction-undo-message').textContent,
            'A content block was deleted.'
        );
        assert.equal(button.textContent, 'Undo deletion');

        button.click();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(restored, ['paragraph-1']);
        assert.equal(undo.hidden, true);
    }
    finally {
        view.destroy();
    }
});

test('offers to retranslate only the translated block changed by a correction', async () => {
    let editorOptions;
    const translationRequests = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Original paragraph.',
        sourceKind: 'markdown',
        onCommitCorrection: async () => ({
            translationRefresh: {
                blockIDs: ['translation-0-0-17-paragraph'],
                targetLanguage: 'zh-CN',
                translationView: 'compare',
            },
        }),
        onTranslateDocument: options => translationRequests.push(options),
    });
    const { view, shadow } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                setCorrectionState() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    try {
        await editorOptions.onCommitCorrection({
            blockID: 'paragraph-1',
            replacementMarkdown: 'Edited paragraph.',
        });
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(translationRequests, []);
        const confirmation = shadow.querySelector(
            '.mktero-confirmation-dialog'
        );
        assert.equal(
            confirmation.querySelector('.mktero-confirmation-title').textContent,
            'Retranslate changed block?'
        );
        assert.equal(
            confirmation.querySelector('.mktero-confirmation-message').textContent,
            'This translated block changed. Retranslate only this block?'
        );
        confirmation.querySelector('[data-confirmation-action="confirm"]').click();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(translationRequests, [{
            retryBlockIDs: ['translation-0-0-17-paragraph'],
            targetLanguage: 'zh-CN',
            translationView: 'compare',
        }]);
    }
    finally {
        view.destroy();
    }
});

test('updates Markdown and PDF annotations as one editor document', () => {
    const updates = [];
    const sourceMap = [{
        type: 'text',
        markdownFrom: 0,
        markdownTo: 9,
        locations: [{ pageIndex: 3, bbox: [100, 120, 900, 220] }],
    }];
    const annotationOverlay = {
        matched: [{
            id: 'HIGH0001',
            type: 'highlight',
            text: 'Important',
            comment: 'Review this',
            color: '#ffd400',
            pageLabel: '4',
            ranges: [{ from: 0, to: 9 }],
        }],
        unmatched: [],
    };
    const { view } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Important result.',
        annotationOverlay,
        sourceMap,
    }), {}, {
        editorFactory() {
            return {
                setMarkdown() {},
                setDocument(document) {
                    updates.push(document);
                },
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    assert.deepEqual(updates, [{
        markdown: 'Important result.',
        annotationOverlay,
        sourceMap,
            sourceActionRanges: null,
            translationRanges: [],
            translationFailures: [],
            translationPairs: [],
        }]);
    view.destroy();
});

test('forwards mapped source locations to the current tab model', async () => {
    let editorOptions;
    const opened = [];
    const model = createModel({
        status: 'ready',
        markdown: 'Mapped paragraph.',
        onOpenSourceInPDF: location => opened.push(location),
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });
    const location = {
        pageIndex: 2,
        bbox: [100, 200, 900, 300],
    };

    await editorOptions.openSourceLocation(location);

    assert.deepEqual(opened, [location]);
    view.destroy();
});

test('forwards PDF annotation navigation to the current tab model', async () => {
    let editorOptions;
    const opened = [];
    const model = createModel({
        status: 'ready',
        markdown: 'Mapped annotation.',
        onOpenAnnotationInPDF: annotationID => opened.push(annotationID),
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.openAnnotationInPDF('HIGH0001');

    assert.deepEqual(opened, ['HIGH0001']);
    view.destroy();
});

test('forwards sourced Markdown copy targets to the current tab model', async () => {
    let editorOptions;
    const copied = [];
    const model = createModel({
        status: 'ready',
        markdown: 'Mapped paragraph.',
        onCopySourcedMarkdown: target => copied.push(target),
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });
    const target = { kind: 'block', from: 0, to: 17 };

    await editorOptions.copySourcedMarkdown(target);

    assert.deepEqual(copied, [target]);
    view.destroy();
});

test('keeps source annotations and evidence actions on bilingual source blocks', async () => {
    const updates = [];
    const copied = [];
    const created = [];
    let editorOptions;
    const sourceMap = [{
        type: 'text',
        markdownFrom: 9,
        markdownTo: 28,
        locations: [{ pageIndex: 2, bbox: [100, 200, 900, 300] }],
    }];
    const annotationOverlay = {
        matched: [{
            id: 'HIGH0001',
            type: 'highlight',
            text: 'Original',
            color: '#ffd400',
            ranges: [{ from: 9, to: 17 }],
        }],
        unmatched: [],
    };
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nOriginal paragraph.',
        sourceMap,
        annotationOverlay,
        translationStatus: 'ready',
        translationView: 'compare',
        translatedMarkdown: '# \u8bba\u6587\n\n\u8bd1\u6587\u6bb5\u843d\u3002',
        comparisonMarkdown: [
            '# Paper',
            '',
            '# \u8bba\u6587',
            '',
            'Original paragraph.',
            '',
            '\u8bd1\u6587\u6bb5\u843d\u3002',
        ].join('\n'),
        comparisonTranslationRanges: [{ from: 9, to: 13 }, {
            from: 36,
            to: 41,
        }],
        translationBlockRanges: [{
            id: 'translation-0-0-7-heading',
            sourceFrom: 0,
            sourceTo: 7,
            translatedFrom: 0,
            translatedTo: 4,
            comparisonSourceFrom: 0,
            comparisonSourceTo: 7,
            comparisonTranslationFrom: 9,
            comparisonTranslationTo: 13,
        }, {
            id: 'translation-1-9-28-paragraph',
            sourceFrom: 9,
            sourceTo: 28,
            translatedFrom: 6,
            translatedTo: 11,
            comparisonSourceFrom: 15,
            comparisonSourceTo: 34,
            comparisonTranslationFrom: 36,
            comparisonTranslationTo: 41,
        }],
        onCopySourcedMarkdown: target => copied.push(target),
        onCreateMarkdownAnnotation: annotation => {
            created.push(annotation);
            return {
                ...annotation,
                id: 'mktero-local-bilingual',
                source: 'markdown',
                type: 'highlight',
            };
        },
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument(document) {
                    updates.push(document);
                },
                setCorrectionState() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    assert.deepEqual(updates.at(-1).annotationOverlay.matched[0].ranges, [{
        from: 15,
        to: 23,
    }]);
    assert.deepEqual(updates.at(-1).sourceMap, [{
        ...sourceMap[0],
        markdownFrom: 15,
        markdownTo: 34,
    }]);

    await editorOptions.copySourcedMarkdown({
        kind: 'selection',
        text: 'Original',
        ranges: [{ from: 15, to: 23 }],
    });
    assert.deepEqual(copied, [{
        kind: 'selection',
        text: 'Original',
        ranges: [{ from: 9, to: 17 }],
    }]);

    await editorOptions.createMarkdownAnnotation({
        text: 'Original',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 15, to: 23 }],
    }, { side: 'source' });
    assert.deepEqual(created[0].ranges, [{ from: 9, to: 17 }]);
    await assert.rejects(
        editorOptions.createMarkdownAnnotation({
            text: 'Original',
            color: '#ffd400',
            ranges: [{ from: 15, to: 23 }],
        }, { side: 'translated' }),
        /require original text/
    );
    await assert.rejects(
        editorOptions.createMarkdownAnnotation({
            text: 'Original',
            color: '#ffd400',
            ranges: [{ from: 15, to: 23 }],
        }),
        /require original text/
    );
    assert.equal(created.length, 1);

    assert.throws(() => editorOptions.copySourcedMarkdown({
        kind: 'selection',
        text: '\u8bd1\u6587',
        ranges: [{ from: 36, to: 38 }],
    }), /source/i);
    view.destroy();
});

test('maps compare-view copy targets to source coordinates so evidence resolves through the real snippet chain', async () => {
    let editorOptions;
    let resolvedSnippet = null;
    const sourceMap = [{
        type: 'text',
        markdownFrom: 9,
        markdownTo: 28,
        locations: [{ pageIndex: 2, bbox: [100, 200, 900, 300] }],
    }];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nOriginal paragraph.',
        sourceMap,
        translationStatus: 'ready',
        translationView: 'compare',
        translatedMarkdown: '# 论文\n\n译文段落。',
        comparisonMarkdown: [
            '# Paper',
            '',
            '# 论文',
            '',
            'Original paragraph.',
            '',
            '译文段落。',
        ].join('\n'),
        translationBlockRanges: [{
            id: 'translation-1-9-28-paragraph',
            sourceFrom: 9,
            sourceTo: 28,
            translatedFrom: 6,
            translatedTo: 11,
            comparisonSourceFrom: 15,
            comparisonSourceTo: 34,
            comparisonTranslationFrom: 36,
            comparisonTranslationTo: 41,
        }],
        onCopySourcedMarkdown: target => {
            resolvedSnippet = createEvidenceSnippet({
                markdown: model.markdown,
                sourceMap: model.sourceMap,
                target,
            });
            return resolvedSnippet;
        },
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                setCorrectionState() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.copySourcedMarkdown({
        kind: 'selection',
        text: 'Original',
        ranges: [{ from: 15, to: 23 }],
    });

    assert.ok(resolvedSnippet, 'the real evidence chain was invoked');
    assert.deepEqual(resolvedSnippet.pageIndexes, [2]);

    assert.throws(() => createEvidenceSnippet({
        markdown: model.markdown,
        sourceMap: model.sourceMap,
        target: {
            kind: 'selection',
            text: 'Original',
            ranges: [{ from: 15, to: 23 }],
        },
    }), {
        message: /source|Markdown range/i,
    });

    view.destroy();
});

test('exports the Markdown matching the active translation view through the real selector', async () => {
    let editorOptions;
    let exportedMarkdown = null;
    const comparisonMarkdown = [
        '# Paper',
        '',
        '# 论文',
        '',
        'Original paragraph.',
        '',
        '译文段落。',
    ].join('\n');
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nOriginal paragraph.',
        translatedMarkdown: '# 论文\n\n译文段落。',
        comparisonMarkdown,
        translationStatus: 'ready',
        translationView: 'compare',
        onExportMarkdown: () => {
            exportedMarkdown = selectExportMarkdown(model);
            return { status: 'success' };
        },
    });
    const { view, shadow } = createView(model);
    const toggle = shadow.querySelector('#mktero-document-actions');
    const exportButton = shadow.querySelector('#mktero-export-markdown');

    toggle.click();
    exportButton.click();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(exportedMarkdown, comparisonMarkdown);

    view.destroy();
});

test('forwards code copy requests to the current tab model', async () => {
    let editorOptions;
    const copied = [];
    const model = createModel({
        status: 'ready',
        markdown: '```js\nconst answer = 42;\n```',
        onCopyCode: code => copied.push(code),
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.copyCode('const answer = 42;\n');

    assert.deepEqual(copied, ['const answer = 42;\n']);
    view.destroy();
});

test('forwards selection translation callbacks through the current reader model', async () => {
    let editorOptions;
    const calls = [];
    const firstModel = createModel({
        status: 'ready',
        markdown: 'Selected text.',
        onTranslateSelection: request => calls.push(['first', request]),
        onCancelSelectionTranslation: () => calls.push(['cancel-first']),
        shouldAutoTranslateSelection: () => false,
        onCopySelectionTranslation: text => calls.push(['copy-first', text]),
    });
    const { view } = createView(firstModel, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });
    const secondModel = {
        ...firstModel,
        onTranslateSelection: request => calls.push(['second', request]),
        onCancelSelectionTranslation: () => calls.push(['cancel-second']),
        shouldAutoTranslateSelection: () => true,
        onCopySelectionTranslation: text => calls.push(['copy-second', text]),
    };
    const onTextDelta = () => {};

    try {
        view.render(secondModel);
        await editorOptions.translateSelection(
            'Selected text.',
            { translationContext: 'Before selected text. Selected text. After.' },
            { onTextDelta },
        );
        editorOptions.cancelSelectionTranslation();
        assert.equal(editorOptions.shouldAutoTranslateSelection(), true);
        await editorOptions.copySelectionTranslation('已翻译文本');

        assert.deepEqual(calls, [
            ['second', {
                text: 'Selected text.',
                context: 'Before selected text. Selected text. After.',
                onTextDelta,
            }],
            ['cancel-second'],
            ['copy-second', '已翻译文本'],
        ]);
    }
    finally {
        view.destroy();
    }
});

test('reparses the current PDF from an accessible icon action', async () => {
    let reparseCalls = 0;
    let finishReparse;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        onReparse: () => {
            reparseCalls += 1;
            return new Promise(resolve => {
                finishReparse = resolve;
            });
        },
    });
    const { view, shadow } = createView(model);

    const reparse = shadow.querySelector('#mktero-reparse');
    const hint = 'Reparse PDF. This uploads the PDF again and may consume '
        + 'conversion service quota.';
    assert.equal(reparse?.localName, 'button');
    assert.equal(reparse?.getAttribute('aria-label'), hint);
    assert.equal(reparse?.getAttribute('title'), hint);
    assert.equal(shadow.querySelector('.markdown-reader-actions').hidden, false);
    assert.equal(
        reparse?.querySelector('svg')?.getAttribute('data-lucide'),
        'refresh-cw'
    );
    assert.equal(reparse?.disabled, false);

    reparse.click();
    assert.equal(reparseCalls, 1);
    assert.equal(reparse.disabled, true);
    reparse.click();
    assert.equal(reparseCalls, 1);

    view.render({
        ...model,
        status: 'loading',
        progress: 20,
        preserveContent: true,
    });
    assert.equal(reparse.disabled, true);
    assert.equal(reparse.getAttribute('aria-busy'), 'true');
    finishReparse();
    await Promise.resolve();

    view.destroy();
});

test('confirms inside Mktero before reparsing a document with corrections',
    async () => {
        let reparseCalls = 0;
        const model = createModel({
            status: 'ready',
            progress: 100,
            markdown: '# Corrected paper',
            sourceKind: 'markdown',
            hasCorrections: true,
            correctionCount: 2,
            onReparse: () => { reparseCalls++; },
        });
        const { view, shadow } = createView(model);

        try {
            shadow.querySelector('#mktero-reparse').click();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(reparseCalls, 0);
            const confirmation = shadow.querySelector(
                '.mktero-confirmation-dialog'
            );
            assert.equal(
                confirmation.querySelector('.mktero-confirmation-title').textContent,
                'Reparse PDF?'
            );
            assert.equal(
                confirmation.querySelector('.mktero-confirmation-message').textContent,
                'Reparsing will permanently delete 2 saved corrections. Continue?'
            );
            confirmation.querySelector(
                '[data-confirmation-action="confirm"]'
            ).click();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(reparseCalls, 1);
        }
        finally {
            view.destroy();
        }
    });

test('keeps conversion recovery actions visible when the first conversion fails', async () => {
    const calls = [];
    const model = createModel({
        status: 'error',
        error: 'The conversion service could not be reached.',
        errorAction: 'open-settings',
        onReparse: () => calls.push('retry'),
        onOpenSettings: () => calls.push('settings'),
    });
    const { view, shadow } = createView(model);
    const error = shadow.querySelector('#mktero-error');
    const retry = shadow.querySelector('#mktero-error-retry');
    const settings = shadow.querySelector('#mktero-error-settings');

    assert.equal(error.hidden, false);
    assert.equal(shadow.querySelector('.markdown-workspace').hidden, true);
    assert.equal(retry.hidden, false);
    assert.equal(settings.hidden, false);
    assert.equal(retry.getAttribute('aria-label'), 'Retry PDF conversion');
    assert.equal(settings.getAttribute('aria-label'), 'Open Mktero settings');

    retry.click();
    assert.deepEqual(calls, ['retry']);
    assert.equal(retry.disabled, true);

    await new Promise(resolve => setImmediate(resolve));
    view.render(model);
    settings.click();
    assert.deepEqual(calls, ['retry', 'settings']);

    view.destroy();
});

test('keeps the settings action beside previous content after a token reparse failure', () => {
    const calls = [];
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Cached paper',
        warnings: ['Reparse failed: API Token is invalid.'],
        warningAction: 'open-settings',
        onOpenSettings: () => calls.push('settings'),
    }));

    try {
        const settings = shadow.querySelector('#mktero-warning-settings');
        assert.equal(shadow.querySelector('#mktero-error').hidden, true);
        assert.equal(shadow.querySelector('#mktero-warning').hidden, false);
        assert.equal(settings.hidden, false);
        assert.equal(settings.getAttribute('aria-label'), 'Open Mktero settings');

        settings.click();

        assert.deepEqual(calls, ['settings']);
    }
    finally {
        view.destroy();
    }
});

test('shows non-fatal warnings as auto-dismissed toasts without reflowing content', () => {
    const timers = [];
    const clearCalls = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Cached paper',
        warnings: ['Some local Markdown annotations could not be synchronized.'],
    });
    const { view, shadow } = createView(model, {}, {
        configureWindow(window) {
            window.setTimeout = (callback, delay) => {
                const timer = { callback, delay };
                timers.push(timer);
                return timer;
            };
            window.clearTimeout = timer => clearCalls.push(timer);
        },
    });

    try {
        const warning = shadow.querySelector('#mktero-warning');
        assert.equal(warning.hidden, false);
        assert.equal(timers.length, 1);
        assert.equal(timers[0].delay, 5_000);
        assert.equal(shadow.querySelector('.markdown-workspace').hidden, false);

        timers[0].callback();
        assert.equal(warning.hidden, true);

        view.render(model);
        assert.equal(warning.hidden, true);
        assert.equal(timers.length, 1);

        view.render({
            ...model,
            warnings: ['A new warning appeared.'],
        });
        assert.equal(warning.hidden, false);
        assert.equal(timers.length, 2);
    }
    finally {
        view.destroy();
    }

    assert.deepEqual(clearCalls, [timers[1]]);
});

test('isolates warning toast timers across Zotero windows', () => {
    const timers = [[], []];
    const clearCalls = [[], []];
    const createWarningView = index => createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Cached paper',
        warnings: [`Warning ${index}`],
    }), {}, {
        configureWindow(window) {
            window.setTimeout = (callback, delay) => {
                const timer = { callback, delay };
                timers[index].push(timer);
                return timer;
            };
            window.clearTimeout = timer => clearCalls[index].push(timer);
        },
    });
    const first = createWarningView(0);
    const second = createWarningView(1);

    try {
        assert.equal(first.shadow.querySelector('#mktero-warning').hidden, false);
        assert.equal(second.shadow.querySelector('#mktero-warning').hidden, false);
        assert.equal(timers[0].length, 1);
        assert.equal(timers[1].length, 1);

        timers[0][0].callback();

        assert.equal(first.shadow.querySelector('#mktero-warning').hidden, true);
        assert.equal(second.shadow.querySelector('#mktero-warning').hidden, false);
    }
    finally {
        first.view.destroy();
        second.view.destroy();
    }

    assert.deepEqual(clearCalls[0], []);
    assert.deepEqual(clearCalls[1], [timers[1][0]]);
});

test('keeps actionable warning toasts available for settings recovery', () => {
    const timers = [];
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Cached paper',
        warnings: ['The API Token is invalid.'],
        warningAction: 'open-settings',
        onOpenSettings: () => {},
    }), {}, {
        configureWindow(window) {
            window.setTimeout = (callback, delay) => {
                const timer = { callback, delay };
                timers.push(timer);
                return timer;
            };
        },
    });

    try {
        assert.equal(shadow.querySelector('#mktero-warning').hidden, false);
        assert.equal(shadow.querySelector('#mktero-warning-settings').hidden, false);
        assert.equal(timers.length, 0);
    }
    finally {
        view.destroy();
    }
});

test('opens the document action popover and reports snapshot save state', async () => {
    let saveCalls = 0;
    let finishSave;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        onSaveSnapshot: () => {
            saveCalls++;
            return new Promise(resolve => {
                finishSave = resolve;
            });
        },
    });
    const { document, view, shadow } = createView(model);
    const toggle = shadow.querySelector('#mktero-document-actions');
    const menu = shadow.querySelector('#mktero-document-action-menu');
    const reparse = shadow.querySelector('#mktero-reparse');
    const save = shadow.querySelector('#mktero-save-snapshot');

    assert.equal(
        toggle.querySelector('svg')?.getAttribute('data-lucide'),
        'more-horizontal'
    );
    assert.equal(toggle.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(menu.getAttribute('role'), 'dialog');
    assert.equal(menu.getAttribute('aria-label'), 'Document actions');
    assert.equal(reparse.textContent, 'Reparse PDF');
    assert.equal(save.textContent, 'Save snapshot');
    assert.equal(reparse.getAttribute('role'), null);
    assert.equal(save.getAttribute('role'), null);

    toggle.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(menu.getAttribute('aria-hidden'), 'false');
    assert.equal(shadow.querySelector('.markdown-reader-actions').classList.contains(
        'is-open'
    ), true);
    assert.equal(save.getAttribute('tabindex'), '0');

    dispatchWindowKeyboardEvent(document.defaultView, 'Escape');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(menu.getAttribute('aria-hidden'), 'true');
    assert.equal(save.getAttribute('tabindex'), '-1');

    toggle.click();
    save.click();
    assert.equal(saveCalls, 1);
    assert.equal(save.disabled, true);
    assert.equal(toggle.disabled, true);
    assert.equal(
        shadow.querySelector('.markdown-reader-action-status').textContent,
        'Saving Zotero snapshot…'
    );

    finishSave();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(save.disabled, false);
    assert.equal(toggle.disabled, false);
    assert.equal(
        shadow.querySelector('.markdown-reader-action-status').textContent,
        'Zotero snapshot saved'
    );
    view.destroy();
});

test('exports Markdown from the document action menu and reports progress', async () => {
    let exportOptions;
    let finishExport;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        onExportMarkdown: options => {
            exportOptions = options;
            return new Promise(resolve => {
                finishExport = resolve;
            });
        },
    });
    const { document, view, shadow } = createView(model);
    const toggle = shadow.querySelector('#mktero-document-actions');
    const exportButton = shadow.querySelector('#mktero-export-markdown');

    assert.equal(exportButton.textContent, 'Export Markdown');
    assert.equal(
        exportButton.querySelector('svg')?.getAttribute('data-lucide'),
        'download'
    );
    toggle.click();
    exportButton.click();
    assert.equal(exportOptions.ownerWindow, document.defaultView);
    assert.equal(exportButton.disabled, true);
    assert.equal(toggle.disabled, true);
    assert.equal(
        shadow.querySelector('.markdown-reader-action-status').textContent,
        'Exporting Markdown…'
    );

    finishExport({ status: 'exported', path: '/exports/Paper.md' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exportButton.disabled, false);
    assert.equal(toggle.disabled, false);
    assert.equal(
        shadow.querySelector('.markdown-reader-action-status').textContent,
        'Markdown exported'
    );
    view.destroy();
});

test('closes a cancelled Markdown export without reporting success', async () => {
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        onExportMarkdown: async () => ({ status: 'cancelled' }),
    });
    const { view, shadow } = createView(model);

    shadow.querySelector('#mktero-document-actions').click();
    shadow.querySelector('#mktero-export-markdown').click();
    await new Promise(resolve => setImmediate(resolve));

    const status = shadow.querySelector('.markdown-reader-action-status');
    assert.equal(status.hidden, true);
    assert.equal(status.textContent, '');
    view.destroy();
});

test('isolates Markdown exports across windows and ignores late view updates', async () => {
    let finishFirstExport;
    let firstOptions;
    let secondOptions;
    const first = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# First',
        sourceKind: 'markdown',
        onExportMarkdown: options => {
            firstOptions = options;
            return new Promise(resolve => {
                finishFirstExport = resolve;
            });
        },
    }));
    const second = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Second',
        sourceKind: 'markdown',
        onExportMarkdown: async options => {
            secondOptions = options;
            return { status: 'cancelled' };
        },
    }));
    const firstTimers = [];
    first.view.ownerWindow.setTimeout = (callback, delay) => {
        const timer = { callback, delay };
        firstTimers.push(timer);
        return timer;
    };

    first.shadow.querySelector('#mktero-document-actions').click();
    first.shadow.querySelector('#mktero-export-markdown').click();
    assert.equal(firstOptions.ownerWindow, first.document.defaultView);
    assert.equal(
        second.shadow.querySelector('#mktero-export-markdown').disabled,
        false
    );

    second.shadow.querySelector('#mktero-document-actions').click();
    second.shadow.querySelector('#mktero-export-markdown').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondOptions.ownerWindow, second.document.defaultView);

    first.view.destroy();
    finishFirstExport({ status: 'exported', path: '/exports/First.md' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(firstTimers, []);
    second.view.destroy();
});

test('keeps reading controls in a toolbar above the Markdown body', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
        onReparse: () => {},
        onSaveSnapshot: () => {},
    }));

    try {
        const toolbar = shadow.querySelector('.markdown-reader-toolbar');
        const readingLayout = shadow.querySelector('.markdown-reading-layout');
        const editor = shadow.querySelector('#mktero-editor');
        const menu = shadow.querySelector('#mktero-document-action-menu');
        const size = shadow.querySelector('.markdown-reader-font-size');
        const family = shadow.querySelector('.markdown-reader-font-family');
        const readerControls = shadow.querySelector('.markdown-reader-controls');
        const translationControls = shadow.querySelector(
            '.markdown-translation-controls'
        );
        const translationSeparator = shadow.querySelector(
            '.markdown-translation-separator'
        );
        const translationViewLabel = shadow.querySelector(
            '.markdown-translation-view-label'
        );
        const translationView = shadow.querySelector(
            '#mktero-translation-view'
        );
        const translationStatus = shadow.querySelector(
            '.markdown-translation-status'
        );
        const translationContext = shadow.querySelector(
            '.markdown-translation-context'
        );
        const failureNavigation = shadow.querySelector(
            '.markdown-translation-failure-navigation'
        );
        const translate = shadow.querySelector('#mktero-translate-document');

        assert.equal(toolbar?.getAttribute('role'), 'toolbar');
        assert.equal(
            toolbar?.getAttribute('aria-label'),
            'Markdown reading toolbar'
        );
        assert.equal(toolbar?.nextElementSibling, readingLayout);
        assert.equal(readingLayout?.contains(editor), true);
        assert.equal(toolbar?.contains(size), true);
        assert.equal(toolbar?.contains(family), true);
        assert.equal(
            toolbar?.querySelector('.markdown-reader-font-label'),
            null
        );
        assert.deepEqual(
            [...size.children],
            [shadow.querySelector('.markdown-reader-font-controls')]
        );
        assert.deepEqual(
            [...family.children],
            [shadow.querySelector('.markdown-reader-font-picker')]
        );
        assert.equal(readerControls?.nextElementSibling, translationControls);
        assert.deepEqual(
            [...translationControls.children],
            [
                translationViewLabel,
                translationView,
                translationContext,
                failureNavigation,
                translationSeparator,
                translate,
            ]
        );
        assert.deepEqual(
            [...translationContext.children],
            [translationStatus]
        );
        assert.equal(translationSeparator?.getAttribute('role'), 'separator');
        assert.equal(
            translationSeparator?.getAttribute('aria-orientation'),
            'vertical'
        );
        assert.equal(menu?.contains(size), false);
        assert.equal(menu?.contains(family), false);
        assert.equal(menu?.contains(shadow.querySelector('#mktero-reparse')), true);
        assert.equal(
            menu?.contains(shadow.querySelector('#mktero-save-snapshot')),
            true
        );
    }
    finally {
        view.destroy();
    }
});

test('enables the citation return button from editor navigation state', () => {
    let editorOptions;
    let returnCalls = 0;
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            editorOptions = options;
            const editor = createTestInlineEditor(options);
            editor.returnToCitation = () => {
                returnCalls++;
                editorOptions.onNavigationBackChange(false);
                return true;
            };
            return editor;
        },
    });

    const button = shadow.querySelector('#mktero-navigation-back');
    try {
        assert.equal(button.disabled, true);
        assert.equal(button.getAttribute('aria-label'), 'Return to citation');

        editorOptions.onNavigationBackChange(true);
        assert.equal(button.disabled, false);
        button.click();

        assert.equal(returnCalls, 1);
        assert.equal(button.disabled, true);
    }
    finally {
        view.destroy();
    }
});

test('adjusts the persisted reader font size from the top toolbar', () => {
    const persistedSizes = [];
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
    }), {}, {
        readerFontSize: 18,
        onReaderFontSizeChange: size => persistedSizes.push(size),
    });

    try {
        const decrease = shadow.querySelector('#mktero-reader-font-decrease');
        const increase = shadow.querySelector('#mktero-reader-font-increase');
        const value = shadow.querySelector('#mktero-reader-font-value');
        const group = shadow.querySelector('.markdown-reader-font-size');

        assert.equal(group.getAttribute('aria-label'), 'Text size');
        assert.equal(decrease.textContent, 'A−');
        assert.equal(increase.textContent, 'A+');
        assert.equal(value.textContent, '18 px');
        assert.equal(view.host.style.getPropertyValue('--reader-font-size'), '18px');

        increase.click();
        increase.click();
        increase.click();
        increase.click();

        assert.deepEqual(persistedSizes, [19, 20, 21, 22]);
        assert.equal(value.textContent, '22 px');
        assert.equal(view.host.style.getPropertyValue('--reader-font-size'), '22px');
        assert.equal(increase.disabled, true);
        assert.equal(decrease.disabled, false);

        decrease.click();
        assert.equal(value.textContent, '21 px');
        assert.equal(increase.disabled, false);
        assert.equal(decrease.getAttribute('tabindex'), '0');
        assert.equal(increase.getAttribute('tabindex'), '0');
    }
    finally {
        view.destroy();
    }
});

test('refreshes editor geometry after reader typography changes', () => {
    let measureRequests = 0;
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            const editor = createTestInlineEditor(options);
            editor.requestMeasure = () => {
                measureRequests++;
            };
            return editor;
        },
    });

    try {
        const initialRequests = measureRequests;
        shadow.querySelector('#mktero-reader-font-increase').click();
        view.setReaderFont('cambria');
        view.setReaderFont('cambria');
        view.setReaderFontSize(view.readerFontSize);

        assert.equal(measureRequests, initialRequests + 2);
    }
    finally {
        view.destroy();
    }
});

test('selects a font from the top toolbar without opening document actions', () => {
    const persistedFonts = [];
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
    }), {}, {
        readerFont: 'georgia',
        onReaderFontChange: font => persistedFonts.push(font),
    });

    try {
        const trigger = shadow.querySelector('#mktero-reader-font-family');
        const listbox = shadow.querySelector('#mktero-reader-font-options');
        const toggle = shadow.querySelector('#mktero-document-actions');
        const options = [...(listbox?.querySelectorAll('[role="option"]') || [])];

        assert.equal(trigger.localName, 'button');
        assert.equal(trigger.getAttribute('aria-label'), 'Text font: Georgia');
        assert.equal(trigger.getAttribute('aria-haspopup'), 'listbox');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(
            trigger.querySelector('svg')?.getAttribute('data-lucide'),
            'chevron-down'
        );
        assert.equal(listbox.getAttribute('role'), 'listbox');
        assert.equal(listbox.hidden, true);
        assert.deepEqual(
            options.map(option => option.getAttribute('data-reader-font')),
            ['system-serif', 'georgia', 'cambria', 'times-new-roman']
        );
        assert.equal(
            shadow.host.style.getPropertyValue('--reader-font'),
            'Georgia, Cambria, "Times New Roman", serif'
        );
        assert.equal(
            listbox.querySelector('[data-reader-font="georgia"]')
                .getAttribute('aria-selected'),
            'true'
        );
        assert.equal(
            listbox.querySelector('[data-reader-font="georgia"] svg')
                ?.getAttribute('data-lucide'),
            'check'
        );
        dispatchMouseEvent(trigger, 'mousedown', 0);
        trigger.click();
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(listbox.hidden, false);

        const cambria = listbox.querySelector('[data-reader-font="cambria"]');
        dispatchMouseEvent(cambria, 'mousedown', 0);
        cambria.click();

        assert.deepEqual(persistedFonts, ['cambria']);
        assert.equal(
            shadow.host.style.getPropertyValue('--reader-font'),
            'Cambria, Georgia, "Times New Roman", serif'
        );
        assert.equal(
            listbox.querySelector('[data-reader-font="cambria"]')
                .getAttribute('aria-selected'),
            'true'
        );
        assert.equal(trigger.textContent.trim(), 'Cambria');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(listbox.hidden, true);
        assert.equal(
            shadow.querySelector('#mktero-document-actions')
                .getAttribute('aria-expanded'),
            'false'
        );

        const ownerWindow = trigger.ownerDocument.defaultView;
        const outside = trigger.ownerDocument.createElement('div');
        trigger.ownerDocument.body.appendChild(outside);
        const outsidePress = new ownerWindow.Event('mousedown', {
            bubbles: true,
        });
        outside.dispatchEvent(outsidePress);
        assert.equal(
            shadow.querySelector('#mktero-document-actions')
                .getAttribute('aria-expanded'),
            'false'
        );
    }
    finally {
        view.destroy();
    }
});

test('offers fonts for the current language only in translated mode', () => {
    const persistedFonts = [];
    const translatedModel = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        translationStatus: 'ready',
        translationView: 'original',
        translationTargetLanguage: 'zh-CN',
        translatedMarkdown: '# \u8bba\u6587',
        comparisonMarkdown: '# Paper\n\n# \u8bba\u6587',
        onTranslateDocument: () => {},
        onSetTranslationView: () => {},
    });
    const { view, shadow } = createView(translatedModel, {}, {
        readerFont: 'georgia',
        onReaderFontChange: font => persistedFonts.push(font),
    });
    const trigger = shadow.querySelector('#mktero-reader-font-family');
    const listbox = shadow.querySelector('#mktero-reader-font-options');
    const optionValues = () => [...listbox.querySelectorAll('[role="option"]')]
        .map(option => option.getAttribute('data-reader-font'));

    try {
        assert.deepEqual(optionValues(), [
            'system-serif',
            'georgia',
            'cambria',
            'times-new-roman',
        ]);
        assert.equal(trigger.textContent.trim(), 'Georgia');

        view.render({ ...translatedModel, translationView: 'translated' });
        assert.deepEqual(optionValues(), [
            'noto-serif-sc',
            'source-han-serif-sc',
            'songti-sc',
            'simsun',
        ]);
        assert.equal(trigger.textContent.trim(), 'Noto Serif SC');
        assert.equal(
            shadow.host.style.getPropertyValue('--reader-selected-translation-font'),
            'var(--reader-translation-font-zh-cn)'
        );

        const sourceHan = listbox.querySelector(
            '[data-reader-font="source-han-serif-sc"]'
        );
        sourceHan.click();
        assert.deepEqual(persistedFonts, []);
        assert.equal(trigger.textContent.trim(), 'Source Han Serif SC');
        assert.equal(sourceHan.getAttribute('aria-selected'), 'true');
        assert.match(
            shadow.host.style.getPropertyValue('--reader-selected-translation-font'),
            /^"Source Han Serif SC"/
        );

        view.render({ ...translatedModel, translationView: 'compare' });
        assert.deepEqual(optionValues(), [
            'system-serif',
            'georgia',
            'cambria',
            'times-new-roman',
        ]);
        assert.equal(trigger.textContent.trim(), 'Georgia');

        view.render({ ...translatedModel, translationView: 'translated' });
        assert.equal(trigger.textContent.trim(), 'Source Han Serif SC');

        trigger.click();
        let focusedElement = listbox.querySelector(
            '[data-reader-font="source-han-serif-sc"]'
        );
        let triggerFocuses = 0;
        Object.defineProperty(shadow, 'activeElement', {
            configurable: true,
            get: () => focusedElement,
        });
        trigger.focus = () => {
            triggerFocuses++;
            focusedElement = trigger;
        };
        view.render({
            ...translatedModel,
            translationView: 'translated',
            translationTargetLanguage: 'ja-JP',
        });
        assert.equal(triggerFocuses, 1);
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');

        const languageOptions = [
            ['zh-TW', [
                'noto-serif-tc',
                'source-han-serif-tc',
                'songti-tc',
                'pmingliu',
            ], 'Noto Serif TC'],
            ['ja-JP', [
                'noto-serif-jp',
                'source-han-serif-jp',
                'yu-mincho',
                'hiragino-mincho',
            ], 'Noto Serif JP'],
            ['ko-KR', [
                'noto-serif-kr',
                'source-han-serif-k',
                'apple-myungjo',
                'batang',
            ], 'Noto Serif KR'],
            ...['es-ES', 'fr-FR', 'pt-BR'].map(language => ([
                language,
                ['stix-two-text', 'georgia', 'cambria', 'times-new-roman'],
                'STIX Two Text',
            ])),
        ];
        for (const [language, expectedOptions, expectedLabel]
            of languageOptions) {
            view.render({
                ...translatedModel,
                translationView: 'translated',
                translationTargetLanguage: language,
            });
            assert.deepEqual(optionValues(), expectedOptions, language);
            assert.equal(trigger.textContent.trim(), expectedLabel, language);
        }
    }
    finally {
        view.destroy();
    }
});

test('refreshes editor geometry after changing the translated font', () => {
    let measureRequests = 0;
    const translatedModel = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        translationStatus: 'ready',
        translationView: 'translated',
        translationTargetLanguage: 'zh-CN',
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n# 论文',
        onTranslateDocument: () => {},
        onSetTranslationView: () => {},
    });
    const { view, shadow } = createView(translatedModel, {}, {
        editorFactory(options) {
            const editor = createTestInlineEditor(options);
            editor.requestMeasure = () => {
                measureRequests++;
            };
            return editor;
        },
    });

    try {
        const initialRequests = measureRequests;
        const option = shadow.querySelector(
            '[data-reader-font="source-han-serif-sc"]'
        );
        option.click();

        assert.equal(measureRequests, initialRequests + 1);
    }
    finally {
        view.destroy();
    }
});

test('isolates translated font choices across Zotero windows', () => {
    const translatedModel = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        translationStatus: 'ready',
        translationView: 'translated',
        translationTargetLanguage: 'zh-CN',
        translatedMarkdown: '# \u8bba\u6587',
        comparisonMarkdown: '# Paper\n\n# \u8bba\u6587',
        onTranslateDocument: () => {},
        onSetTranslationView: () => {},
    });
    const first = createView(translatedModel);
    const second = createView(translatedModel);

    try {
        first.shadow.querySelector(
            '[data-reader-font="source-han-serif-sc"]'
        ).click();

        assert.equal(
            first.shadow.querySelector('#mktero-reader-font-family')
                .textContent.trim(),
            'Source Han Serif SC'
        );
        assert.equal(
            second.shadow.querySelector('#mktero-reader-font-family')
                .textContent.trim(),
            'Noto Serif SC'
        );
        assert.match(
            first.shadow.host.style.getPropertyValue(
                '--reader-selected-translation-font'
            ),
            /^"Source Han Serif SC"/
        );
        assert.equal(
            second.shadow.host.style.getPropertyValue(
                '--reader-selected-translation-font'
            ),
            'var(--reader-translation-font-zh-cn)'
        );
    }
    finally {
        first.view.destroy();
        second.view.destroy();
    }
});

test('operates the toolbar font picker from the keyboard', () => {
    const persistedFonts = [];
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
    }), {}, {
        readerFont: 'georgia',
        onReaderFontChange: font => persistedFonts.push(font),
    });

    try {
        const toggle = shadow.querySelector('#mktero-document-actions');
        const trigger = shadow.querySelector('#mktero-reader-font-family');
        const listbox = shadow.querySelector('#mktero-reader-font-options');
        const georgia = listbox.querySelector('[data-reader-font="georgia"]');
        const cambria = listbox.querySelector('[data-reader-font="cambria"]');

        dispatchKeyboardEvent(trigger, 'ArrowDown');
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(listbox.hidden, false);
        assert.equal(georgia.getAttribute('tabindex'), '0');

        dispatchKeyboardEvent(georgia, 'ArrowDown');
        assert.equal(georgia.getAttribute('tabindex'), '-1');
        assert.equal(cambria.getAttribute('tabindex'), '0');
        dispatchKeyboardEvent(cambria, 'Enter');

        assert.deepEqual(persistedFonts, ['cambria']);
        assert.equal(trigger.textContent.trim(), 'Cambria');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(listbox.hidden, true);
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');

        dispatchKeyboardEvent(trigger, 'ArrowDown');
        dispatchKeyboardEvent(cambria, 'Escape');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    }
    finally {
        view.destroy();
    }
});

test('keeps toolbar popovers mutually exclusive and closes them outside', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
        onReparse: () => {},
    }));

    try {
        const ownerWindow = document.defaultView;
        const toggle = shadow.querySelector('#mktero-document-actions');
        const trigger = shadow.querySelector('#mktero-reader-font-family');
        const listbox = shadow.querySelector('#mktero-reader-font-options');
        const outside = document.createElement('div');
        document.body.appendChild(outside);

        toggle.click();
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        trigger.click();
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        outside.dispatchEvent(new ownerWindow.Event('pointerdown', {
            bubbles: true,
        }));

        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(listbox.hidden, true);
    }
    finally {
        view.destroy();
    }
});

test('isolates toolbar popovers across Zotero windows', () => {
    const createToolbarView = () => createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
        onReparse: () => {},
    }));
    const first = createToolbarView();
    const second = createToolbarView();

    try {
        const firstToggle = first.shadow.querySelector(
            '#mktero-document-actions'
        );
        const secondFont = second.shadow.querySelector(
            '#mktero-reader-font-family'
        );
        firstToggle.click();
        secondFont.click();

        assert.equal(firstToggle.getAttribute('aria-expanded'), 'true');
        assert.equal(secondFont.getAttribute('aria-expanded'), 'true');

        const firstOutsidePress = new first.document.defaultView.Event(
            'pointerdown',
            { bubbles: true },
        );
        first.document.body.dispatchEvent(firstOutsidePress);

        assert.equal(firstToggle.getAttribute('aria-expanded'), 'false');
        assert.equal(secondFont.getAttribute('aria-expanded'), 'true');
    }
    finally {
        first.view.destroy();
        second.view.destroy();
    }
});

test('resets the font picker when reader controls become unavailable', () => {
    const readyModel = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
        onReparse: () => {},
    });
    const { view, shadow } = createView(readyModel);

    try {
        const trigger = shadow.querySelector('#mktero-reader-font-family');
        const listbox = shadow.querySelector('#mktero-reader-font-options');
        const family = shadow.querySelector('.markdown-reader-font-family');

        trigger.click();
        assert.equal(trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(listbox.hidden, false);

        view.render(createModel({
            status: 'loading',
            progress: 25,
            onReparse: () => {},
        }));

        assert.equal(family.hidden, true);
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(listbox.hidden, true);

        view.render(readyModel);
        assert.equal(family.hidden, false);
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(listbox.hidden, true);
    }
    finally {
        view.destroy();
    }
});

test('removes document action outside-press listeners when destroyed', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
    }));
    const ownerWindow = document.defaultView;
    const toggle = shadow.querySelector('#mktero-document-actions');
    const fontTrigger = shadow.querySelector('#mktero-reader-font-family');
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    toggle.click();
    fontTrigger.click();
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(fontTrigger.getAttribute('aria-expanded'), 'true');
    view.destroy();

    outside.dispatchEvent(new ownerWindow.Event('pointerdown', {
        bubbles: true,
    }));
    outside.dispatchEvent(new ownerWindow.Event('mousedown', {
        bubbles: true,
    }));
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(fontTrigger.getAttribute('aria-expanded'), 'true');
});

test('clears a failed snapshot save status after reporting the error', async () => {
    let rejectSave;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        onSaveSnapshot: () => new Promise((resolve, reject) => {
            rejectSave = reject;
        }),
    });
    const { view, shadow } = createView(model);
    const timers = [];
    const clearCalls = [];
    view.ownerWindow.setTimeout = (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
    };
    view.ownerWindow.clearTimeout = timer => clearCalls.push(timer);

    const toggle = shadow.querySelector('#mktero-document-actions');
    const save = shadow.querySelector('#mktero-save-snapshot');
    toggle.click();
    save.click();
    rejectSave(new Error('snapshot save failed'));
    await new Promise(resolve => setImmediate(resolve));

    const status = shadow.querySelector('.markdown-reader-action-status');
    assert.equal(status.hidden, false);
    assert.equal(status.textContent, 'The Zotero snapshot could not be saved.');
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay > 0, true);

    timers[0].callback();
    assert.equal(status.hidden, true);
    assert.equal(status.textContent, '');

    view.destroy();
    assert.deepEqual(clearCalls, []);
});

test('cancels a pending snapshot status dismissal when the view is destroyed', async () => {
    let rejectSave;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
        onSaveSnapshot: () => new Promise((resolve, reject) => {
            rejectSave = reject;
        }),
    });
    const { view, shadow } = createView(model);
    const timers = [];
    const clearCalls = [];
    view.ownerWindow.setTimeout = (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
    };
    view.ownerWindow.clearTimeout = timer => clearCalls.push(timer);

    shadow.querySelector('#mktero-document-actions').click();
    shadow.querySelector('#mktero-save-snapshot').click();
    rejectSave(new Error('snapshot save failed'));
    await new Promise(resolve => setImmediate(resolve));

    view.destroy();

    assert.equal(timers.length, 1);
    assert.deepEqual(clearCalls, [timers[0]]);
});

test('renders a saved HTML snapshot without exposing PDF actions or editing controls', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        renderMode: 'html',
        markdown: '',
        snapshotHTML: '<h1>Portable</h1><p>Read only.</p>',
        snapshotAssets: [],
        onReparse: null,
        onSaveSnapshot: null,
    }));

    try {
        assert.equal(shadow.querySelector('.markdown-reading-layout').hidden, true);
        assert.equal(shadow.querySelector('#mktero-snapshot').hidden, false);
        assert.match(
            shadow.querySelector('#mktero-snapshot').textContent,
            /Portable/
        );
        assert.equal(shadow.querySelector('.markdown-reader-actions').hidden, false);
        assert.equal(shadow.querySelector('.markdown-reader-font-size').hidden, false);
        assert.equal(shadow.querySelector('#mktero-document-actions').hidden, true);
        assert.equal(shadow.querySelector('#mktero-reparse').hidden, true);
        assert.equal(shadow.querySelector('#mktero-save-snapshot').hidden, true);
        assert.equal(shadow.querySelector('.cm-content').textContent, '');
    }
    finally {
        view.destroy();
    }
});

test('enhances code blocks in saved HTML snapshots', async () => {
    const copied = [];
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        renderMode: 'html',
        snapshotHTML: '<pre><code class="language-javascript">'
            + 'const answer = 42;\n'
            + '</code></pre>',
        snapshotAssets: [],
        onCopyCode: code => copied.push(code),
    }));

    try {
        const block = shadow.querySelector(
            '#mktero-snapshot .cm-mktero-code-block'
        );
        const code = block.querySelector('code');
        const copyButton = block.querySelector('[data-action="copy-code"]');
        assert.equal(
            block.querySelector('.cm-mktero-code-language').textContent,
            'javascript'
        );
        assert.ok(copyButton);
        copyButton.click();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(copied, ['const answer = 42;\n']);
        assert.equal(copyButton.textContent, 'Copied');

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(code.dataset.highlighted, 'true');
        assert.equal(code.textContent, 'const answer = 42;\n');
    }
    finally {
        view.destroy();
    }
});

test('sanitizes a modified snapshot before mounting it in the Zotero chrome', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        renderMode: 'html',
        snapshotHTML: '<script>window.pwned = true</script>'
            + '<img src="https://evil.example/image.png" onerror="alert(1)">'
            + '<a href="javascript:alert(1)">unsafe</a>'
            + '<a href="https://example.com">safe</a>',
        snapshotAssets: [],
        onReparse: null,
        onSaveSnapshot: null,
    }));

    try {
        const snapshot = shadow.querySelector('#mktero-snapshot');
        assert.equal(snapshot.querySelector('script'), null);
        assert.equal(snapshot.querySelector('img').getAttribute('src'), null);
        assert.equal(snapshot.querySelector('img').hasAttribute('onerror'), false);
        assert.equal(snapshot.querySelectorAll('a')[0].getAttribute('href'), null);
        assert.equal(
            snapshot.querySelectorAll('a')[1].getAttribute('href'),
            'https://example.com'
        );
    }
    finally {
        view.destroy();
    }
});

test('updates the visible annotation after Zotero saves a new color', async () => {
    const updates = [];
    const saved = [];
    let editorOptions;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Important result.',
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Important',
                comment: 'Review this',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
        async onChangeAnnotationColor(annotationID, color) {
            saved.push({ annotationID, color });
        },
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument(document) {
                    updates.push(document);
                },
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.changeAnnotationColor('HIGH0001', '#ff6666');

    assert.deepEqual(saved, [{
        annotationID: 'HIGH0001',
        color: '#ff6666',
    }]);
    assert.equal(model.annotationOverlay.matched[0].color, '#ff6666');
    assert.equal(
        updates.at(-1).annotationOverlay.matched[0].color,
        '#ff6666'
    );
    view.destroy();
});

test('updates the visible note after Zotero saves an annotation comment', async () => {
    const updates = [];
    const saved = [];
    let editorOptions;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Important result.',
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Important',
                comment: '',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
        async onUpdateAnnotationComment(annotationID, comment) {
            saved.push({ annotationID, comment });
        },
    });
    const { view, shadow } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument(document) {
                    updates.push(document);
                },
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.updateAnnotationComment(
        'HIGH0001',
        'Review this argument'
    );

    assert.deepEqual(saved, [{
        annotationID: 'HIGH0001',
        comment: 'Review this argument',
    }]);
    assert.equal(
        model.annotationOverlay.matched[0].comment,
        'Review this argument'
    );
    assert.equal(
        updates.at(-1).annotationOverlay.matched[0].comment,
        'Review this argument'
    );
    assert.match(
        shadow.querySelector('.markdown-notes-list').textContent,
        /Review this argument/
    );

    await editorOptions.updateAnnotationComment('HIGH0001', '');

    assert.deepEqual(saved.at(-1), {
        annotationID: 'HIGH0001',
        comment: '',
    });
    assert.equal(model.annotationOverlay.matched.length, 1);
    assert.equal(model.annotationOverlay.matched[0].comment, '');
    assert.doesNotMatch(
        shadow.querySelector('.markdown-notes-list').textContent,
        /Review this argument/
    );
    view.destroy();
});

test('creates and edits persistent local Markdown annotations', async () => {
    const updates = [];
    const actions = [];
    let editorOptions;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Important result.',
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: 17,
            locations: [{ pageIndex: 4, bbox: [100, 100, 900, 220] }],
        }],
        annotationOverlay: { matched: [], unmatched: [] },
        async onCreateMarkdownAnnotation(annotation) {
            actions.push({ action: 'create', annotation });
            return {
                ...annotation,
                id: 'mktero-local-1',
                source: 'markdown',
                type: 'highlight',
                matchKind: 'local',
                sortIndex: '000000000000',
            };
        },
        async onUpdateMarkdownAnnotation(annotationID, changes) {
            actions.push({ action: 'update', annotationID, changes });
            const current = model.annotationOverlay.matched.find(annotation => (
                annotation.id === annotationID
            ));
            return { ...current, ...changes };
        },
        async onDeleteMarkdownAnnotation(annotationID) {
            actions.push({ action: 'delete', annotationID });
        },
    });
    const { view, shadow } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument(document) {
                    updates.push(document);
                },
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.createMarkdownAnnotation({
        text: 'Important',
        comment: '',
        color: '#ffd400',
        ranges: [{ from: 0, to: 9 }],
    });
    await editorOptions.updateAnnotationComment(
        'mktero-local-1',
        'Local note'
    );
    await editorOptions.changeAnnotationColor(
        'mktero-local-1',
        '#ff6666'
    );

    assert.equal(model.annotationOverlay.matched[0].comment, 'Local note');
    assert.equal(model.annotationOverlay.matched[0].color, '#ff6666');
    assert.match(shadow.querySelector('.markdown-notes-list').textContent, /Local note/);
    assert.deepEqual(actions.map(({ action }) => action), [
        'create',
        'update',
        'update',
    ]);
    assert.equal(actions[0].annotation.pdfPageIndexHint, 4);
    assert.equal(updates.at(-1).annotationOverlay.matched[0].source, 'markdown');

    await editorOptions.deleteAnnotation('mktero-local-1');

    assert.deepEqual(actions.at(-1), {
        action: 'delete',
        annotationID: 'mktero-local-1',
    });
    assert.deepEqual(model.annotationOverlay.matched, []);
    view.destroy();
});

test('adds visible surrounding text to a new Markdown annotation', async () => {
    const created = [];
    let editorOptions;
    const markdown = '**SUMMARY ANSWER:** Repeated result for this study.';
    const from = markdown.indexOf('Repeated result');
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown,
        annotationOverlay: { matched: [], unmatched: [] },
        async onCreateMarkdownAnnotation(annotation) {
            created.push(annotation);
            return {
                ...annotation,
                id: 'mktero-local-1',
                source: 'markdown',
                type: 'highlight',
                matchKind: 'local',
                sortIndex: String(from).padStart(12, '0'),
            };
        },
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.createMarkdownAnnotation({
        text: 'Repeated result',
        comment: '',
        color: '#ffd400',
        ranges: [{ from, to: from + 'Repeated result'.length }],
    });

    assert.deepEqual(created[0].textQuote, {
        prefix: 'SUMMARY ANSWER: ',
        suffix: ' for this study.',
    });
    view.destroy();
});

test('rejects Markdown annotations created from the translation view', async () => {
    const created = [];
    let editorOptions;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Original text.',
        translationStatus: 'ready',
        translationView: 'translated',
        translatedMarkdown: '译文。',
        translationTargetLanguage: 'zh-CN',
        async onCreateMarkdownAnnotation(annotation) {
            created.push(annotation);
            return annotation;
        },
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await assert.rejects(
        editorOptions.createMarkdownAnnotation({
            text: '译文',
            color: '#ffd400',
            ranges: [{ from: 0, to: 2 }],
        }),
        /require original text/
    );
    assert.deepEqual(created, []);
    view.destroy();
});

test('removes the visible annotation after Zotero deletes it', async () => {
    const deleted = [];
    let editorOptions;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Important result.',
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Important',
                comment: 'Review this',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
        async onDeleteAnnotation(annotationID) {
            deleted.push(annotationID);
        },
    });
    const { view, shadow } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            return {
                setDocument() {},
                refreshRendering() {},
                destroy() {},
            };
        },
    });

    await editorOptions.deleteAnnotation('HIGH0001');

    assert.deepEqual(deleted, ['HIGH0001']);
    assert.deepEqual(model.annotationOverlay, { matched: [], unmatched: [] });
    assert.match(
        shadow.querySelector('.markdown-notes-list').textContent,
        /No notes/
    );
    view.destroy();
});

test('resizes and toggles the Markdown outline from its edge', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Overview\n\n## Methods',
        sourceKind: 'markdown',
    }));
    const outline = shadow.querySelector('#mktero-outline');
    const resizer = shadow.querySelector('#mktero-outline-resizer');
    const toggle = shadow.querySelector('#mktero-outline-toggle');

    try {
        assert.ok(resizer);
        assert.ok(toggle);
        assert.equal(resizer.contains(toggle), false);
        assert.equal(resizer.parentElement, toggle.parentElement);
        assert.equal(resizer.getAttribute('role'), 'separator');
        assert.equal(resizer.getAttribute('aria-controls'), 'mktero-outline');
        assert.equal(resizer.getAttribute('aria-orientation'), 'vertical');
        assert.equal(resizer.getAttribute('aria-valuemin'), '180');
        assert.equal(resizer.getAttribute('aria-valuemax'), '480');
        assert.equal(resizer.getAttribute('aria-valuenow'), '256');
        assert.equal(toggle.textContent, '');
        assert.equal(
            toggle.querySelector('svg')?.getAttribute('data-lucide'),
            'chevron-left'
        );
        assert.equal(toggle.getAttribute('aria-controls'), 'mktero-outline');
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(toggle.getAttribute('aria-label'), 'Collapse outline');
        assert.equal(outline.hidden, false);

        dispatchMouseEvent(resizer, 'mousedown', 256);
        dispatchMouseEvent(document.defaultView, 'mousemove', 376);
        dispatchMouseEvent(document.defaultView, 'mouseup', 376);

        assert.equal(resizer.getAttribute('aria-valuenow'), '376');
        assert.equal(
            outline.style.getPropertyValue('--outline-width'),
            '376px'
        );

        dispatchMouseEvent(toggle, 'mousedown', 376);
        dispatchMouseEvent(document.defaultView, 'mousemove', 416);
        dispatchMouseEvent(document.defaultView, 'mouseup', 416);
        assert.equal(resizer.getAttribute('aria-valuenow'), '376');

        dispatchKeyboardEvent(toggle, 'ArrowRight');
        dispatchKeyboardEvent(toggle, 'Enter');
        assert.equal(resizer.getAttribute('aria-valuenow'), '376');
        assert.equal(outline.hidden, false);

        toggle.click();
        assert.equal(outline.hidden, true);
        assert.equal(toggle.textContent, '');
        assert.equal(
            toggle.querySelector('svg')?.getAttribute('data-lucide'),
            'chevron-right'
        );
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(toggle.getAttribute('aria-label'), 'Expand outline');
        assert.equal(resizer.getAttribute('aria-label'), 'Expand outline');

        toggle.click();
        assert.equal(outline.hidden, false);
        assert.equal(toggle.textContent, '');
        assert.equal(
            toggle.querySelector('svg')?.getAttribute('data-lucide'),
            'chevron-left'
        );
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(resizer.getAttribute('aria-valuenow'), '376');
        assert.equal(
            outline.style.getPropertyValue('--outline-width'),
            '376px'
        );

        resizer.dispatchEvent(new document.defaultView.Event('dblclick', {
            bubbles: true,
            cancelable: true,
        }));
        assert.equal(outline.hidden, true);
    }
    finally {
        view.destroy();
    }
});

test('resizes and toggles PDF notes from the right edge', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');
    const toggle = shadow.querySelector('#mktero-notes-toggle');

    try {
        assert.ok(notes);
        assert.ok(resizer);
        assert.ok(toggle);
        assert.equal(resizer.parentElement, toggle.parentElement);
        assert.equal(resizer.getAttribute('role'), 'separator');
        assert.equal(resizer.getAttribute('aria-controls'), 'mktero-notes');
        assert.equal(resizer.getAttribute('aria-orientation'), 'vertical');
        assert.equal(resizer.getAttribute('aria-valuemin'), '220');
        assert.equal(resizer.getAttribute('aria-valuemax'), '480');
        assert.equal(resizer.getAttribute('aria-valuenow'), '300');
        assert.equal(toggle.textContent, '');
        assert.equal(
            toggle.querySelector('svg')?.getAttribute('data-lucide'),
            'chevron-right'
        );
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(toggle.getAttribute('aria-label'), 'Collapse notes');
        assert.equal(notes.hidden, false);

        dispatchMouseEvent(resizer, 'mousedown', 1000);
        dispatchMouseEvent(document.defaultView, 'mousemove', 900);
        dispatchMouseEvent(document.defaultView, 'mouseup', 900);

        assert.equal(resizer.getAttribute('aria-valuenow'), '400');
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '400px'
        );

        dispatchKeyboardEvent(resizer, 'ArrowRight');
        assert.equal(resizer.getAttribute('aria-valuenow'), '384');
        dispatchKeyboardEvent(resizer, 'ArrowLeft');
        assert.equal(resizer.getAttribute('aria-valuenow'), '400');
        dispatchKeyboardEvent(resizer, 'Home');
        assert.equal(resizer.getAttribute('aria-valuenow'), '220');
        dispatchKeyboardEvent(resizer, 'End');
        assert.equal(resizer.getAttribute('aria-valuenow'), '480');

        toggle.click();
        assert.equal(notes.hidden, true);
        assert.equal(toggle.textContent, '');
        assert.equal(
            toggle.querySelector('svg')?.getAttribute('data-lucide'),
            'chevron-left'
        );
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(toggle.getAttribute('aria-label'), 'Expand notes');
        assert.equal(resizer.getAttribute('aria-label'), 'Expand notes');

        toggle.click();
        assert.equal(notes.hidden, false);
        assert.equal(toggle.textContent, '');
        assert.equal(
            toggle.querySelector('svg')?.getAttribute('data-lucide'),
            'chevron-right'
        );
        assert.equal(resizer.getAttribute('aria-valuenow'), '480');

        resizer.dispatchEvent(new document.defaultView.Event('dblclick', {
            bubbles: true,
            cancelable: true,
        }));
        assert.equal(notes.hidden, true);
    }
    finally {
        view.destroy();
    }
});

test('does not resize PDF notes during a vertical scrollbar drag', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');

    try {
        dispatchMouseEvent(resizer, 'mousedown', 1000, 300);
        dispatchMouseEvent(document.defaultView, 'mousemove', 1014, 420);
        dispatchMouseEvent(document.defaultView, 'mouseup', 1014, 420);

        assert.equal(resizer.getAttribute('aria-valuenow'), '300');
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '300px'
        );
    }
    finally {
        view.destroy();
    }
});

test('cancels a notes resize when a gesture becomes vertical', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');

    try {
        dispatchMouseEvent(resizer, 'mousedown', 1000, 300);
        dispatchMouseEvent(document.defaultView, 'mousemove', 1010, 300);
        dispatchMouseEvent(document.defaultView, 'mousemove', 1012, 420);
        dispatchMouseEvent(document.defaultView, 'mouseup', 1012, 420);

        assert.equal(resizer.getAttribute('aria-valuenow'), '300');
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '300px'
        );
    }
    finally {
        view.destroy();
    }
});

test('cancels an accidental notes resize when the editor starts scrolling', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');
    const scroller = shadow.querySelector('.cm-scroller');

    try {
        dispatchMouseEvent(resizer, 'mousedown', 1000, 300);
        dispatchMouseEvent(document.defaultView, 'mousemove', 1010, 300);
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '290px'
        );

        scroller.dispatchEvent(new document.defaultView.Event('scroll'));
        dispatchMouseEvent(document.defaultView, 'mousemove', 1080, 300);
        dispatchMouseEvent(document.defaultView, 'mouseup', 1080, 300);

        assert.equal(resizer.getAttribute('aria-valuenow'), '300');
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '300px'
        );
    }
    finally {
        view.destroy();
    }
});

test('cancels a notes resize when an outer editor container starts scrolling', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');
    const workspace = shadow.querySelector('.markdown-workspace');

    try {
        dispatchMouseEvent(resizer, 'mousedown', 1000, 300);
        dispatchMouseEvent(document.defaultView, 'mousemove', 1010, 300);
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '290px'
        );

        workspace.dispatchEvent(new document.defaultView.Event('scroll'));
        dispatchMouseEvent(document.defaultView, 'mousemove', 1080, 300);
        dispatchMouseEvent(document.defaultView, 'mouseup', 1080, 300);

        assert.equal(resizer.getAttribute('aria-valuenow'), '300');
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '300px'
        );
    }
    finally {
        view.destroy();
    }
});

test('cancels a notes resize when the primary pointer button is released', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');

    try {
        dispatchMouseEvent(resizer, 'mousedown', 1000, 300);
        dispatchMouseEvent(document.defaultView, 'mousemove', 1010, 300, 1);
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '290px'
        );

        dispatchMouseEvent(document.defaultView, 'mousemove', 1080, 300, 0);
        dispatchMouseEvent(document.defaultView, 'mouseup', 1080, 300, 0);

        assert.equal(resizer.getAttribute('aria-valuenow'), '300');
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '300px'
        );
    }
    finally {
        view.destroy();
    }
});

test('cancels a notes resize when the owning document starts scrolling', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');

    try {
        dispatchMouseEvent(resizer, 'mousedown', 1000, 300);
        dispatchMouseEvent(document.defaultView, 'mousemove', 1010, 300);
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '290px'
        );

        document.dispatchEvent(new document.defaultView.Event('scroll'));
        dispatchMouseEvent(document.defaultView, 'mousemove', 1080, 300);
        dispatchMouseEvent(document.defaultView, 'mouseup', 1080, 300);

        assert.equal(resizer.getAttribute('aria-valuenow'), '300');
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '300px'
        );
    }
    finally {
        view.destroy();
    }
});

test('cancels a notes resize when a move loses its vertical coordinate', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');

    try {
        dispatchMouseEvent(resizer, 'mousedown', 1000, 300);
        const event = new document.defaultView.Event('mousemove', {
            bubbles: true,
            cancelable: true,
        });
        Object.defineProperties(event, {
            button: { value: 0 },
            clientX: { value: 1010 },
        });
        document.defaultView.dispatchEvent(event);
        dispatchMouseEvent(document.defaultView, 'mouseup', 1010, 300);

        assert.equal(resizer.getAttribute('aria-valuenow'), '300');
        assert.equal(
            notes.style.getPropertyValue('--notes-width'),
            '300px'
        );
    }
    finally {
        view.destroy();
    }
});

test('removes side panel scroll listeners when the view is destroyed', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Annotated text',
        sourceKind: 'markdown',
    }));
    const notes = shadow.querySelector('#mktero-notes');
    const resizer = shadow.querySelector('#mktero-notes-resizer');
    const workspace = shadow.querySelector('.markdown-workspace');

    dispatchMouseEvent(resizer, 'mousedown', 1000, 300);
    dispatchMouseEvent(document.defaultView, 'mousemove', 1010, 300);
    view.destroy();

    workspace.dispatchEvent(new document.defaultView.Event('scroll'));

    assert.equal(
        notes.style.getPropertyValue('--notes-width'),
        '290px'
    );
});

test('collapses side panels responsively and restores automatic changes', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Overview\n\n## Methods',
        sourceKind: 'markdown',
    }), {}, {
        configureWindow(window) {
            Object.defineProperty(window, 'innerWidth', {
                configurable: true,
                value: 800,
                writable: true,
            });
        },
    });
    const outline = shadow.querySelector('#mktero-outline');
    const notes = shadow.querySelector('#mktero-notes');
    const outlineToggle = shadow.querySelector('#mktero-outline-toggle');
    const notesToggle = shadow.querySelector('#mktero-notes-toggle');

    try {
        assert.equal(outline.hidden, true);
        assert.equal(notes.hidden, true);
        assert.equal(outlineToggle.getAttribute('aria-label'), 'Expand outline');
        assert.equal(notesToggle.getAttribute('aria-label'), 'Expand notes');

        outlineToggle.click();
        assert.equal(outline.hidden, false);
        assert.equal(outlineToggle.getAttribute('aria-label'), 'Collapse outline');

        document.defaultView.dispatchEvent(new document.defaultView.Event('resize'));
        assert.equal(outline.hidden, false);

        document.defaultView.innerWidth = 900;
        document.defaultView.dispatchEvent(new document.defaultView.Event('resize'));
        assert.equal(outline.hidden, false);
        assert.equal(notes.hidden, true);

        document.defaultView.innerWidth = 1200;
        document.defaultView.dispatchEvent(new document.defaultView.Event('resize'));
        assert.equal(outline.hidden, false);
        assert.equal(notes.hidden, false);
    }
    finally {
        view.destroy();
    }
});

test('isolates responsive panels across windows and cleans up resize listeners', () => {
    const first = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# First',
        sourceKind: 'markdown',
    }), {}, {
        configureWindow(window) {
            Object.defineProperty(window, 'innerWidth', {
                configurable: true,
                value: 800,
                writable: true,
            });
        },
    });
    const second = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Second',
        sourceKind: 'markdown',
    }), {}, {
        configureWindow(window) {
            Object.defineProperty(window, 'innerWidth', {
                configurable: true,
                value: 1200,
                writable: true,
            });
        },
    });

    try {
        assert.equal(first.shadow.querySelector('#mktero-outline').hidden, true);
        assert.equal(first.shadow.querySelector('#mktero-notes').hidden, true);
        assert.equal(second.shadow.querySelector('#mktero-outline').hidden, false);
        assert.equal(second.shadow.querySelector('#mktero-notes').hidden, false);
    }
    finally {
        first.view.destroy();
        first.document.defaultView.innerWidth = 1200;
        first.document.defaultView.dispatchEvent(
            new first.document.defaultView.Event('resize')
        );
        assert.equal(first.shadow.querySelector('#mktero-outline').hidden, true);
        assert.equal(first.shadow.querySelector('#mktero-notes').hidden, true);
        second.view.destroy();
    }
});

test('uses the measured Markdown container width for responsive panels', () => {
    let resizeObserverCallback;
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper',
        sourceKind: 'markdown',
    }), {}, {
        configureWindow(window) {
            Object.defineProperty(window, 'innerWidth', {
                configurable: true,
                value: 1400,
                writable: true,
            });
            window.ResizeObserver = class ResizeObserver {
                constructor(callback) {
                    resizeObserverCallback = callback;
                }

                observe() {}

                disconnect() {}
            };
        },
    });
    const outline = shadow.querySelector('#mktero-outline');
    const notes = shadow.querySelector('#mktero-notes');

    try {
        assert.equal(outline.hidden, false);
        assert.equal(notes.hidden, false);

        resizeObserverCallback([{ contentRect: { width: 800 } }]);
        assert.equal(outline.hidden, true);
        assert.equal(notes.hidden, true);

        resizeObserverCallback([{ contentRect: { width: 900 } }]);
        assert.equal(outline.hidden, false);
        assert.equal(notes.hidden, true);
    }
    finally {
        view.destroy();
        assert.equal(typeof resizeObserverCallback, 'function');
        document.defaultView.close?.();
    }
});

test('tracks the active outline and note while the editor viewport changes', () => {
    const markdown = '# Overview\n\nIntro.\n\n## Methods\n\nMethod text.';
    let editorOptions;
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Method text.',
                comment: '',
                color: '#ffd400',
                pageLabel: '1',
                ranges: [{ from: markdown.indexOf('Method text.'), to: markdown.length }],
            }],
            unmatched: [],
        },
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            editorOptions = options;
            return createTestInlineEditor(options);
        },
    });
    const outlineLinks = [...shadow.querySelectorAll('.markdown-outline-link')];
    const noteLink = shadow.querySelector('.markdown-note-link');

    try {
        assert.equal(outlineLinks[0].classList.contains('is-active'), true);
        assert.equal(outlineLinks[0].getAttribute('aria-current'), 'location');
        assert.equal(outlineLinks[1].classList.contains('is-active'), false);
        assert.equal(noteLink.classList.contains('is-active'), false);

        editorOptions.onViewportChange(markdown.indexOf('Method text.'));

        assert.equal(outlineLinks[0].classList.contains('is-active'), false);
        assert.equal(outlineLinks[1].classList.contains('is-active'), true);
        assert.equal(outlineLinks[1].getAttribute('aria-current'), 'location');
        assert.equal(noteLink.classList.contains('is-active'), true);
        assert.equal(noteLink.getAttribute('aria-current'), 'location');
    }
    finally {
        view.destroy();
    }
});

test('restores the current Markdown position after a reparse replaces the document', () => {
    const initialMarkdown = [
        '# Overview',
        '',
        'Original overview.',
        '',
        '# Methods',
        '',
        'Original methods.',
    ].join('\n');
    const replacementMarkdown = [
        '# Overview',
        '',
        'Added overview context.',
        '',
        '# Methods',
        '',
        'New methods.',
        '',
        '## Results',
    ].join('\n');
    const scrolledOffsets = [];
    let editorOptions;
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: initialMarkdown,
        sourceKind: 'markdown',
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            const editor = createTestInlineEditor(options);
            editor.scrollToOffset = offset => scrolledOffsets.push(offset);
            return editor;
        },
    });

    const activeOffset = initialMarkdown.indexOf('Original methods.');
    editorOptions.onViewportChange(activeOffset);
    view.render({
        ...model,
        status: 'loading',
        progress: 30,
        preserveContent: true,
    });
    view.render({
        ...model,
        status: 'ready',
        progress: 100,
        markdown: replacementMarkdown,
        sourceKind: 'markdown',
    });

    assert.deepEqual(scrolledOffsets, [replacementMarkdown.indexOf('New methods.')]);

    view.render({
        ...model,
        status: 'ready',
        progress: 100,
        markdown: replacementMarkdown,
        sourceKind: 'markdown',
        annotationOverlay: {
            matched: [{ id: 'updated' }],
            unmatched: [],
        },
    });
    assert.deepEqual(scrolledOffsets, [replacementMarkdown.indexOf('New methods.')]);
    view.destroy();
});

test('uses the previous block ranges when a retry changes translation lengths', () => {
    const scrolledOffsets = [];
    let editorOptions;
    const oldRanges = [{
        id: 'first',
        sourceFrom: 0,
        sourceTo: 5,
        translatedFrom: 0,
        translatedTo: 5,
        comparisonSourceFrom: 0,
        comparisonSourceTo: 5,
        comparisonTranslationFrom: 7,
        comparisonTranslationTo: 12,
    }, {
        id: 'second',
        sourceFrom: 7,
        sourceTo: 17,
        translatedFrom: 7,
        translatedTo: 17,
        comparisonSourceFrom: 14,
        comparisonSourceTo: 24,
        comparisonTranslationFrom: 26,
        comparisonTranslationTo: 36,
    }];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: `${'S'.repeat(5)}\n\n${'T'.repeat(10)}`,
        sourceKind: 'markdown',
        translationStatus: 'partial',
        translationView: 'translated',
        translationBlocks: [{ id: 'first' }, { id: 'second' }],
        translationFailedBlocks: [{ id: 'first' }],
        translatedMarkdown: `${'A'.repeat(5)}\n\n${'B'.repeat(10)}`,
        comparisonMarkdown: '',
        translationBlockRanges: oldRanges,
    });
    const { view } = createView(model, {}, {
        editorFactory(options) {
            editorOptions = options;
            const editor = createTestInlineEditor(options);
            editor.scrollToOffset = offset => scrolledOffsets.push(offset);
            return editor;
        },
    });

    editorOptions.onViewportChange(10);
    view.render({
        ...model,
        translationStatus: 'ready',
        translationFailedBlocks: [],
        translatedMarkdown: `${'C'.repeat(30)}\n\n${'D'.repeat(20)}`,
        translationBlockRanges: [{
            ...oldRanges[0],
            translatedTo: 30,
        }, {
            ...oldRanges[1],
            translatedFrom: 32,
            translatedTo: 52,
        }],
    });

    assert.deepEqual(scrolledOffsets, [38]);
    view.destroy();
});

test('shows PDF notes safely and jumps matched notes to Markdown', () => {
    const scrolledOffsets = [];
    const annotationOverlay = {
        matched: [{
            id: 'HIGH0001',
            type: 'highlight',
            text: 'Important result',
            comment: '<img src=x onerror=alert(1)> Review this',
            color: '#ffd400',
            pageLabel: '4',
            pageIndex: 3,
            sortIndex: '00002',
            ranges: [{ from: 12, to: 28 }],
        }],
        unmatched: [{
            id: 'UNDER001',
            type: 'underline',
            text: 'Missing result',
            comment: 'Needs follow-up',
            color: '#2ea8e5',
            pageLabel: '',
            pageIndex: 1,
            sortIndex: '00001',
            reason: 'not-found',
        }],
    };
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Before text Important result after text.',
        annotationOverlay,
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            const editor = createTestInlineEditor(options);
            editor.scrollToOffset = offset => scrolledOffsets.push(offset);
            return editor;
        },
    });
    const notes = shadow.querySelector('#mktero-notes');
    const buttons = [...notes.querySelectorAll('.markdown-note-link')];

    try {
        assert.equal(notes.getAttribute('aria-label'), 'Notes');
        assert.equal(
            notes.querySelector('.markdown-notes-title').textContent,
            'Notes'
        );
        assert.equal(buttons.length, 2);
        assert.equal(buttons[0].hasAttribute('disabled'), true);
        assert.match(buttons[0].textContent, /Page 2/);
        assert.match(buttons[0].textContent, /Missing result/);
        assert.match(buttons[0].textContent, /Not found in Markdown/);
        assert.equal(buttons[1].hasAttribute('disabled'), false);
        assert.match(buttons[1].textContent, /Page 4/);
        assert.match(buttons[1].textContent, /Important result/);
        assert.match(
            buttons[1].textContent,
            /<img src=x onerror=alert\(1\)> Review this/
        );
        assert.equal(buttons[1].querySelector('img'), null);
        assert.match(
            buttons[1].querySelector('.markdown-note-color')
                .getAttribute('style'),
            /--mktero-annotation-color:\s*#ffd400/
        );

        buttons[1].dispatchEvent(new document.defaultView.Event('click', {
            bubbles: true,
        }));
        assert.deepEqual(scrolledOffsets, [12]);

        view.render(createModel({
            status: 'ready',
            progress: 100,
            markdown: 'Updated note',
            annotationOverlay: {
                matched: [{
                    id: 'HIGH0002',
                    type: 'highlight',
                    text: 'Updated',
                    comment: '',
                    color: '#a28ae5',
                    pageLabel: '5',
                    pageIndex: 4,
                    sortIndex: '00001',
                    ranges: [{ from: 0, to: 7 }],
                }],
                unmatched: [],
            },
            sourceKind: 'markdown',
        }));
        const updated = notes.querySelectorAll('.markdown-note-link');
        assert.equal(updated.length, 1);
        assert.match(updated[0].textContent, /Updated/);
        updated[0].dispatchEvent(new document.defaultView.Event('click', {
            bubbles: true,
        }));
        assert.deepEqual(scrolledOffsets, [12, 12, 0]);
    }
    finally {
        view.destroy();
    }
});

test('labels ambiguous PDF notes separately from missing notes', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Repeated result.',
        annotationOverlay: {
            matched: [],
            unmatched: [{
                id: 'AMBIGUOUS01',
                type: 'highlight',
                text: 'Repeated result',
                comment: '',
                color: '#ffd400',
                pageLabel: '1',
                pageIndex: 0,
                sortIndex: '00001',
                reason: 'ambiguous',
            }],
        },
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            return createTestInlineEditor(options);
        },
    });

    try {
        const note = shadow.querySelector('.markdown-note-link');
        assert.equal(note?.hasAttribute('disabled'), true);
        assert.match(note?.textContent || '', /Multiple matches in Markdown/);
        assert.doesNotMatch(note?.textContent || '', /Not found in Markdown/);
    }
    finally {
        view.destroy();
    }
});

test('opens Zotero annotations in PDF from the notes panel', async () => {
    const opened = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Matched PDF note and pending local note.',
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Matched PDF note',
                comment: '',
                color: '#ffd400',
                pageLabel: '3',
                pageIndex: 2,
                sortIndex: '00001',
                ranges: [{ from: 0, to: 16 }],
            }, {
                id: 'mktero-pending-1',
                source: 'markdown',
                type: 'highlight',
                text: 'pending local note',
                comment: '',
                color: '#2ea8e5',
                ranges: [{ from: 21, to: 39 }],
                synchronization: { status: 'pending' },
            }],
            unmatched: [{
                id: 'UNDER001',
                type: 'underline',
                text: 'Missing PDF note',
                comment: '',
                color: '#2ea8e5',
                pageLabel: '7',
                pageIndex: 6,
                sortIndex: '00002',
                reason: 'not-found',
            }],
        },
        sourceKind: 'markdown',
        async onOpenAnnotationInPDF(annotationID) {
            opened.push(annotationID);
        },
    });
    const { document, view, shadow } = createView(model);

    try {
        const buttons = [
            ...shadow.querySelectorAll('.markdown-note-open-pdf'),
        ];
        assert.equal(buttons.length, 2);
        assert.deepEqual(
            buttons.map(button => button.getAttribute('data-annotation-id')),
            ['HIGH0001', 'UNDER001']
        );
        assert.equal(buttons[0].getAttribute('aria-label'), 'View in PDF');
        assert.equal(
            buttons[0].querySelector('svg')?.getAttribute('data-lucide'),
            'external-link'
        );

        buttons[1].dispatchEvent(new document.defaultView.Event('click', {
            bubbles: true,
        }));
        await Promise.resolve();
        await Promise.resolve();

        assert.deepEqual(opened, ['UNDER001']);
    }
    finally {
        view.destroy();
    }
});

test('shows local annotation synchronization status and retries failures', async () => {
    const retryCalls = [];
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Pending note and failed note.',
        annotationOverlay: {
            matched: [{
                id: 'mktero-pending-1',
                source: 'markdown',
                type: 'highlight',
                text: 'Pending note',
                comment: '',
                color: '#ffd400',
                ranges: [{ from: 0, to: 12 }],
                synchronization: { status: 'pending' },
            }, {
                id: 'mktero-failed-1',
                source: 'markdown',
                type: 'highlight',
                text: 'failed note',
                comment: '',
                color: '#ff6666',
                ranges: [{ from: 17, to: 28 }],
                synchronization: {
                    status: 'failed',
                    reason: 'text-not-found',
                },
            }],
            unmatched: [],
        },
        sourceKind: 'markdown',
        async onRetryMarkdownAnnotationSynchronization(annotationID) {
            retryCalls.push(annotationID);
            return {
                id: annotationID,
                synchronization: { status: 'pending' },
            };
        },
    });
    const { document, view, shadow } = createView(model);

    try {
        assert.equal(
            shadow.querySelectorAll('.markdown-note-sync').length,
            2
        );
        const pending = shadow.querySelector('.markdown-note-sync--pending');
        const failed = shadow.querySelector('.markdown-note-sync--failed');
        assert.match(pending.textContent, /Pending Zotero sync/);
        assert.equal(
            pending.querySelector('svg')?.getAttribute('data-lucide'),
            'clock'
        );
        assert.match(failed.textContent, /PDF text not found/);
        assert.equal(
            failed.querySelector('svg')?.getAttribute('data-lucide'),
            'triangle-alert'
        );

        const retry = shadow.querySelector('.markdown-note-sync-retry');
        assert.equal(retry.getAttribute('type'), 'button');
        assert.equal(retry.getAttribute('data-annotation-id'), 'mktero-failed-1');
        assert.equal(retry.getAttribute('aria-label'), 'Retry Zotero sync');
        assert.equal(
            retry.querySelector('svg')?.getAttribute('data-lucide'),
            'refresh-cw'
        );

        retry.dispatchEvent(new document.defaultView.Event('click', {
            bubbles: true,
        }));
        await Promise.resolve();
        await Promise.resolve();

        assert.deepEqual(retryCalls, ['mktero-failed-1']);
        assert.equal(
            shadow.querySelectorAll('.markdown-note-sync-retry').length,
            0
        );
        assert.equal(
            shadow.querySelectorAll('.markdown-note-sync--pending').length,
            2
        );
    }
    finally {
        view.destroy();
    }
});

test('shows when the local PDF index is unavailable', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Selected text',
        annotationOverlay: {
            matched: [{
                id: 'mktero-failed-1',
                source: 'markdown',
                type: 'highlight',
                text: 'Selected text',
                comment: '',
                color: '#ffd400',
                ranges: [{ from: 0, to: 13 }],
                synchronization: {
                    status: 'failed',
                    reason: 'pdf-index-unavailable',
                },
            }],
            unmatched: [],
        },
        sourceKind: 'markdown',
    }));

    try {
        assert.match(
            shadow.querySelector('.markdown-note-sync--failed').textContent,
            /Local PDF index unavailable/
        );
    }
    finally {
        view.destroy();
    }
});

test('shows a live Markdown outline and scrolls to the selected heading', () => {
    const markdown = '# Overview\n\n## Methods\n\n### Results';
    const scrolledOffsets = [];
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown,
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            const editor = createTestInlineEditor(options);
            editor.scrollToOffset = offset => scrolledOffsets.push(offset);
            return editor;
        },
    });
    const outline = shadow.querySelector('#mktero-outline');
    const buttons = [...outline.querySelectorAll('.markdown-outline-link')];

    assert.equal(outline.getAttribute('aria-label'), 'Markdown outline');
    assert.equal(shadow.querySelector('.markdown-outline-title').textContent, 'Outline');
    assert.deepEqual(buttons.map(button => button.textContent), [
        'Overview',
        'Methods',
        'Results',
    ]);
    assert.deepEqual(buttons.map(button => button.getAttribute('data-level')), [
        '1',
        '2',
        '3',
    ]);
    assert.deepEqual(buttons.map(button => button.getAttribute('style')), [
        '--outline-indent: 0px;',
        '--outline-indent: 12px;',
        '--outline-indent: 24px;',
    ]);

    buttons[1].dispatchEvent(new document.defaultView.Event('click', { bubbles: true }));
    assert.deepEqual(scrolledOffsets, [markdown.indexOf('## Methods')]);

    view.render(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Renamed\n\n## Updated',
        sourceKind: 'markdown',
    }));
    assert.deepEqual(
        [...outline.querySelectorAll('.markdown-outline-link')]
            .map(button => button.textContent),
        ['Renamed', 'Updated']
    );
    view.destroy();
});

test('shows an empty outline state when Markdown has no headings', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: 'Paragraph only.',
        sourceKind: 'markdown',
    }));

    assert.equal(shadow.querySelectorAll('.markdown-outline-link').length, 0);
    assert.equal(shadow.querySelector('.markdown-outline-empty').textContent, 'No headings');
    assert.equal(shadow.querySelectorAll('.markdown-note-link').length, 0);
    assert.equal(shadow.querySelector('.markdown-notes-empty').textContent, 'No notes');
    view.destroy();
});

test('mounts the Markdown UI in an isolated inline shadow root', () => {
    const { view, shadow } = createView();

    assert.equal(view.root.localName, 'div');
    assert.equal(view.root.getAttribute('role'), 'region');
    assert.equal(shadow.querySelector('link[rel="stylesheet"]'), null);
    assert.equal(
        shadow.querySelector('style[data-mktero-styles="embedded"]').textContent,
        MARKDOWN_STYLES
    );
    assert.equal(shadow.querySelector('#mktero-loading').getAttribute('role'), 'status');
    assert.equal(shadow.querySelector('#mktero-status'), null);
    assert.equal(shadow.querySelector('#mktero-save-status'), null);
    assert.equal(shadow.querySelector('#mktero-title'), null);
    assert.ok(shadow.querySelector('#mktero-reparse'));
    assert.equal(shadow.querySelector('.markdown-reader-actions').hidden, true);
    assert.equal(shadow.querySelector('#mktero-copy'), null);
    assert.equal(shadow.querySelector('#mktero-show-preview'), null);
    assert.equal(shadow.querySelector('#mktero-show-source'), null);
    assert.ok(!shadow.querySelector('.app-header'));
    assert.ok(!shadow.querySelector('.source-actions'));
    assert.ok(!shadow.querySelector('#mktero-editor-toolbar'));
    assert.ok(shadow.querySelector('#mktero-editor .cm-content'));
    assert.equal(shadow.querySelector('.markdown-workspace').hidden, true);
    assert.ok(shadow.querySelector('#mktero-outline-resizer'));
    assert.ok(shadow.querySelector('#mktero-notes-resizer'));
    assert.ok(!shadow.querySelector('#mktero-toggle-outline'));
    assert.ok(!shadow.querySelector('#mktero-save'));
    view.destroy();
});

test('embeds bundled CSS directly in the Markdown shadow root', () => {
    const stylesheetText = ':host { color: rgb(12 34 56); }';
    const { shadow } = createView(createModel(), {}, { stylesheetText });

    assert.equal(shadow.querySelector('link[rel="stylesheet"]'), null);
    assert.equal(
        shadow.querySelector('style[data-mktero-styles="embedded"]').textContent,
        stylesheetText
    );
});

test('fails clearly when bundled Markdown CSS is unavailable', () => {
    assert.throws(
        () => createView(createModel(), {}, { stylesheetText: '' }),
        /bundled Markdown styles are unavailable/
    );
});

test('uses a flexing XUL layout root in the Zotero main document', () => {
    const xulCalls = [];
    const { view } = createView(createModel(), {}, { xul: true, xulCalls });

    assert.equal(view.root.localName, 'vbox');
    assert.deepEqual(xulCalls, ['vbox']);
    assert.equal(view.root.getAttribute('data-test-xul-element'), 'true');
    assert.equal(view.root.getAttribute('flex'), '1');
    assert.equal(view.root.firstElementChild, view.host);
    assert.ok(view.host.shadowRoot.querySelector('#mktero-loading'));
    view.destroy();
});

test('replaces loading state with cached Markdown as soon as the model is ready', () => {
    const { view, shadow } = createView();

    view.render(createModel({
        title: 'Example Paper',
        status: 'ready',
        progress: 100,
        markdown: '# Example Paper\n\nConverted.',
        sourceKind: 'markdown',
        cacheHit: true,
    }));

    assert.equal(shadow.querySelector('#mktero-loading').hidden, true);
    assert.equal(shadow.querySelector('.markdown-workspace').hidden, false);
    assert.equal(shadow.querySelector('#mktero-status'), null);
    assert.equal(
        shadow.querySelector('.cm-content').textContent,
        '# Example Paper\n\nConverted.'
    );
    view.destroy();
});

test('updates conversion progress directly in the inline view', () => {
    const { view, shadow } = createView();

    view.render(createModel({ progress: 10 }));

    const spinner = shadow.querySelector('.loading-spinner');
    assert.equal(spinner?.localName, 'svg');
    assert.equal(spinner?.getAttribute('data-lucide'), 'loader-circle');
    assert.equal(
        shadow.querySelector('#mktero-loading-detail').textContent,
        'The PDF is being converted to Markdown.'
    );
    assert.equal(shadow.querySelector('#mktero-loading-progress').value, 10);
    assert.equal(shadow.querySelector('#mktero-loading-progress-label').textContent, '10%');
});

test('localizes the Markdown viewer chrome from the Zotero locale', () => {
    const localization = createLocalization({ zoteroLocale: 'zh-CN' });
    const model = createModel({
        status: 'ready',
        progress: 100,
        markdown: '正文',
    });
    const { view, shadow } = createView(model, {}, { localization });

    assert.equal(view.root.getAttribute('aria-label'), 'Mktero Markdown 阅读器');
    assert.equal(
        shadow.querySelector('.markdown-editor').getAttribute('aria-label'),
        'Markdown 只读视图'
    );
    assert.equal(shadow.querySelector('.markdown-outline-title').textContent, '目录');
    assert.equal(shadow.querySelector('.markdown-outline-empty').textContent, '暂无目录');
    assert.equal(shadow.querySelector('.markdown-notes-title').textContent, '笔记');
    assert.equal(shadow.querySelector('.markdown-notes-empty').textContent, '暂无笔记');
    assert.equal(
        shadow.querySelector('#mktero-reparse').getAttribute('title'),
        '重新解析 PDF。这会再次上传 PDF，并可能消耗转换服务额度。'
    );
    assert.equal(
        shadow.querySelector('#mktero-reader-font-family')
            .getAttribute('aria-label'),
        '正文字体: 系统衬线'
    );
    assert.deepEqual(
        [...shadow.querySelectorAll(
            '#mktero-reader-font-options .markdown-reader-font-option-label'
        )]
            .map(option => option.textContent),
        ['系统衬线', 'Georgia', 'Cambria', 'Times New Roman']
    );

    view.destroy();
});

test('routes rendered Markdown links through Zotero instead of navigating the main window', () => {
    const launched = [];
    let openLink;
    const { view } = createView(
        createModel({
            status: 'ready',
            markdown: '[MinerU](https://mineru.net)',
            sourceKind: 'markdown',
        }),
        { launchURL: url => launched.push(url) },
        {
            editorFactory(options) {
                openLink = options.openLink;
                return createTestInlineEditor(options);
            },
        }
    );
    openLink('https://mineru.net');

    assert.deepEqual(launched, ['https://mineru.net']);
    view.destroy();
});

test('ignores an empty Markdown fragment without treating it as a CSS selector', () => {
    let openLink;
    const { view } = createView(createModel({
        status: 'ready',
        markdown: '[Top](#)',
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            openLink = options.openLink;
            return createTestInlineEditor(options);
        },
    });

    assert.doesNotThrow(() => openLink('#'));
    view.destroy();
});

test('scrolls Markdown fragment links through the heading index', () => {
    const markdown = '# Overview\n\n## Methods and Results';
    const scrolledOffsets = [];
    let openLink;
    const { view } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown,
        sourceKind: 'markdown',
    }), {}, {
        editorFactory(options) {
            openLink = options.openLink;
            const editor = createTestInlineEditor(options);
            editor.scrollToOffset = offset => scrolledOffsets.push(offset);
            return editor;
        },
    });

    openLink('#methods-and-results');

    assert.deepEqual(scrolledOffsets, [markdown.indexOf('## Methods')]);
    view.destroy();
});

test('adds fragment targets to saved HTML snapshot headings', () => {
    const { view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        renderMode: 'html',
        snapshotHTML: '<h1>Methods and Results</h1>'
            + '<h2>Methods and Results</h2>',
        snapshotAssets: [],
        onReparse: null,
        onSaveSnapshot: null,
    }));
    const headings = [...shadow.querySelectorAll('#mktero-snapshot h1, #mktero-snapshot h2')];
    const scrolled = [];
    for (const heading of headings) {
        heading.scrollIntoView = () => scrolled.push(heading.id);
    }

    try {
        assert.deepEqual(headings.map(heading => heading.id), [
            'methods-and-results',
            'methods-and-results-1',
        ]);
        view.openLink?.('#methods-and-results-1');
        assert.deepEqual(scrolled, ['methods-and-results-1']);
    }
    finally {
        view.destroy();
    }
});

test('creates and revokes Blob URLs for cached MinerU images', () => {
    const created = [];
    const revoked = [];
    let resolveImageURL;
    const { view } = createView(createModel({
        status: 'ready',
        markdown: '![Figure](images/figure.png)',
        assets: [{
            path: 'images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        sourceKind: 'markdown',
    }), {}, {
        configureWindow(window) {
            window.URL = {
                createObjectURL(blob) {
                    created.push(blob);
                    return 'blob:mktero-test-figure';
                },
                revokeObjectURL(url) {
                    revoked.push(url);
                },
            };
            window.Blob = globalThis.Blob;
        },
        editorFactory(options) {
            resolveImageURL = options.resolveImageURL;
            return createTestInlineEditor(options);
        },
    });

    assert.equal(created.length, 1);
    assert.equal(resolveImageURL('images/figure.png'), 'blob:mktero-test-figure');
    view.destroy();
    assert.deepEqual(revoked, ['blob:mktero-test-figure']);
});

test('refreshes inline rendering when cached image assets change', () => {
    const firstAssets = [{
        path: 'images/figure.png',
        mimeType: 'image/png',
        data: new Uint8Array([1]),
    }];
    const model = createModel({
        status: 'ready',
        markdown: '![Figure](images/figure.png)',
        assets: firstAssets,
        sourceKind: 'markdown',
    });
    let refreshes = 0;
    const { view } = createView(model, {}, {
        configureWindow(window) {
            window.URL = {
                createObjectURL: () => `blob:mktero-${refreshes}`,
                revokeObjectURL: () => {},
            };
            window.Blob = globalThis.Blob;
        },
        editorFactory(options) {
            const editor = createTestInlineEditor(options);
            editor.refreshRendering = () => refreshes++;
            return editor;
        },
    });

    assert.equal(refreshes, 1);
    view.render(model);
    assert.equal(refreshes, 1);

    view.render({
        ...model,
        assets: [{ ...firstAssets[0], data: new Uint8Array([2]) }],
    });
    assert.equal(refreshes, 2);
    view.destroy();
});
