import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import { translateEnglish } from '../i18n/localization.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const STYLE_ID = 'mktero-diagnostics-style';
const openByParent = new WeakMap();

export function openDiagnosticReportDialog({
    document,
    parent,
    translate = translateEnglish,
    buildReport,
    copyText,
    saveText,
}) {
    pruneClosedDialogs();
    if (!document?.createElementNS || !parent?.appendChild) {
        throw new TypeError('A document and parent are required');
    }
    if (typeof buildReport !== 'function') {
        throw new TypeError('A diagnostic report builder is required');
    }
    const existing = openByParent.get(parent);
    if (existing?.isOpen()) {
        existing.focus();
        return existing;
    }
    ensureStyle(document);
    const dialog = createDialog({
        document,
        parent,
        translate,
        buildReport,
        copyText,
        saveText,
    });
    openByParent.set(parent, dialog);
    return dialog;
}

export function closeDiagnosticReportDialogs(ownerDocument = null) {
    for (const dialog of [...openDialogs]) {
        if (ownerDocument && dialog.element?.ownerDocument !== ownerDocument) continue;
        dialog.close();
    }
}

function pruneClosedDialogs() {
    for (const dialog of [...openDialogs]) {
        if (!dialog.isOpen()) dialog.close();
    }
}

const openDialogs = new Set();

