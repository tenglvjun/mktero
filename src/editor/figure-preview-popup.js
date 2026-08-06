import { createAnchoredPopup } from './anchored-popup.js';
import { createLocalization } from '../i18n/localization.js';
import { appendRenderedMarkdown } from './rendered-markdown-dom.js';

export function createFigurePreviewPopup(parent, {
    resolveImageURL,
    localization = createLocalization(),
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
                        t
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
    translate
) {
    const content = document.createElement('div');
    content.className = 'mktero-figure-preview-content';
    const viewport = document.createElement('div');
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
    return content;
}
