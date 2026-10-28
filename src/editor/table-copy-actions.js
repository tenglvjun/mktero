import { translateEnglish } from '../i18n/localization.js';
import {
    gfmTableToCSV,
    tableElementToCSV,
    tableElementToGFM,
} from '../markdown/markdown-table-export.js';
import { zoteroNoteTableClipboardHTML } from '../markdown/zotero-note-clipboard.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * Add the table copy actions to a rendered table.
 *
 * Every table offers Markdown and CSV. A GFM table hands over the block it
 * came from, and a rendered `<table>` that no Markdown source backs (an OCR
 * HTML table, or a table inside a saved snapshot) is converted back into one.
 *
 * The export runs on click, not on render: a paper can hold many wide tables,
 * and only the one the reader copies pays for being serialized. The Markdown
 * action renders that same text as Zotero note HTML then, too.
 */
export function enhanceTableCopyActions(container, table, {
    copyCode,
    translate = translateEnglish,
    source = '',
} = {}) {
    if (typeof copyCode !== 'function'
        || !table
        || container.querySelector('.cm-mktero-table-toolbar')) {
        return;
    }
    if (!source && !tableHasRows(table)) return;
    const actions = [
        {
            action: 'copy-table-markdown',
            labelKey: 'markdown.tableCopyMarkdown',
            read: () => (source || tableElementToGFM(table)),
            noteHTML: true,
        },
        {
            action: 'copy-table-csv',
            labelKey: 'markdown.tableCopyCSV',
            read: () => (source
                ? gfmTableToCSV(source)
                : tableElementToCSV(table)),
        },
    ];

    const toolbar = createHTMLNode(documentOf(container), 'div');
    toolbar.className = 'cm-mktero-table-toolbar';
    // One action at a time reports its result, so the sibling that copied
    // earlier goes back to its label.
    const buttons = new Map();
    const resetAll = () => {
        for (const [button, labelKey] of buttons) {
            resetCopyButton(button, translate, labelKey);
        }
    };
    for (const descriptor of actions) {
        buttons.set(createCopyButton(toolbar, descriptor, {
            copyCode,
            translate,
            resetAll,
        }), descriptor.labelKey);
    }
    toolbar.append(...buttons.keys());
    container.append(toolbar);
}

/**
 * Add the table actions to every table of an already rendered document.
 *
 * Saved snapshots keep note HTML, not Markdown, so this is their only table
 * entry point; each table is converted back to GFM for the Markdown action. Each table is wrapped so the action has a positioned host; a
 * table inside another table is left alone, and so is one already enhanced.
 */
export function enhanceRenderedTableBlocks(root, document, options = {}) {
    if (typeof options.copyCode !== 'function') return;
    for (const table of root?.querySelectorAll?.('table') || []) {
        if (table.closest?.('table') !== table) continue;
        if (table.closest?.('.cm-mktero-table-copy-block')) continue;
        // A table with no rows has nothing to export, so it is left unwrapped.
        if (!tableHasRows(table)) continue;
        const container = createHTMLNode(document, 'div');
        container.className = 'cm-mktero-table-copy-block';
        table.replaceWith(container);
        container.append(table);
        enhanceTableCopyActions(container, table, options);
    }
}

function createCopyButton(toolbar, {
    action,
    labelKey,
    read,
    noteHTML = false,
}, {
    copyCode,
    translate,
    resetAll,
}) {
    const document = documentOf(toolbar);
    const button = createHTMLNode(document, 'button');
    button.type = 'button';
    button.className = 'cm-mktero-table-copy';
    button.dataset.action = action;
    resetCopyButton(button, translate, labelKey);
    button.addEventListener('click', async event => {
        // The table container and its cells also handle clicks, for links and
        // for correction editing.
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        resetAll();
        button.disabled = true;
        try {
            const text = read();
            // A malformed table and one past the export budget both read as
            // unavailable, and report the same way a clipboard failure does.
            if (!text) throw new Error('Table export is unavailable');
            const html = noteHTML ? zoteroNoteTableHTML(text) : '';
            if (html) await copyCode(text, { html });
            else await copyCode(text);
            button.dataset.state = 'copied';
            button.textContent = translate('markdown.tableCopied');
        }
        catch {
            button.dataset.state = 'failed';
            button.textContent = translate('markdown.tableCopyFailed');
        }
        finally {
            button.disabled = false;
        }
    });
    return button;
}

// The note renderer is the sanitizer. A throw, or HTML with no table, keeps
// the Markdown text and omits the HTML flavor.
function zoteroNoteTableHTML(markdown) {
    return zoteroNoteTableClipboardHTML(markdown);
}

function resetCopyButton(button, translate, labelKey) {
    delete button.dataset.state;
    const label = translate(labelKey);
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.title = label;
}

function tableHasRows(table) {
    return Boolean(table.querySelector?.('tr'));
}

function documentOf(element) {
    return element.ownerDocument;
}

function createHTMLNode(document, tagName) {
    if (typeof document.createElementNS === 'function') {
        return document.createElementNS(XHTML_NAMESPACE, tagName);
    }
    return document.createElement(tagName);
}