function createDialog({
    document,
    parent,
    translate,
    buildReport,
    copyText,
    saveText,
}) {
    const element = (tagName, attributes = {}, text = '') => {
        const node = document.createElementNS(XHTML_NAMESPACE, tagName);
        for (const [name, value] of Object.entries(attributes)) {
            node.setAttribute(name, String(value));
        }
        if (text) node.textContent = text;
        return node;
    };
    const backdrop = element('div', { class: 'mktero-diagnostics-backdrop' });
    const modal = element('section', {
        class: 'mktero-diagnostics-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'mktero-diagnostics-title',
    });
    const title = element(
        'h2',
        { id: 'mktero-diagnostics-title', class: 'mktero-diagnostics-title' },
        translate('diagnostics.title')
    );
    const close = element('button', {
        class: 'mktero-diagnostics-close',
        type: 'button',
        'aria-label': translate('diagnostics.close'),
        title: translate('diagnostics.close'),
    });
    close.appendChild(createLucideIcon(document, LUCIDE_ICONS.x, { size: 16 }));
    const header = element('div', { class: 'mktero-diagnostics-header' });
    header.append(title, close);
    const note = element(
        'p',
        { class: 'mktero-diagnostics-note' },
        translate('diagnostics.note')
    );
    const happened = field(element, {
        id: 'mktero-diagnostics-happened',
        label: translate('diagnostics.whatHappened'),
        placeholder: translate('diagnostics.whatHappenedPlaceholder'),
        required: true,
    });
    const expected = field(element, {
        id: 'mktero-diagnostics-expected',
        label: translate('diagnostics.expected'),
        placeholder: translate('diagnostics.expectedPlaceholder'),
    });
    const email = element('input', {
        id: 'mktero-diagnostics-email',
        class: 'mktero-diagnostics-checkbox',
        type: 'checkbox',
    });
    const emailLabel = element('label', {
        class: 'mktero-diagnostics-check',
        for: 'mktero-diagnostics-email',
    });
    emailLabel.append(email, element(
        'span',
        {},
        translate('diagnostics.includeEmail')
    ));
    const previewLabel = element(
        'span',
        { id: 'mktero-diagnostics-preview-label', class: 'mktero-diagnostics-label' },
        translate('diagnostics.preview')
    );
    const preview = element('pre', {
        id: 'mktero-diagnostics-preview',
        class: 'mktero-diagnostics-preview',
        'aria-labelledby': 'mktero-diagnostics-preview-label',
    }, translate('diagnostics.previewEmpty'));
    const status = element('p', {
        class: 'mktero-diagnostics-status',
        role: 'status',
        'aria-live': 'polite',
    });
    status.hidden = true;
    const copy = element('button', {
        class: 'mktero-diagnostics-button',
        type: 'button',
        'data-diagnostic-action': 'copy',
    }, translate('diagnostics.copy'));
    const save = element('button', {
        class: 'mktero-diagnostics-button mktero-diagnostics-button--primary',
        type: 'button',
        'data-diagnostic-action': 'save',
    }, translate('diagnostics.save'));
    const actions = element('footer', { class: 'mktero-diagnostics-actions' });
    actions.append(copy, save);
    const body = element('div', { class: 'mktero-diagnostics-body' });
    body.append(
        note,
        happened.field,
        expected.field,
        emailLabel,
        previewLabel,
        preview,
        status
    );
    modal.append(header, body, actions);
    backdrop.appendChild(modal);

    let closed = false;
    let generation = 0;
    let latestText = '';
    let latestFileName = '';
    let busy = false;

    const input = () => ({
        note: happened.input.value,
        expected: expected.input.value,
        includeAccountEmail: email.checked,
    });
    const setStatus = (message = '') => {
        status.textContent = message;
        status.hidden = !message;
    };
    const syncActions = () => {
        const ready = !busy
            && latestText.length > 0
            && happened.input.value.trim();
        copy.disabled = !ready;
        save.disabled = !ready;
    };
    const refresh = () => {
        const current = ++generation;
        latestText = '';
        syncActions();
        setStatus('');
        Promise.resolve()
            .then(() => buildReport(input()))
            .then(report => {
                if (closed || current !== generation) return;
                latestText = String(report?.text || '');
                latestFileName = String(report?.fileName || 'mktero-diagnostics.json');
                preview.textContent = latestText || translate('diagnostics.previewEmpty');
                syncActions();
            })
            .catch(() => {
                if (closed || current !== generation) return;
                latestText = '';
                preview.textContent = translate('diagnostics.previewFailed');
                syncActions();
            });
    };
    const finish = () => {
        if (closed) return;
        closed = true;
        generation += 1;
        openDialogs.delete(api);
        if (openByParent.get(parent) === api) openByParent.delete(parent);
        backdrop.remove();
    };
    const lockActions = locked => {
        busy = locked;
        syncActions();
    };
    const copyReport = () => {
        if (copy.disabled || typeof copyText !== 'function') return;
        const text = latestText;
        lockActions(true);
        Promise.resolve(copyText(text))
            .then(() => {
                if (closed) return;
                setStatus(translate('diagnostics.copied'));
                lockActions(false);
            })
            .catch(() => {
                if (closed) return;
                setStatus(translate('diagnostics.copyFailed'));
                lockActions(false);
            });
    };
    const saveReport = () => {
        if (save.disabled || typeof saveText !== 'function') return;
        const text = latestText;
        const fileName = latestFileName;
        lockActions(true);
        Promise.resolve(saveText(fileName, text))
            .then(result => {
                if (closed) return;
                setStatus(result?.status === 'saved'
                    ? translate('diagnostics.saved')
                    : '');
                lockActions(false);
            })
            .catch(() => {
                if (closed) return;
                setStatus(translate('diagnostics.saveFailed'));
                lockActions(false);
            });
    };

    close.addEventListener('click', finish);
    copy.addEventListener('click', copyReport);
    save.addEventListener('click', saveReport);
    happened.input.addEventListener('input', refresh);
    expected.input.addEventListener('input', refresh);
    email.addEventListener('change', refresh);
    backdrop.addEventListener('pointerdown', event => {
        if (event.target === backdrop) finish();
    });
    backdrop.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            finish();
            return;
        }
        if (event.key !== 'Tab') return;
        const items = focusable(modal);
        if (!items.length) return;
        const active = activeElementWithin(parent, document);
        const index = items.indexOf(active);
        event.preventDefault();
        const next = event.shiftKey
            ? items[(index <= 0 ? items.length : index) - 1]
            : items[(index + 1) % items.length];
        next.focus?.();
    });

    parent.appendChild(backdrop);
    const api = {
        element: backdrop,
        isOpen: () => !closed && backdrop.isConnected !== false,
        focus() {
            happened.input.focus?.();
        },
        close: finish,
    };
    openDialogs.add(api);
    refresh();
    scheduleDocumentMicrotask(document, () => {
        if (!closed) happened.input.focus?.();
    });
    return api;
}

function field(element, { id, label, placeholder, required = false }) {
    const labelNode = element('label', {
        class: 'mktero-diagnostics-label',
        for: id,
    }, label);
    const input = element('textarea', {
        id,
        class: 'mktero-diagnostics-input',
        maxlength: '4000',
        ...(required ? { required: 'true' } : {}),
        ...(placeholder ? { placeholder } : {}),
    });
    const wrapper = element('div', { class: 'mktero-diagnostics-field' });
    wrapper.append(labelNode, input);
    return { field: wrapper, input };
}

