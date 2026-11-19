import { createAnchoredPopup } from './anchored-popup.js';
import { createSourceBlockAnnotationAction } from './annotation-popup.js';
import { createLocalization } from '../i18n/localization.js';
import { createLucideIcon, LUCIDE_ICONS } from '../icons/lucide-icon.js';
import {
    createWholeBlockActions,
    normalizeWholeBlockActions,
} from './translation-legacy-actions.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_SOURCE_BLOCKS = 8;

export function createTranslationSourcePopup(parent, {
    localization = createLocalization(),
    createMarkdownAnnotation,
    revealSource = null,
    copyTranslation = null,
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-translation-source-popup',
        idPrefix: 'mktero-translation-source-popup',
        viewportPadding: 16,
        constrainToParent: true,
        stableContentPosition: true,
        stableContentWidth: 420,
        stableContentHeight: 200,
    });
    let active = null;

    return {
        open({
            anchor,
            source,
            translatedText = '',
            locateSource = null,
            previewExpanded = false,
            annotation = null,
            selectionContext,
            annotationUnavailable = null,
            blockCount = 1,
            wholeBlockActions = [],
            isCurrent = null,
        }) {
            const options = {
                source,
                text: String(source?.text || ''),
                hasSentenceGroup: source?.hasSentenceGroup === true,
                translatedText: typeof translatedText === 'string' ? translatedText : '',
                locateSource,
                annotation,
                selectionContext,
                annotationUnavailable: annotationUnavailable || (blockCount > MAX_SOURCE_BLOCKS
                    ? t('annotation.sourceBlockUnavailable', { count: MAX_SOURCE_BLOCKS }) : null),
                blockCount,
                wholeBlocks: normalizeWholeBlockActions(wholeBlockActions),
                isCurrent,
            };
            const canPreview = options.text.trim() || options.wholeBlocks.length
                || annotation || options.annotationUnavailable;
            const canCopy = typeof copyTranslation === 'function' && options.translatedText.trim();
            if (!anchor || (!canPreview && !canCopy)) {
                anchoredPopup.close();
                return;
            }
            if (active?.anchor === anchor && anchoredPopup.isOpen()) {
                anchoredPopup.cancelClose();
                active.content.refresh(options);
                return;
            }
            anchoredPopup.open({
                anchor,
                label: t(canPreview ? 'ai.translationSourceLabel' : 'ai.translationSourceActions'),
                dismissOnMouseLeave: false,
                onClose: () => { active = null; },
                renderContent({ document, close, reposition }) {
                    const content = createContent(document, t, options, {
                        createMarkdownAnnotation, revealSource, copyTranslation,
                        close, reposition, previewExpanded,
                    });
                    active = { anchor, content };
                    return content.element;
                },
            });
            active?.content.resetPreviewScroll();
        },
        close: anchoredPopup.close,
        contains: anchoredPopup.contains,
        isOpen: anchoredPopup.isOpen,
        destroy: anchoredPopup.destroy,
    };
}

