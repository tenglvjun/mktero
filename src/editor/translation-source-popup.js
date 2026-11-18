import { createAnchoredPopup } from './anchored-popup.js';
import { createSourceBlockAnnotationAction } from './annotation-popup.js';
import { createLocalization } from '../i18n/localization.js';
import {
    createLegacyActions,
    normalizeLegacyActions,
    sourceBlockAnnotationLabels,
} from './translation-legacy-actions.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// Translation view shows the matched passage here because the original is not
// in its document. Bilingual view can mark the original in place instead.
export function createTranslationSourcePopup(parent, {
    localization = createLocalization(),
    createMarkdownAnnotation,
    revealSource = null,
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-translation-source-popup',
        idPrefix: 'mktero-translation-source-popup',
        viewportPadding: 16,
        constrainToParent: true,
    });

    return {
        open({
            anchor,
            source,
            annotation = null,
            selectionContext,
            annotationUnavailable = null,
            blockCount = 1,
            sourceLabel = null,
            legacyActions = [],
            isCurrent = null,
        }) {
            const text = String(source?.text || '').trim();
            const legacy = normalizeLegacyActions(legacyActions);
            const showAnnotation = annotation && !annotationUnavailable;
            if (!anchor || (!text && !showAnnotation && !annotationUnavailable && !legacy.length)) {
                anchoredPopup.close();
                return;
            }
            let legacyControls;
            anchoredPopup.open({
                anchor,
                label: (text && sourceLabel) || t(text
                    ? 'ai.translationSourceLabel'
                    : 'ai.translationSourceActions'),
                dismissOnMouseLeave: false,
                onClose: () => legacyControls?.dispose(),
                renderContent({ document, close, reposition }) {
                    const content = createContent(document, t, {
                        text,
                        sourceLabel,
                        reveal: text && typeof revealSource === 'function'
                            ? () => {
                                close();
                                revealSource(source);
                            }
                            : null,
                        save: showAnnotation ? {
                            annotation, selectionContext, createMarkdownAnnotation,
                            close, reposition, isCurrent,
                        } : null,
                        annotationUnavailable,
                        blockCount,
                    });
                    if (legacy.length) {
                        legacyControls = createLegacyActions(document, legacy, t, reposition);
                        content.appendChild(legacyControls.element);
                    }
                    return content;
                },
            });
        },
        close: anchoredPopup.close,
        contains: anchoredPopup.contains,
        destroy: anchoredPopup.destroy,
    };
}

function createContent(document, t, {
    text, sourceLabel, reveal, save, annotationUnavailable, blockCount,
}) {
    const content = document.createElementNS(XHTML_NAMESPACE, 'div');
    content.className = 'mktero-translation-source';

    if (text) {
        const label = document.createElementNS(XHTML_NAMESPACE, 'div');
        label.className = 'mktero-translation-source-label';
        label.textContent = sourceLabel || t('ai.translationSourceLabel');
        content.appendChild(label);

        const body = document.createElementNS(XHTML_NAMESPACE, 'div');
        body.className = 'mktero-translation-source-text';
        body.setAttribute('dir', 'auto');
        body.tabIndex = 0;
        body.textContent = text;
        content.appendChild(body);
    }

    if (annotationUnavailable) {
        const unavailable = document.createElementNS(XHTML_NAMESPACE, 'div');
        unavailable.className = 'mktero-translation-source-unavailable';
        unavailable.setAttribute('role', 'status');
        unavailable.textContent = annotationUnavailable;
        content.appendChild(unavailable);
    }

    const actions = document.createElementNS(XHTML_NAMESPACE, 'div');
    actions.className = 'mktero-translation-source-actions';

    let locate = null;
    if (reveal) {
        locate = document.createElementNS(XHTML_NAMESPACE, 'button');
        locate.type = 'button';
        locate.dataset.action = 'locate-source';
        locate.className = 'mktero-translation-source-action';
        locate.textContent = t('ai.translationSourceLocate');
        locate.addEventListener('click', () => {
            if (!locate.disabled && locate.isConnected) reveal();
        });
        actions.appendChild(locate);
    }

    if (save) {
        const labels = sourceBlockAnnotationLabels(t, blockCount);
        const scope = document.createElementNS(XHTML_NAMESPACE, 'div');
        scope.className = 'mktero-related-source-scope';
        scope.textContent = labels.scope;
        content.appendChild(scope);
        const action = createSourceBlockAnnotationAction(document, t);
        action.update({ ...save, locate, label: labels.action });
        action.button.dataset.action = 'annotate-source';
        action.button.classList.add('mktero-translation-source-action');
        actions.prepend(action.button);
        content.append(actions, action.error);
    }
    else if (locate) content.appendChild(actions);

    return content;
}
