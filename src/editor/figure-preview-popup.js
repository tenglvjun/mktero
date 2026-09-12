import { createAnchoredPopup } from './anchored-popup.js';
import { createLocalization } from '../i18n/localization.js';
import { appendRenderedMarkdown } from './rendered-markdown-dom.js';
import { createLucideIcon, LUCIDE_ICONS } from '../icons/lucide-icon.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function createFigurePreviewPopup(parent, {
    resolveImageURL,
    localization = createLocalization(),
    openSourceLocation,
    onSourceNavigationError = () => {},
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-figure-preview-popup',
        idPrefix: 'mktero-figure-preview-popup',
        viewportPadding: 24,
    });

    return {
        open({ anchor, target }) {
            if (!target?.figure?.source) return;
            anchoredPopup.open({
                anchor,
                label: t('figure.preview'),
                renderContent({ document, reposition }) {
                    return createPreviewContent(
                        document,
                        target,
                        resolveImageURL,
                        reposition,
                        t,
                        typeof openSourceLocation === 'function' && target.location
                            ? async () => {
                                anchoredPopup.close();
                                try {
                                    await openSourceLocation(target.location);
                                }
                                catch (error) {
                                    onSourceNavigationError(error);
                                }
                            } : null
                    );
                },
            });
        },
        close: anchoredPopup.close,
        scheduleClose: anchoredPopup.scheduleClose,
        cancelClose: anchoredPopup.cancelClose,
        contains: anchoredPopup.contains,
        destroy: anchoredPopup.destroy,
    };
}

function createPreviewContent(
    document,
    target,
    resolveImageURL,
    reposition,
    translate,
    openSource
) {
    const content = document.createElementNS(XHTML_NAMESPACE, 'div');
    content.className = 'mktero-figure-preview-content';
    const viewport = document.createElementNS(XHTML_NAMESPACE, 'div');
    viewport.className = 'mktero-figure-preview-viewport';
    appendRenderedMarkdown(
        viewport,
        target.figure.source,
        resolveImageURL,
        false,
        translate
    );
    for (const image of viewport.querySelectorAll('img')) {
        image.addEventListener('load', reposition, { once: true });
    }
    content.appendChild(viewport);
    if (openSource) {
        const button = document.createElementNS(XHTML_NAMESPACE, 'button');
        button.setAttribute('type', 'button');
        button.className = 'mktero-figure-source-button';
        button.setAttribute('title', translate('source.viewInPDF'));
        button.setAttribute('aria-label', translate('source.viewInPDF'));
        button.appendChild(createLucideIcon(document, LUCIDE_ICONS.externalLink, { size: 16 }));
        button.addEventListener('click', openSource);
        content.appendChild(button);
    }
    return content;
}