function createContent(document, t, initialOptions, {
    createMarkdownAnnotation, revealSource, copyTranslation, close, reposition, previewExpanded,
}) {
    let options = initialOptions;
    let revision = 0;
    let panelRevision = 0;
    let panel = previewExpanded ? 'preview' : null;
    let preview = null;
    let previewNeedsScrollReset = false;
    let copying = false;
    const element = createElement(document, 'div', 'mktero-translation-source');
    const toolbar = createElement(document, 'div', 'mktero-translation-source-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', t('ai.translationSourceActions'));
    const previewButton = createButton(document, 'preview-source');
    previewButton.append(
        document.createTextNode(t('ai.translationSourcePreview')),
        createLucideIcon(document, LUCIDE_ICONS.chevronDown, {
            className: 'mktero-translation-source-chevron', size: 12,
        })
    );
    const copyButton = createButton(document, 'copy-translation');
    copyButton.textContent = t('ai.translationSourceCopy');
    const status = createElement(document, 'div', 'mktero-translation-source-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    element.append(toolbar, status);

    const isCurrent = () => element.isConnected && options.isCurrent?.() !== false;
    const canUse = button => button.isConnected && !button.disabled && isCurrent();
    const hasPreview = () => Boolean(options.text.trim() || options.wholeBlocks.length
        || options.annotation || options.annotationUnavailable);
    const guardedWholeBlocks = () => options.wholeBlocks.map(action => ({
        ...action,
        onShowBlock: () => {
            if (panel !== 'preview' || !isCurrent()) return;
            return action.onShowBlock();
        },
    }));

    const detachSave = save => {
        save.update({ createMarkdownAnnotation: null, isCurrent: () => false, label: '' });
        save.button.remove();
        save.error.remove();
    };

    const refreshPreviewSave = () => {
        const canSave = options.annotation && !options.annotationUnavailable;
        const previous = preview.saveOptions;
        if (preview.save && (!canSave || ['annotation', 'selectionContext', 'text', 'translatedText', 'blockCount']
            .some(key => previous[key] !== options[key]))) {
            detachSave(preview.save);
            preview.details.remove();
            preview.save = null;
            preview.locate.disabled = false;
        }
        if (!canSave) return;
        if (!preview.save) {
            const details = createElement(document, 'details', 'mktero-translation-annotation-details');
            const scope = createElement(document, 'summary', 'mktero-related-source-scope');
            // Firefox otherwise moves the native text selection into the
            // summary before click, dismissing its translated-selection popup.
            scope.addEventListener('mousedown', event => {
                if (event.button === 0) event.preventDefault();
            });
            const body = createElement(document, 'div', 'mktero-translation-annotation-text');
            body.setAttribute('dir', 'auto');
            body.tabIndex = 0;
            details.append(scope, body);
            details.addEventListener('toggle', () => {
                if (preview.details !== details || panel !== 'preview' || !isCurrent()) return;
                reposition();
                if (details.open) {
                    // Native details may preserve a scroll offset while its flex
                    // height changes. Begin each review at the complete first line.
                    details.getBoundingClientRect();
                    details.scrollTop = 0;
                }
            });
            const save = createSourceBlockAnnotationAction(document, t);
            save.button.dataset.action = 'annotate-source';
            save.button.classList.add('mktero-translation-source-action');
            preview.element.insertBefore(details, preview.actions);
            preview.actions.appendChild(save.button);
            preview.element.insertBefore(save.error, preview.unavailable);
            Object.assign(preview, { details, scope, annotationBody: body, save });
        }
        preview.saveOptions = options;
        preview.scope.textContent = t(options.blockCount > 1
            ? 'ai.translationSourceSaveScopePlural' : 'ai.translationSourceSaveScope',
        { count: options.blockCount });
        preview.annotationBody.textContent = String(options.annotation.text || '');
        const save = preview.save;
        const currentPanelRevision = panelRevision;
        const saveIsCurrent = () => preview.save === save
            && panel === 'preview' && currentPanelRevision === panelRevision && isCurrent();
        save.update({
            annotation: options.annotation,
            selectionContext: options.selectionContext,
            createMarkdownAnnotation: typeof createMarkdownAnnotation === 'function'
                ? async (...args) => {
                    try {
                        await createMarkdownAnnotation(...args);
                    }
                    catch (error) {
                        if (saveIsCurrent()) throw error;
                    }
                } : null,
            close: () => { if (saveIsCurrent()) close(); },
            reposition,
            isCurrent: saveIsCurrent,
            locate: preview.locate,
            label: t('ai.translationSourceSaveAnnotation'),
        });
    };

    const refreshPreview = () => {
        if (!preview) return;
        const { body, label, actions, locate, unavailable } = preview;
        const hasText = Boolean(options.text.trim());
        label.textContent = t(options.hasSentenceGroup
            ? 'ai.translationSourceGroupLabel' : 'ai.translationSourceLabel');
        if (body.textContent !== options.text) previewNeedsScrollReset = true;
        body.textContent = options.text;
        if (hasText) {
            if (label.parentNode !== preview.element) preview.element.insertBefore(label, actions);
            if (body.parentNode !== preview.element) preview.element.insertBefore(body, actions);
        }
        else {
            label.remove();
            body.remove();
        }
        const canLocate = hasText && (typeof options.locateSource === 'function'
            || typeof revealSource === 'function');
        if (canLocate && locate.parentNode !== actions) actions.prepend(locate);
        else if (!canLocate) locate.remove();
        refreshPreviewSave();
        actions.hidden = !canLocate && !preview.save;
        unavailable.textContent = options.annotationUnavailable || '';
        unavailable.hidden = !unavailable.textContent;
        const blocks = guardedWholeBlocks();
        if (preview.legacy && !preview.legacy.refresh(blocks)) {
            // Removing the focused Show button is our own update, not a user
            // leaving the popup. Mark it hidden before Gecko/Blink blur it.
            preview.legacy.element.hidden = true;
            preview.legacy.element.remove();
            preview.legacy = null;
        }
        if (!preview.legacy && blocks.length) {
            preview.legacy = createWholeBlockActions(document, blocks, t, reposition);
            preview.element.appendChild(preview.legacy.element);
        }
    };

    const resetPreviewScroll = () => {
        if (!previewNeedsScrollReset || !element.isConnected || panel !== 'preview') return;
        // Gecko can restore the old scroll frame onto newly mounted source text.
        // Flush that layout before explicitly starting the new excerpt at its beginning.
        preview.body.getBoundingClientRect();
        preview.body.scrollTop = 0;
        previewNeedsScrollReset = false;
    };

    const createPreview = () => {
        const content = createElement(document, 'div', 'mktero-translation-source-preview');
        const label = createElement(document, 'div', 'mktero-translation-source-label');
        label.textContent = t('ai.translationSourceLabel');
        const body = createElement(document, 'div', 'mktero-translation-source-text');
        body.setAttribute('dir', 'auto');
        body.tabIndex = 0;
        const actions = createElement(document, 'div', 'mktero-translation-source-actions');
        const locate = createButton(document, 'locate-source');
        locate.textContent = t('ai.translationSourceLocate');
        locate.addEventListener('click', () => {
            if (panel !== 'preview' || !canUse(locate)) return;
            const { locateSource, source } = options;
            close();
            if (typeof locateSource === 'function') locateSource();
            else revealSource(source);
        });
        const unavailable = createElement(document, 'div', 'mktero-translation-source-unavailable');
        unavailable.setAttribute('role', 'status');
        unavailable.hidden = true;
        content.append(label, body, actions, unavailable);
        element.insertBefore(content, status);
        preview = { element: content, label, body, actions, locate, unavailable, legacy: null, save: null };
    };

    const render = () => {
        if (panel === 'preview' && !hasPreview()) {
            panel = null;
            panelRevision++;
        }
        if (panel === 'preview' && !preview) createPreview();
        refreshPreview();
        if (preview) preview.element.hidden = panel !== 'preview';
        element.dataset.panel = panel || 'collapsed';
        previewButton.setAttribute('aria-expanded', String(panel === 'preview'));
        const buttons = [
            hasPreview() ? previewButton : null,
            typeof copyTranslation === 'function' && options.translatedText.trim() ? copyButton : null,
        ].filter(Boolean);
        if (buttons.length !== toolbar.children.length
            || buttons.some((button, index) => toolbar.children[index] !== button)) {
            toolbar.replaceChildren(...buttons);
        }
        reposition();
        resetPreviewScroll();
    };

    previewButton.addEventListener('click', () => {
        if (!canUse(previewButton)) return;
        panel = panel === 'preview' ? null : 'preview';
        panelRevision++;
        render();
    });
    copyButton.addEventListener('click', async () => {
        if (copying || !canUse(copyButton)) return;
        const currentRevision = revision;
        const text = options.translatedText;
        copying = true;
        copyButton.disabled = true;
        status.textContent = '';
        status.hidden = true;
        try {
            await copyTranslation(text);
        }
        catch {
            if (currentRevision !== revision || !isCurrent()) return;
            status.textContent = t('ai.translationSourceCopyFailed');
            status.hidden = false;
            reposition();
        }
        finally {
            copying = false;
            copyButton.disabled = false;
        }
    });

    render();
    return {
        element,
        resetPreviewScroll,
        refresh(next) {
            // A scroll or fallback reveal advances the selection epoch without
            // changing its anchor. Keep panel/action state and use fresh guards.
            options = next;
            revision++;
            element.parentElement?.setAttribute('aria-label', t(hasPreview()
                ? 'ai.translationSourceLabel' : 'ai.translationSourceActions'));
            render();
        },
    };
}

function createElement(document, tag, className) {
    const element = document.createElementNS(XHTML_NAMESPACE, tag);
    element.className = className;
    return element;
}

function createButton(document, action) {
    const button = createElement(document, 'button', 'mktero-translation-source-action');
    button.type = 'button';
    button.dataset.action = action;
    return button;
}
