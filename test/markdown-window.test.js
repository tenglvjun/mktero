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
    });
    view.render(model);
    return { document, view, shadow: view.host.shadowRoot };
}

function createTestInlineEditor({ document, parent, initialMarkdown }) {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    content.className = 'cm-content';
    content.setAttribute('contenteditable', 'false');
    content.textContent = initialMarkdown;
    editor.appendChild(content);
    parent.appendChild(editor);
    return {
        getMarkdown: () => content.textContent,
        setMarkdown(markdown) {
            content.textContent = markdown;
        },
        focus: () => content.focus(),
        refreshRendering: () => {},
        destroy: () => editor.remove(),
    };
}

function dispatchMouseEvent(target, type, clientX) {
    const ownerWindow = target.ownerDocument?.defaultView || target;
    const event = new ownerWindow.Event(type, {
        bubbles: true,
        cancelable: true,
    });
    Object.defineProperties(event, {
        button: { value: 0 },
        clientX: { value: clientX },
    });
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
        assert.equal(toggle.textContent, '‹');
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
        assert.equal(toggle.textContent, '›');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(toggle.getAttribute('aria-label'), 'Expand outline');
        assert.equal(resizer.getAttribute('aria-label'), 'Expand outline');

        toggle.click();
        assert.equal(outline.hidden, false);
        assert.equal(toggle.textContent, '‹');
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
    assert.equal(shadow.querySelector('#mktero-reparse'), null);
    assert.equal(shadow.querySelector('#mktero-copy'), null);
    assert.equal(shadow.querySelector('#mktero-show-preview'), null);
    assert.equal(shadow.querySelector('#mktero-show-source'), null);
    assert.ok(!shadow.querySelector('.app-header'));
    assert.ok(!shadow.querySelector('.source-actions'));
    assert.ok(!shadow.querySelector('#mktero-editor-toolbar'));
    assert.ok(shadow.querySelector('#mktero-editor .cm-content'));
    assert.equal(shadow.querySelector('.markdown-workspace').hidden, true);
    assert.ok(shadow.querySelector('#mktero-outline-resizer'));
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
