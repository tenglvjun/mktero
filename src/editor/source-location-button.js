import { createLucideIcon, LUCIDE_ICONS } from '../icons/lucide-icon.js';
import { isValidSourceLocation } from '../core/markdown-source-map.js';

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
    if (entries.length === 1) {
        return createSourceLocationButton(document, entries[0], options);
    }
    const actions = document.createElementNS(XHTML_NAMESPACE, 'div');
    actions.className = 'cm-mktero-source-actions';
    for (const entry of entries) {
        actions.appendChild(createSourceLocationButton(document, entry, options));
    }
    return actions;
}

export function sourceMapEntriesForRange(sourceMap, from, to) {
    if (!Array.isArray(sourceMap)) return [];
    return sourceMap.filter(entry => (
        validSourceMapEntry(entry)
        && entry.markdownFrom < to
        && entry.markdownTo > from
    )).sort((left, right) => left.markdownFrom - right.markdownFrom);
}

export function validSourceMapEntry(entry, documentLength = Infinity) {
    return Number.isSafeInteger(entry?.markdownFrom)
        && Number.isSafeInteger(entry?.markdownTo)
        && entry.markdownFrom >= 0
        && entry.markdownTo > entry.markdownFrom
        && entry.markdownTo <= documentLength
        && Array.isArray(entry.locations)
        && entry.locations.length > 0
        && entry.locations.every(isValidSourceLocation);
}

function copyFirstLocation(entry) {
    return {
        pageIndex: entry.locations[0].pageIndex,
        bbox: [...entry.locations[0].bbox],
    };
}
