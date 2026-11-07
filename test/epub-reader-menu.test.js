import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createLocalization } from '../src/i18n/localization.js';
import { createMarkdownTabView } from '../src/ui/markdown-window.js';
import { MarkdownTabPresenter } from '../src/ui/markdown-tab-presenter.js';

const MARKDOWN_STYLES = readFileSync(
    new URL('../ui/markdown.css', import.meta.url),
    'utf8'
);

function createInlineEditor({ document, parent, initialMarkdown }) {
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
        searchHighlights: [],
        scrolledOffsets: [],
        setDocumentSearchHighlights(value) {
            this.searchHighlights.push(value);
        },
        scrollToOffset(offset) {
            this.scrolledOffsets.push(offset);
        },
    };
}

function createFixture() {
    const { document } = parseHTML('<html><head></head><body></body></html>');
    const tabs = [];
    let nextTabID = 1;
    const Zotero_Tabs = {
        add(options) {
            const children = [];
            const container = { appendChild: child => children.push(child) };
            const tab = {
                id: `tab-${nextTabID++}`,
                options,
                children,
                container,
            };
            tabs.push(tab);
            return { id: tab.id, container };
        },
        select() {},
        getState: () => [],
        close(tabIDs) {
            for (const tabID of Array.isArray(tabIDs) ? tabIDs : [tabIDs]) {
                tabs.find(tab => tab.id === tabID)?.options.onClose?.();
            }
        },
    };
    const ownerWindow = { document, Zotero_Tabs, closed: false };
    const zotero = {
        getMainWindow: () => ownerWindow,
        Prefs: { get: () => undefined },
    };
    let view;
    const presenter = new MarkdownTabPresenter({
        zotero,
        rootURI: 'jar:file:///profile/extensions/mktero.xpi!/',
        localization: createLocalization('en-US'),
        createView(options) {
            view = createMarkdownTabView({
                ...options,
                stylesheetText: MARKDOWN_STYLES,
                editorFactory: createInlineEditor,
                sourcePeekDelay: 0,
                readingPositionDelay: 0,
            });
            return view;
        },
    });

    return {
        document,
        ownerWindow,
        presenter,
        get view() {
            return view;
        },
    };
}

function ready(presenter, presentation) {
    presenter.update(presentation, {
        status: 'ready',
        progress: 100,
        markdown: '# Paper\n\nBody text.',
        sourceKind: 'markdown',
    });
}

function click(element, document) {
    element.dispatchEvent(new document.defaultView.Event('click', {
        bubbles: true,
        cancelable: true,
    }));
}

function openDocumentActions(view, document) {
    click(view.mount.querySelector('#mktero-document-actions'), document);
    assert.equal(
        view.mount.querySelector('#mktero-document-action-menu')
            .getAttribute('aria-hidden'),
        'false'
    );
}

function assertFourVisibleOutputActions(view) {
    const outputGroup = view.mount.querySelector(
        '.markdown-reader-action-group'
    );
    assert.deepEqual(
        [...outputGroup.children].map(element => element.id),
        [
            'mktero-save-snapshot',
            'mktero-export-markdown',
            'mktero-export-obsidian',
            'mktero-export-epub',
        ]
    );
    for (const element of outputGroup.children) {
        assert.equal(element.hidden, false, `${element.id} should be visible`);
        assert.equal(element.disabled, false, `${element.id} should be enabled`);
    }
}

async function settleAction() {
    await new Promise(resolve => setImmediate(resolve));
}

test('renders four compact output actions and routes EPUB clicks through presenter callbacks', async () => {
    const fixture = createFixture();
    const calls = [];
    const firstExport = options => {
        calls.push({ callback: 'first', ...options });
        return { status: 'cancelled' };
    };
    try {
        const presentation = fixture.presenter.open(42, {
            onSaveSnapshot: () => {},
            onExportMarkdown: () => {},
            onExportObsidian: () => {},
            onExportEpub: firstExport,
        });
        ready(fixture.presenter, presentation);
        fixture.view.syncExportPlacement(680);

        openDocumentActions(fixture.view, fixture.document);
        assertFourVisibleOutputActions(fixture.view);
        click(
            fixture.view.mount.querySelector('#mktero-export-epub'),
            fixture.document
        );
        assert.deepEqual(calls, [{
            callback: 'first',
            ownerWindow: fixture.document.defaultView,
        }]);
        await settleAction();

        fixture.presenter.open(42);
        assert.equal(presentation.model.onExportEpub, firstExport);

        const replacementExport = options => {
            calls.push({ callback: 'replacement', ...options });
            return { status: 'cancelled' };
        };
        fixture.presenter.open(42, { onExportEpub: replacementExport });
        assert.equal(presentation.model.onExportEpub, replacementExport);
        openDocumentActions(fixture.view, fixture.document);
        assertFourVisibleOutputActions(fixture.view);
        click(
            fixture.view.mount.querySelector('#mktero-export-epub'),
            fixture.document
        );
        assert.deepEqual(calls[1], {
            callback: 'replacement',
            ownerWindow: fixture.document.defaultView,
        });
        await settleAction();
    }
    finally {
        fixture.presenter.dispose();
    }
});

test('redraws a ready reader when EPUB export is supplied on a reused tab', () => {
    const fixture = createFixture();
    const calls = [];
    try {
        const presentation = fixture.presenter.open(42, {
            onSaveSnapshot: () => {},
            onExportMarkdown: () => {},
            onExportObsidian: () => {},
        });
        ready(fixture.presenter, presentation);
        fixture.view.syncExportPlacement(680);
        assert.equal(
            fixture.view.mount.querySelector('#mktero-export-epub').hidden,
            true
        );

        const delayedExport = options => {
            calls.push(options);
            return { status: 'cancelled' };
        };
        fixture.presenter.open(42, { onExportEpub: delayedExport });

        openDocumentActions(fixture.view, fixture.document);
        assertFourVisibleOutputActions(fixture.view);
        click(
            fixture.view.mount.querySelector('#mktero-export-epub'),
            fixture.document
        );
        assert.deepEqual(calls, [{
            ownerWindow: fixture.document.defaultView,
        }]);
    }
    finally {
        fixture.presenter.dispose();
    }
});
