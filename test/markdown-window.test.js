import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createLocalization } from '../src/i18n/localization.js';
import { createMarkdownTabView } from '../src/ui/markdown-window.js';

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
        onReparse: null,
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

test('adjusts the persisted reader font size from the document action menu', () => {
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
        const toggle = shadow.querySelector('#mktero-document-actions');
        const decrease = shadow.querySelector('#mktero-reader-font-decrease');
        const increase = shadow.querySelector('#mktero-reader-font-increase');
        const value = shadow.querySelector('#mktero-reader-font-value');
        const group = shadow.querySelector('.markdown-reader-font-size');

        assert.equal(group.getAttribute('aria-label'), 'Text size');
        assert.equal(decrease.textContent, 'A−');
        assert.equal(increase.textContent, 'A+');
        assert.equal(value.textContent, '18 px');
        assert.equal(view.host.style.getPropertyValue('--reader-font-size'), '18px');

        toggle.click();
        increase.click();
        increase.click();
        increase.click();
        increase.click();

        assert.deepEqual(persistedSizes, [19, 20, 21, 22]);
        assert.equal(value.textContent, '22 px');
        assert.equal(view.host.style.getPropertyValue('--reader-font-size'), '22px');
        assert.equal(increase.disabled, true);
        assert.equal(decrease.disabled, false);
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');

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

test('selects a font from the styled picker without closing the menu', () => {
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
            ['georgia', 'cambria', 'times-new-roman', 'system-serif']
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
        toggle.click();
        dispatchMouseEvent(trigger, 'mousedown', 0);
        trigger.click();
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
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
            'true'
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

test('operates the styled font picker from the keyboard', () => {
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

        toggle.click();
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
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');

        dispatchKeyboardEvent(trigger, 'ArrowDown');
        dispatchKeyboardEvent(cambria, 'Escape');
        assert.equal(trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    }
    finally {
        view.destroy();
    }
});

test('closes the styled font picker and menu on an outside press', () => {
    const { document, view, shadow } = createView(createModel({
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nReadable text.',
        sourceKind: 'markdown',
    }));

    try {
        const ownerWindow = document.defaultView;
        const toggle = shadow.querySelector('#mktero-document-actions');
        const trigger = shadow.querySelector('#mktero-reader-font-family');
        const listbox = shadow.querySelector('#mktero-reader-font-options');
        const outside = document.createElement('div');
        document.body.appendChild(outside);

        toggle.click();
        trigger.click();
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
        const toggle = shadow.querySelector('#mktero-document-actions');
        const trigger = shadow.querySelector('#mktero-reader-font-family');
        const listbox = shadow.querySelector('#mktero-reader-font-options');
        const family = shadow.querySelector('.markdown-reader-font-family');

        toggle.click();
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
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(fontTrigger.getAttribute('aria-expanded'), 'true');
    view.destroy();

    outside.dispatchEvent(new ownerWindow.Event('pointerdown', {
        bubbles: true,
    }));
    outside.dispatchEvent(new ownerWindow.Event('mousedown', {
        bubbles: true,
    }));
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
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
        assert.equal(shadow.querySelector('#mktero-editor').hidden, true);
        assert.equal(shadow.querySelector('#mktero-snapshot').hidden, false);
        assert.match(
            shadow.querySelector('#mktero-snapshot').textContent,
            /Portable/
        );
        assert.equal(shadow.querySelector('.markdown-reader-actions').hidden, false);
        assert.equal(shadow.querySelector('.markdown-reader-font-size').hidden, false);
        assert.equal(shadow.querySelector('#mktero-reparse').hidden, true);
        assert.equal(shadow.querySelector('#mktero-save-snapshot').hidden, true);
        assert.equal(shadow.querySelector('.cm-content').textContent, '');
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
        assert.deepEqual(scrolledOffsets, [12, 0]);
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
        '正文字体: Georgia'
    );
    assert.deepEqual(
        [...shadow.querySelectorAll(
            '#mktero-reader-font-options .markdown-reader-font-option-label'
        )]
            .map(option => option.textContent),
        ['Georgia', 'Cambria', 'Times New Roman', '系统衬线']
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
