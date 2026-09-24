import { createLucideIcon, LUCIDE_ICONS } from '../icons/lucide-icon.js';
import { translateEnglish } from '../i18n/localization.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export const FIGURE_PLACEHOLDER_CLASS = 'mktero-figure-placeholder';

// Builds the reading-flow skeleton shown while a figure is still being stitched
// from the local PDF: a lucide image with a spinning loader. The real caption
// already renders below the figure, so no label skeleton is shown.
export function createFigurePlaceholderElement(document, { id, label = null, translate = translateEnglish } = {}) {
    if (!document?.createElementNS) throw new TypeError('A document is required');
    const host = document.createElementNS(XHTML_NAMESPACE, 'div');
    host.className = FIGURE_PLACEHOLDER_CLASS;
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    if (id) host.setAttribute('data-figure-id', String(id));
    if (label) host.setAttribute('title', String(label));

    const media = document.createElementNS(XHTML_NAMESPACE, 'div');
    media.className = `${FIGURE_PLACEHOLDER_CLASS}-media`;
    const image = createLucideIcon(document, LUCIDE_ICONS.image, {
        className: `${FIGURE_PLACEHOLDER_CLASS}-icon`, size: 48,
    });
    const loader = document.createElementNS(XHTML_NAMESPACE, 'span');
    loader.className = `${FIGURE_PLACEHOLDER_CLASS}-loader`;
    loader.appendChild(createLucideIcon(document, LUCIDE_ICONS.loaderCircle, {
        className: `${FIGURE_PLACEHOLDER_CLASS}-spinner`, size: 28,
    }));
    media.append(image, loader);

    const announcement = document.createElementNS(XHTML_NAMESPACE, 'span');
    announcement.className = `${FIGURE_PLACEHOLDER_CLASS}-sr`;
    announcement.textContent = translate('figure.pending');
    host.append(media, announcement);
    return host;
}

export function isFigurePlaceholderElement(node) {
    return Boolean(node?.classList?.contains?.(FIGURE_PLACEHOLDER_CLASS));
}

// Swaps the original OCR panel images of a pending figure for a single animated
// placeholder per figure. A finished crop in `restoredFigures` replaces only
// that figure. `pendingAssets` maps an original asset path to the pending
// figure id. A resolver that throws or returns a non-string leaves the
// placeholder in place.
export function replacePendingFigureImages(
    container,
    pendingAssets,
    translate = translateEnglish,
    restoredFigures = null,
    resolveRestoredFigureURL = null,
) {
    if (!container?.querySelectorAll || !pendingAssets?.size) return 0;
    const document = container.ownerDocument;
    const replaced = new Set();
    let count = 0;
    for (const image of [...container.querySelectorAll('img[data-mktero-asset]')]) {
        const figureId = pendingAssets.get(image.getAttribute('data-mktero-asset'));
        if (!figureId) continue;
        if (replaced.has(figureId)) {
            image.remove();
            continue;
        }
        replaced.add(figureId);
        const restored = restoredFigures?.get?.(figureId);
        image.replaceWith(
            createRestoredFigureImage(
                document,
                figureId,
                restored,
                resolveRestoredFigureURL,
            )
            || createFigurePlaceholderElement(document, { id: figureId, translate }),
        );
        count++;
    }
    return count;
}

function createRestoredFigureImage(
    document,
    figureId,
    restored,
    resolveRestoredFigureURL,
) {
    if (!restored || typeof resolveRestoredFigureURL !== 'function') return null;
    let url = null;
    try {
        url = resolveRestoredFigureURL(restored);
    }
    catch {
        return null;
    }
    if (typeof url !== 'string') return null;
    const image = document.createElementNS(XHTML_NAMESPACE, 'img');
    image.setAttribute('data-figure-id', figureId);
    image.setAttribute('data-mktero-asset', restored.assetPath);
    image.setAttribute('src', url);
    image.setAttribute('alt', '');
    return image;
}
