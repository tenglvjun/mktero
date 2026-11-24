import { createAnchoredPopup } from './anchored-popup.js';
import { createSelectionResultButton } from './annotation-popup.js';
import { appendSelectionMath } from './rendered-markdown-dom.js';
import { createMathRenderBudget } from '../markdown/markdown-html.js';
import { createLocalization } from '../i18n/localization.js';
import { LUCIDE_ICONS } from '../icons/lucide-icon.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function createTranslationSourcePopup(parent, {
    localization = createLocalization(), renderSelectionActions, copySource,
}) {
    const t = localization.t.bind(localization);
    const popup = createAnchoredPopup(parent, {
        className: 'mktero-annotation-popup mktero-annotation-popup--actions mktero-translation-source-popup',
        idPrefix: 'mktero-translation-source-popup',
        constrainToParent: true,
        stableContentPosition: true,
        stableContentHeight: 200,
    });
    let current = null;

    function open(options) {
        if (!options.anchor) return popup.close();
        if (current?.anchor === options.anchor) {
            current.refresh(options);
            return;
        }
        popup.open({
            anchor: options.anchor,
            label: t('ai.translationSourceLabel'),
            dismissOnMouseLeave: false,
            onClose: () => { current = null; },
            renderContent(context) {
                const { document, reposition } = context;
                const container = element(document, 'div', 'mktero-translation-source-content');
                // In Gecko a button press can otherwise move the native selection into this popup.
                container.addEventListener('mousedown', event => {
                    if (event.button === 0 && event.target.closest?.('button')) event.preventDefault();
                });
                let pending = false;
                let deferred = null;
                const refresh = next => {
                    if (pending) {
                        deferred = next;
                        return;
                    }
                    const oldScroll = container.querySelector('.mktero-translation-source-scroll');
                    const scrollTop = oldScroll?.scrollTop || 0;
                    const error = container.querySelector('.mktero-annotation-action-error:not([hidden])');
                    const focused = container.getRootNode().activeElement;
                    const restoreFocus = container.contains(focused);
                    const originalResult = createOriginalResult(document, t, next, context, copySource);
                    const content = renderSelectionActions(context, {
                        ...next,
                        originalResult: {
                            element: originalResult,
                            blockOnly: next.blockOnly,
                            setBusy(busy) {
                                pending = busy;
                                for (const button of originalResult.querySelectorAll('button')) {
                                    button.disabled = busy;
                                }
                                if (!busy && deferred && content.isConnected) {
                                    const latest = deferred;
                                    deferred = null;
                                    refresh(latest);
                                }
                            },
                        },
                    });
                    if (error) {
                        const nextError = content.querySelector('.mktero-annotation-action-error');
                        nextError.textContent = error.textContent;
                        nextError.hidden = false;
                    }
                    container.replaceChildren(content);
                    if (restoreFocus) {
                        const nextFocus = [...content.querySelectorAll('button')].find(node => !node.disabled
                            && node.dataset.color === focused.dataset.color
                            && node.dataset.action === focused.dataset.action);
                        (nextFocus || content.querySelector('.mktero-translation-source-scroll')).focus({ preventScroll: true });
                    }
                    content.querySelector('.mktero-translation-source-scroll').scrollTop = scrollTop;
                    reposition();
                };
                current = { anchor: options.anchor, refresh, reposition };
                refresh(options);
                return container;
            },
        });
    }

    return { ...popup, open, reposition: () => current?.reposition() };
}

function createOriginalResult(document, t, {
    excerpts, hasSentenceGroup, unavailable, locateSource, blockOnly, canAnnotate,
}, { close, reposition }, copySource) {
    const result = element(document, 'div', 'mktero-selection-translation');
    const label = element(document, 'div', 'mktero-selection-translation-status mktero-translation-source-label');
    label.textContent = t(hasSentenceGroup ? 'ai.translationSourceGroupLabel' : 'ai.translationSourceLabel');
    const scroll = element(document, 'div', 'mktero-translation-source-scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', label.textContent);
    let previousMatchedText = null;
    const mathBudget = createMathRenderBudget();
    for (const excerpt of excerpts) {
        let text = previousMatchedText;
        if (text && !excerpt.wholeBlock) {
            text.append(excerpt.separator ?? '\n\n');
        }
        else {
            text = element(document, 'div', 'mktero-selection-translation-result mktero-translation-source-text');
            text.dir = 'auto';
            scroll.appendChild(text);
        }
        if (excerpt.mathSegments) appendSelectionMath(text, excerpt.mathSegments, mathBudget);
        else text.append(excerpt.text);
        previousMatchedText = excerpt.wholeBlock ? null : text;
    }
    if (unavailable) {
        const notice = element(document, 'div', 'mktero-selection-translation-status mktero-translation-source-unavailable');
        notice.setAttribute('role', 'status');
        notice.textContent = unavailable;
        scroll.appendChild(notice);
    }
    result.append(label, scroll);
    const footer = element(document, 'div', 'mktero-selection-translation-actions');
    if (locateSource) {
        const annotateInOriginal = blockOnly && canAnnotate;
        const label = t(annotateInOriginal ? 'ai.translationSourceAnnotateInOriginal' : 'ai.translationSourceLocate');
        const locate = createSelectionResultButton(document, 'locate-source', label, LUCIDE_ICONS.bookOpen);
        if (annotateInOriginal) {
            locate.classList.add('mktero-selection-translation-button--labeled');
            locate.append(label);
        }
        locate.addEventListener('click', () => {
            if (!locate.isConnected || locate.disabled) return;
            close();
            locateSource();
        });
        footer.appendChild(locate);
    }
    if (typeof copySource === 'function' && excerpts.length) {
        const copy = createSelectionResultButton(document, 'copy-original', t('ai.translationSourceCopyOriginal'), LUCIDE_ICONS.copy);
        const status = element(document, 'span', 'mktero-source-copy-status');
        status.setAttribute('role', 'status');
        let copying = false;
        copy.addEventListener('click', async () => {
            if (!copy.isConnected || copy.disabled || copying) return;
            copying = true;
            status.textContent = '';
            try {
                await copySource(excerpts.map((excerpt, index) => (index ? excerpt.separator ?? '\n\n' : '') + excerpt.text).join(''));
                if (!copy.isConnected) return;
                status.textContent = t('ai.translationSourceCopied');
            }
            catch {
                if (copy.isConnected) status.textContent = t('ai.translationSourceCopyOriginalFailed');
            }
            finally {
                copying = false;
                if (copy.isConnected) reposition();
            }
        });
        footer.prepend(status);
        footer.appendChild(copy);
    }
    if (footer.childElementCount) result.appendChild(footer);
    return result;
}

function element(document, tag, className) {
    const node = document.createElementNS(XHTML_NAMESPACE, tag);
    node.className = className;
    return node;
}