function focusable(modal) {
    return [...modal.querySelectorAll('textarea, input, button')].filter(node => (
        !node.disabled && node.hidden !== true
    ));
}

function activeElementWithin(parent, document) {
    return parent.getRootNode?.()?.activeElement || document.activeElement;
}

function scheduleDocumentMicrotask(document, callback) {
    const ownerWindow = document.defaultView;
    if (typeof ownerWindow?.queueMicrotask === 'function') {
        ownerWindow.queueMicrotask(callback);
        return;
    }
    if (typeof ownerWindow?.Promise?.resolve === 'function') {
        ownerWindow.Promise.resolve().then(callback);
        return;
    }
    callback();
}

function ensureStyle(document) {
    const root = document.documentElement || document;
    if (root.querySelector?.(`#${STYLE_ID}`) || document.getElementById?.(STYLE_ID)) {
        return;
    }
    const style = document.createElementNS(XHTML_NAMESPACE, 'style');
    style.id = STYLE_ID;
    style.textContent = DIAGNOSTIC_DIALOG_STYLE;
    (document.head || document.documentElement || root).appendChild(style);
}

const DIAGNOSTIC_DIALOG_STYLE = `
.mktero-diagnostics-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    display: grid;
    padding: clamp(18px, 4vh, 48px) clamp(18px, 4vw, 64px);
    background: rgb(20 27 36 / 46%);
    place-items: center;
}
.mktero-diagnostics-dialog {
    display: flex;
    width: min(520px, 100%);
    max-height: min(640px, 100%);
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border, #d3d8de);
    border-radius: 10px;
    background: var(--surface, #e9edf1);
    color: var(--text, #20252b);
    box-shadow: var(--shadow-float, 0 8px 24px rgb(28 36 46 / 14%));
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.mktero-diagnostics-header {
    display: flex;
    min-height: 44px;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid var(--border, #d3d8de);
    padding: 0 8px 0 16px;
}
.mktero-diagnostics-title {
    margin: 0;
    overflow: hidden;
    font-size: 1rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.mktero-diagnostics-close {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--muted, #68717b);
    cursor: pointer;
    padding: 6px;
}
.mktero-diagnostics-body {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
    padding: 16px;
}
.mktero-diagnostics-note,
.mktero-diagnostics-status {
    margin: 0;
    color: var(--muted, #68717b);
    font-size: 0.8125rem;
}
.mktero-diagnostics-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.mktero-diagnostics-label {
    color: var(--muted, #68717b);
    font-size: 0.8125rem;
    font-weight: 600;
}
.mktero-diagnostics-input,
.mktero-diagnostics-preview {
    border: 1px solid var(--border, #d3d8de);
    border-radius: 6px;
    background: var(--surface-raised, #ffffff);
    color: inherit;
    font: inherit;
}
.mktero-diagnostics-input {
    min-height: 72px;
    resize: vertical;
    padding: 8px;
}
.mktero-diagnostics-check {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--text, #20252b);
    font-size: 0.8125rem;
}
.mktero-diagnostics-preview {
    max-height: 160px;
    overflow: auto;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.45;
    padding: 8px;
}
.mktero-diagnostics-actions {
    display: flex;
    flex: none;
    justify-content: flex-end;
    gap: 8px;
    border-top: 1px solid var(--border, #d3d8de);
    padding: 12px 16px;
}
.mktero-diagnostics-button {
    border: 1px solid var(--border, #d3d8de);
    border-radius: 6px;
    background: var(--surface-raised, #ffffff);
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 6px 12px;
}
.mktero-diagnostics-button--primary {
    border-color: transparent;
    background: #4072e5;
    color: #ffffff;
}
.mktero-diagnostics-button:disabled {
    cursor: default;
    opacity: 0.55;
}
@media (prefers-color-scheme: dark) {
    .mktero-diagnostics-dialog {
        border-color: var(--border, #424a55);
        background: var(--surface, #22262c);
        color: var(--text, #edf1f5);
    }
    .mktero-diagnostics-input,
    .mktero-diagnostics-preview,
    .mktero-diagnostics-button {
        border-color: var(--border, #424a55);
        background: var(--surface-raised, #2b3038);
    }
}
@media (prefers-reduced-motion: reduce) {
    .mktero-diagnostics-backdrop,
    .mktero-diagnostics-dialog {
        transition: none;
    }
}
`;
