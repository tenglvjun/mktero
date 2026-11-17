import { createAnchoredPopup } from './anchored-popup.js';
import { createLocalization } from '../i18n/localization.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// The original text behind the selected translated sentence, for the view where
// the original is not on screen. Bilingual reading has the original beside the
// translation, so it marks that sentence instead of repeating its text in a
// floating panel.
export function createTranslationSourcePopup(parent, {
    localization = createLocalization(),
    revealSource = null,
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-translation-source-popup',
        idPrefix: 'mktero-translation-source-popup',
        viewportPadding: 16,
    });

    return {
        open({
            anchor,
            source,
            offscreen = null,
            onAnnotate = null,
            annotationUnavailable = null,
        }) {
            const text = String(source?.text || '').trim();
            if (!anchor || !text) {
                anchoredPopup.close();
                return;
            }
            anchoredPopup.open({
                anchor,
                label: t('ai.translationSourceLabel'),
                renderContent({ document }) {
                    return createContent(
                        document,
                        text,
                        typeof revealSource === 'function'
                            ? () => {
                                anchoredPopup.close();
                                revealSource(source);
                            }
                            : null,
                        t,
                        offscreen,
                        typeof onAnnotate === 'function'
                            ? () => onAnnotate(source)
                            : null,
                        annotationUnavailable
                    );
                },
            });
        },
        close: anchoredPopup.close,
        contains: anchoredPopup.contains,
        destroy: anchoredPopup.destroy,
    };
}

function createContent(
    document,
    text,
    reveal,
    t,
    offscreen,
    annotate,
    annotationUnavailable
) {
    const content = document.createElementNS(XHTML_NAMESPACE, 'div');
    content.className = 'mktero-translation-source';

    const label = document.createElementNS(XHTML_NAMESPACE, 'div');
    label.className = 'mktero-translation-source-label';
    label.textContent = t('ai.translationSourceLabel');
    content.appendChild(label);

    // The original is not beside the translation in this view, so say which
    // way it lies rather than leaving the reader to hunt for it.
    if (offscreen === 'above' || offscreen === 'below') {
        const direction = document.createElementNS(XHTML_NAMESPACE, 'div');
        direction.className = 'mktero-translation-source-direction';
        direction.textContent = t('ai.translationSourceOffscreen', {
            direction: t(`ai.translationSource${
                offscreen === 'above' ? 'Above' : 'Below'
            }`),
        });
        content.appendChild(direction);
    }

    const body = document.createElementNS(XHTML_NAMESPACE, 'div');
    body.className = 'mktero-translation-source-text';
    body.setAttribute('dir', 'auto');
    body.textContent = text;
    content.appendChild(body);

    if (annotationUnavailable) {
        const unavailable = document.createElementNS(XHTML_NAMESPACE, 'div');
        unavailable.className = 'mktero-translation-source-unavailable';
        unavailable.setAttribute('role', 'status');
        unavailable.textContent = annotationUnavailable;
        content.appendChild(unavailable);
    }

    const actions = document.createElementNS(XHTML_NAMESPACE, 'div');
    actions.className = 'mktero-translation-source-actions';

    // The annotation covers the whole original block even though the bubble
    // shows only the corresponding sentence selected for reading.
    if (annotate) {
        const create = document.createElementNS(XHTML_NAMESPACE, 'button');
        create.type = 'button';
        create.className = 'mktero-translation-source-action';
        create.textContent = t('annotation.sourceBlockHighlight');
        create.addEventListener('click', annotate);
        actions.appendChild(create);
    }

    if (reveal) {
        const action = document.createElementNS(XHTML_NAMESPACE, 'button');
        action.type = 'button';
        action.className = 'mktero-translation-source-action';
        action.textContent = t('ai.translationSourceLocate');
        action.addEventListener('click', reveal);
        actions.appendChild(action);
    }

    if (actions.childNodes.length) content.appendChild(actions);
    return content;
}
