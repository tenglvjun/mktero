const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function normalizeWholeBlockActions(actions) {
    if (!Array.isArray(actions)) return [];
    const ids = new Set();
    return actions.filter(action => {
        if (!action?.id || ids.has(action.id)
            || typeof action.onShowBlock !== 'function') return false;
        ids.add(action.id);
        return true;
    });
}

export function sourceBlockAnnotationLabels(t, count) {
    return count > 1 ? {
        scope: t('annotation.sourceBlockScopePlural', { count }),
        action: t('annotation.sourceBlockHighlightPlural', { count }),
    } : {
        scope: t('annotation.sourceBlockScope'),
        action: t('annotation.sourceBlockHighlight'),
    };
}

export function createWholeBlockActions(document, actions, t, reposition) {
    const element = document.createElementNS(XHTML_NAMESPACE, 'div');
    element.className = 'mktero-translation-legacy-actions';
    element.style.setProperty('max-height', 'min(45vh, 320px)');
    element.style.setProperty('overflow', 'auto');
    const rows = actions.map((action, index) => createWholeBlockRow(
        document, action, t, reposition, index, actions.length
    ));
    element.append(...rows.map(row => row.element));
    return {
        element,
        refresh(next) {
            if (next.length !== rows.length
                || !rows.every((row, index) => row.id === next[index].id)) return false;
            rows.forEach((row, index) => row.refresh(next[index]));
            return true;
        },
    };
}

function createWholeBlockRow(document, initialAction, t, reposition, index, count) {
    let action = initialAction;
    const element = document.createElementNS(XHTML_NAMESPACE, 'section');
    element.className = 'mktero-selection-translation mktero-translation-legacy-block';
    element.dataset.translationBlockId = action.id;
    const title = appendText(element, 'mktero-translation-source-label',
        count > 1 ? t('ai.translationLegacyBlockNumbered', { number: index + 1 })
            : t('ai.translationLegacyBlock'));
    element.setAttribute('aria-label', title.textContent);
    const controls = appendText(element, 'mktero-translation-source-actions');
    const show = appendButton(controls, 'show-source-block', t('ai.translationLegacyShow'));
    const showError = appendText(element, 'mktero-selection-translation-error');
    showError.setAttribute('role', 'status');
    let original = null;
    show.addEventListener('click', () => {
        if (!element.isConnected) return;
        showError.textContent = '';
        try {
            const text = action.onShowBlock();
            if (typeof text === 'string' && text.trim() && element.isConnected) {
                if (!original) {
                    original = appendText(element, 'mktero-translation-source-text');
                    original.setAttribute('dir', 'auto');
                    original.tabIndex = -1;
                }
                original.textContent = text;
                original.focus();
            }
        }
        catch {
            showError.textContent = t('ai.translationLegacyShowFailed');
        }
        if (element.isConnected) reposition();
    });
    return {
        element,
        id: initialAction.id,
        refresh: next => { action = next; },
    };
}

function appendText(parent, className, text = '') {
    const element = parent.ownerDocument.createElementNS(XHTML_NAMESPACE, 'div');
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
}

function appendButton(parent, action, text) {
    const button = parent.ownerDocument.createElementNS(XHTML_NAMESPACE, 'button');
    button.type = 'button';
    button.className = 'mktero-translation-source-action';
    button.dataset.action = action;
    button.textContent = text;
    parent.appendChild(button);
    return button;
}
