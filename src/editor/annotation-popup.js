import { createAnchoredPopup } from './anchored-popup.js';
import { createLocalization } from '../i18n/localization.js';
import {
    annotationPageLabel,
    safeAnnotationColor,
} from './pdf-annotations.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function createAnnotationPopup(parent, {
    localization = createLocalization(),
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-annotation-popup',
        idPrefix: 'mktero-annotation-popup',
    });

    return {
        open({ anchor, annotation }) {
            if (!annotation) return;
            anchoredPopup.open({
                anchor,
                label: t('annotation.details'),
                renderContent({ document }) {
                    return createAnnotationContent(document, annotation, t);
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

function createAnnotationContent(document, annotation, translate) {
    const content = document.createElementNS(XHTML_NAMESPACE, 'div');
    content.className = 'mktero-annotation-popup-content';

    const metadata = document.createElementNS(XHTML_NAMESPACE, 'div');
    metadata.className = 'mktero-annotation-popup-metadata';
    const swatch = document.createElementNS(XHTML_NAMESPACE, 'span');
    swatch.className = 'mktero-annotation-popup-swatch';
    swatch.style.setProperty(
        '--mktero-annotation-color',
        safeAnnotationColor(annotation.color)
    );
    swatch.setAttribute('aria-hidden', 'true');
    metadata.appendChild(swatch);
    const pageLabel = annotationPageLabel(annotation);
    if (pageLabel) {
        const page = document.createElementNS(XHTML_NAMESPACE, 'span');
        page.className = 'mktero-annotation-popup-page';
        page.textContent = translate('annotation.page', {
            page: pageLabel,
        });
        metadata.appendChild(page);
    }
    content.appendChild(metadata);

    const text = document.createElementNS(XHTML_NAMESPACE, 'div');
    text.className = 'mktero-annotation-popup-text';
    text.textContent = annotation.comment || annotation.text;
    content.appendChild(text);
    return content;
}
