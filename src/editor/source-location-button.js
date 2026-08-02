import { createLucideIcon, LUCIDE_ICONS } from '../icons/lucide-icon.js';
import { isValidSourceMapEntry } from '../core/markdown-source-map.js';
import { createEvidenceSnippet } from '../markdown/markdown-evidence.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function createSourceLocationButton(document, entry, {
    openSourceLocation,
    onSourceNavigationError,
    translate,
}) {
    const label = translate('source.viewInPDF');
    const button = document.createElementNS(XHTML_NAMESPACE, 'button');
    button.className = 'cm-mktero-source-link';
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.dataset.locationCount = String(entry.locations.length);
    button.appendChild(createLucideIcon(
        document,
        LUCIDE_ICONS.externalLink,
        { size: 14 }
    ));
    button.addEventListener('mousedown', event => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        try {
            await openSourceLocation?.(copyFirstLocation(entry));
        }
        catch (error) {
            onSourceNavigationError?.(error);
        }
        finally {
            button.disabled = false;
        }
    });
    return button;
}

export function createSourceLocationActions(document, entries, options) {
    if (!Array.isArray(entries) || !entries.length) return null;
    const canOpen = typeof options.openSourceLocation === 'function';
    const canCopy = entry => (
        typeof options.copySourcedMarkdown === 'function'
        && copyableSourceEntry(options.markdown, entry)
    );
    const hasCopy = entries.some(canCopy);
    if (!canOpen && !hasCopy) return null;
    if (entries.length === 1 && !hasCopy) {
        return createSourceLocationButton(document, entries[0], options);
    }
    const actions = document.createElementNS(XHTML_NAMESPACE, 'div');
    actions.className = 'cm-mktero-source-actions';
    for (const entry of entries) {
        const row = document.createElementNS(XHTML_NAMESPACE, 'div');
        row.className = 'cm-mktero-source-action-row';
        if (canOpen) {
            row.appendChild(createSourceLocationButton(document, entry, options));
        }
        if (canCopy(entry)) {
            row.appendChild(createSourceCopyButton(document, entry, options));
        }
        actions.appendChild(row);
    }
    return actions;
}

export function sourceMapEntriesForRange(sourceMap, from, to) {
    if (!Array.isArray(sourceMap)) return [];
    return sourceMap.filter(entry => (
        isValidSourceMapEntry(entry)
        && entry.markdownFrom < to
        && entry.markdownTo > from
    )).sort((left, right) => left.markdownFrom - right.markdownFrom);
}

function copyFirstLocation(entry) {
    return {
        pageIndex: entry.locations[0].pageIndex,
        bbox: [...entry.locations[0].bbox],
    };
}

function createSourceCopyButton(document, entry, {
    copySourcedMarkdown,
    onSourcedCopyError,
    translate,
}) {
    const label = translate('evidence.copyWithSource');
    const button = document.createElementNS(XHTML_NAMESPACE, 'button');
    button.className = 'cm-mktero-source-copy';
    button.type = 'button';
    button.dataset.action = 'copy-with-source';
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    setButtonIcon(document, button, LUCIDE_ICONS.copy);
    button.addEventListener('mousedown', event => {
        event.preventDefault();
        event.stopPropagation();
    });
    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        try {
            await copySourcedMarkdown({
                kind: 'block',
                from: entry.markdownFrom,
                to: entry.markdownTo,
            });
            const copied = translate('evidence.copied');
            button.setAttribute('aria-label', copied);
            button.setAttribute('title', copied);
            setButtonIcon(document, button, LUCIDE_ICONS.check);
        }
        catch (error) {
            const failed = translate('evidence.copyFailed');
            button.setAttribute('aria-label', failed);
            button.setAttribute('title', failed);
            onSourcedCopyError?.(error);
        }
        finally {
            button.disabled = false;
        }
    });
    return button;
}

function setButtonIcon(document, button, icon) {
    button.replaceChildren(createLucideIcon(document, icon, { size: 14 }));
}

function copyableSourceEntry(markdown, entry) {
    if (typeof markdown !== 'string') return false;
    try {
        createEvidenceSnippet({
            markdown,
            sourceMap: [entry],
            target: {
                kind: 'block',
                from: entry.markdownFrom,
                to: entry.markdownTo,
            },
        });
        return true;
    }
    catch {
        return false;
    }
}
