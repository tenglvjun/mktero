import { createAnchoredPopup } from './anchored-popup.js';
import { createLocalization } from '../i18n/localization.js';
import { appendRenderedMarkdown } from './rendered-markdown-dom.js';

export function createTablePreviewPopup(parent, {
    resolveImageURL,
    localization = createLocalization(),
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-table-preview-popup',
        idPrefix: 'mktero-table-preview-popup',
        viewportPadding: 24,
    });

    return {
        open({ anchor, target }) {
            if (!target?.table?.source) return;
            anchoredPopup.open({
                anchor,
                label: t('table.preview'),
                renderContent({ document }) {
                    return createPreviewContent(
                        document,
                        target,
                        resolveImageURL
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

function createPreviewContent(document, target, resolveImageURL) {
    const content = document.createElement('div');
    content.className = 'mktero-table-preview-content';
    const caption = document.createElement('div');
    caption.className = 'mktero-table-preview-caption';
    caption.textContent = target.caption;
    const viewport = document.createElement('div');
    viewport.className = 'mktero-table-preview-viewport';
    appendRenderedMarkdown(viewport, target.table.source, resolveImageURL);
    content.append(caption, viewport);
    return content;
}
