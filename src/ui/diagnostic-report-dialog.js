import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import { translateEnglish } from '../i18n/localization.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const STYLE_ID = 'mktero-diagnostics-style';
const NOTE_LIMIT = 4000;
const openByParent = new WeakMap();
const openDialogs = new Set();
const styledDocuments = new Set();

// openDiagnosticReportDialog shows a local problem report. Nothing here sends
// data: Copy and Save hand the redacted text to the user, and Open GitHub
// issue only opens the empty issue form.
export function openDiagnosticReportDialog({
    document,
    parent,
    translate = translateEnglish,
    buildReport,
    copyText,
    saveText,
    openIssue = null,
    returnFocus = null,
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
        openIssue,
        returnFocus: returnFocus || activeElementWithin(parent, document),
    });
    openByParent.set(parent, dialog);
    return dialog;
}

// closeDiagnosticReportDialogs closes the dialogs of one document, or of all
// documents, and removes the stylesheet it injected there. A plugin update
// without a Zotero restart then finds no rules from the previous build.
export function closeDiagnosticReportDialogs(ownerDocument = null) {
    for (const dialog of [...openDialogs]) {
        if (ownerDocument && dialog.element?.ownerDocument !== ownerDocument) continue;
        dialog.close({ restoreFocus: false });
    }
    for (const document of [...styledDocuments]) {
        if (ownerDocument && document !== ownerDocument) continue;
        removeStyle(document);
    }
}

function pruneClosedDialogs() {
    for (const dialog of [...openDialogs]) {
        if (!dialog.isOpen()) dialog.close({ restoreFocus: false });
    }
}

function createDialog({
    document,
    parent,
    translate,
    buildReport,
    copyText,
    saveText,
    openIssue,
    returnFocus,
}) {
    const element = (tagName, attributes = {}, text = '') => {
        const node = document.createElementNS(XHTML_NAMESPACE, tagName);
        for (const [name, value] of Object.entries(attributes)) {
            node.setAttribute(name, String(value));
        }
        if (text) node.textContent = text;
        return node;
    };
    const button = (attributes, icon, label) => {
        const node = element('button', { type: 'button', ...attributes });
        if (icon) {
            node.appendChild(createLucideIcon(document, icon, {
                className: 'mktero-diagnostics-button-icon',
                size: 14,
            }));
        }
        node.appendChild(element('span', {}, label));
        return node;
    };

    const backdrop = element('div', { class: 'mktero-diagnostics-backdrop' });
    const modal = element('section', {
        class: 'mktero-diagnostics-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'mktero-diagnostics-title',
        'aria-describedby': 'mktero-diagnostics-note',
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

    const note = element('p', {
        id: 'mktero-diagnostics-note',
        class: 'mktero-diagnostics-note',
    }, translate('diagnostics.note'));
    const happenedLabel = element('label', {
        class: 'mktero-diagnostics-label',
        for: 'mktero-diagnostics-happened',
    }, translate('diagnostics.whatHappened'));
    happenedLabel.appendChild(element('span', {
        class: 'mktero-diagnostics-required',
    }, translate('diagnostics.required')));
    const happened = element('textarea', {
        id: 'mktero-diagnostics-happened',
        class: 'mktero-diagnostics-input',
        maxlength: String(NOTE_LIMIT),
        required: 'true',
        'aria-required': 'true',
        'aria-describedby': 'mktero-diagnostics-hint',
        rows: '3',
        placeholder: translate('diagnostics.whatHappenedPlaceholder'),
    });
    const hint = element('p', {
        id: 'mktero-diagnostics-hint',
        class: 'mktero-diagnostics-hint',
    }, translate('diagnostics.describeToEnable'));
    const field = element('div', { class: 'mktero-diagnostics-field' });
    field.append(happenedLabel, happened, hint);

    const summaryTitle = element('h3', {
        id: 'mktero-diagnostics-summary-title',
        class: 'mktero-diagnostics-label',
    }, translate('diagnostics.included'));
    const summary = element('dl', {
        class: 'mktero-diagnostics-summary',
        'aria-labelledby': 'mktero-diagnostics-summary-title',
    });
    summary.appendChild(element('dd', {}, translate('diagnostics.previewLoading')));
    const toggle = element('button', {
        class: 'mktero-diagnostics-link',
        type: 'button',
        'aria-expanded': 'false',
        'aria-controls': 'mktero-diagnostics-preview',
    }, translate('diagnostics.showFull'));
    const preview = element('pre', {
        id: 'mktero-diagnostics-preview',
        class: 'mktero-diagnostics-preview',
        tabindex: '0',
        'aria-label': translate('diagnostics.fullReport'),
    });
    preview.hidden = true;

    const destination = element('div', { class: 'mktero-diagnostics-destination' });
    destination.appendChild(element(
        'p',
        { class: 'mktero-diagnostics-hint' },
        translate('diagnostics.destination')
    ));
    let issue = null;
    if (typeof openIssue === 'function') {
        issue = button(
            {
                class: 'mktero-diagnostics-link',
                'data-diagnostic-action': 'open-issue',
            },
            LUCIDE_ICONS.externalLink,
            translate('diagnostics.openIssue')
        );
        destination.appendChild(issue);
    }
    const status = element('p', {
        class: 'mktero-diagnostics-status',
        role: 'status',
        'aria-live': 'polite',
    });
    status.hidden = true;

    const body = element('div', { class: 'mktero-diagnostics-body' });
    body.append(note, field, summaryTitle, summary, toggle, preview, destination, status);

    const save = button(
        { class: 'mktero-diagnostics-button', 'data-diagnostic-action': 'save' },
        LUCIDE_ICONS.download,
        translate('diagnostics.save')
    );
    const copy = button(
        {
            class: 'mktero-diagnostics-button mktero-diagnostics-button--primary',
            'data-diagnostic-action': 'copy',
        },
        LUCIDE_ICONS.copy,
        translate('diagnostics.copy')
    );
    const actions = element('footer', { class: 'mktero-diagnostics-actions' });
    actions.append(save, copy);
    modal.append(header, body, actions);
    backdrop.appendChild(modal);

    let closed = false;
    let busy = false;
    let generation = 0;
    let latestText = '';
    let latestFileName = '';

    const described = () => happened.value.trim().length > 0;
    const setStatus = (message = '') => {
        status.textContent = message;
        status.hidden = !message;
    };
    const syncActions = () => {
        const ready = !busy && latestText.length > 0 && described();
        copy.disabled = !ready;
        save.disabled = !ready;
        hint.hidden = described();
    };
    const renderSummary = lines => {
        summary.replaceChildren();
        for (const line of Array.isArray(lines) ? lines : []) {
            const row = element('div', { class: 'mktero-diagnostics-summary-row' });
            row.append(
                element('dt', {}, String(line?.label || '')),
                element('dd', {}, String(line?.value || '—'))
            );
            summary.appendChild(row);
        }
    };
    const refresh = () => {
        const current = ++generation;
        latestText = '';
        syncActions();
        Promise.resolve()
            .then(() => buildReport({ note: happened.value }))
            .then(report => {
                if (closed || current !== generation) return;
                latestText = String(report?.text || '');
                latestFileName = String(report?.fileName || 'mktero-diagnostics.json');
                preview.textContent = latestText;
                renderSummary(report?.summary);
                syncActions();
            })
            .catch(() => {
                if (closed || current !== generation) return;
                latestText = '';
                preview.textContent = '';
                summary.replaceChildren(element(
                    'dd',
                    {},
                    translate('diagnostics.previewFailed')
                ));
                syncActions();
            });
    };
    const finish = ({ restoreFocus = true } = {}) => {
        if (closed) return;
        closed = true;
        generation += 1;
        openDialogs.delete(api);
        if (openByParent.get(parent) === api) openByParent.delete(parent);
        backdrop.remove();
        if (restoreFocus && returnFocus?.isConnected !== false) {
            returnFocus?.focus?.();
        }
    };
    const runAction = (action, onSuccess, failureKey) => {
        busy = true;
        syncActions();
        setStatus('');
        Promise.resolve()
            .then(action)
            .then(result => {
                if (closed) return;
                setStatus(onSuccess(result));
            })
            .catch(() => {
                if (closed) return;
                setStatus(translate(failureKey));
            })
            .finally(() => {
                if (closed) return;
                busy = false;
                syncActions();
            });
    };

    close.addEventListener('click', () => finish());
    happened.addEventListener('input', () => {
        setStatus('');
        refresh();
    });
    toggle.addEventListener('click', () => {
        const expanded = preview.hidden;
        preview.hidden = !expanded;
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.textContent = translate(expanded
            ? 'diagnostics.hideFull'
            : 'diagnostics.showFull');
    });
    copy.addEventListener('click', () => {
        if (copy.disabled || typeof copyText !== 'function') return;
        const text = latestText;
        runAction(
            () => copyText(text),
            () => translate('diagnostics.copied'),
            'diagnostics.copyFailed'
        );
    });
    save.addEventListener('click', () => {
        if (save.disabled || typeof saveText !== 'function') return;
        const text = latestText;
        const fileName = latestFileName;
        runAction(
            () => saveText(fileName, text),
            result => (result?.status === 'saved'
                ? translate('diagnostics.saved')
                : ''),
            'diagnostics.saveFailed'
        );
    });
    issue?.addEventListener('click', () => {
        try {
            openIssue();
        }
        catch {
            setStatus(translate('diagnostics.openIssueFailed'));
        }
    });
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
            happened.focus?.();
        },
        close: finish,
    };
    openDialogs.add(api);
    refresh();
    scheduleDocumentMicrotask(document, () => {
        if (!closed) happened.focus?.();
    });
    return api;
}

function focusable(modal) {
    return [...modal.querySelectorAll('textarea, button, pre[tabindex]')]
        .filter(node => !node.disabled && !isHidden(node, modal));
}

function isHidden(node, root) {
    for (let current = node; current && current !== root; current = current.parentNode) {
        if (current.hidden) return true;
    }
    return false;
}

function activeElementWithin(parent, document) {
    const active = parent.getRootNode?.()?.activeElement || document.activeElement;
    return active?.shadowRoot?.activeElement || active || null;
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

// The id is fixed, so a stylesheet left by an earlier build of this plugin is
// reused and rewritten instead of trusted. Skipping an existing node kept the
// old rules after an update and broke the dialog layout until a restart.
function ensureStyle(document) {
    let style = document.getElementById?.(STYLE_ID);
    if (!style) {
        style = document.createElementNS(XHTML_NAMESPACE, 'style');
        style.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== DIAGNOSTIC_DIALOG_STYLE) {
        style.textContent = DIAGNOSTIC_DIALOG_STYLE;
    }
    styledDocuments.add(document);
}

function removeStyle(document) {
    styledDocuments.delete(document);
    try {
        document.getElementById?.(STYLE_ID)?.remove();
    }
    catch {
        // The window is already closing; its document goes with it.
    }
}

// The dialog lives in the Zotero main window, outside the Markdown shadow
// root, so it defines its own palette instead of reading the reader's
// variables, and every box sets its own sizing.
const DIAGNOSTIC_DIALOG_STYLE = `
.mktero-diagnostics-backdrop {
    --mktero-diag-surface: #e9edf1;
    --mktero-diag-raised: #ffffff;
    --mktero-diag-border: #d3d8de;
    --mktero-diag-text: #20252b;
    --mktero-diag-muted: #5f6873;
    --mktero-diag-accent: #4072e5;
    --mktero-diag-accent-text: #ffffff;
    --mktero-diag-link: #2f5fcf;
    --mktero-diag-shadow: 0 8px 24px rgb(28 36 46 / 14%);
}
@media (prefers-color-scheme: dark) {
    .mktero-diagnostics-backdrop {
        --mktero-diag-surface: #22262c;
        --mktero-diag-raised: #2b3038;
        --mktero-diag-border: #424a55;
        --mktero-diag-text: #edf1f5;
        --mktero-diag-muted: #aab2bc;
        --mktero-diag-accent: #4f7ff0;
        --mktero-diag-accent-text: #ffffff;
        --mktero-diag-link: #8fb0ff;
        --mktero-diag-shadow: 0 8px 24px rgb(0 0 0 / 34%);
    }
}
.mktero-diagnostics-backdrop,
.mktero-diagnostics-backdrop * {
    box-sizing: border-box;
}
.mktero-diagnostics-backdrop [hidden] {
    display: none !important;
}
.mktero-diagnostics-backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483000;
    display: grid;
    padding: clamp(16px, 4vh, 48px) clamp(16px, 4vw, 64px);
    background: rgb(20 27 36 / 46%);
    place-items: center;
}
.mktero-diagnostics-dialog {
    display: flex;
    width: min(480px, 100%);
    max-height: min(600px, calc(100vh - 32px));
    min-height: 0;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--mktero-diag-border);
    border-radius: 10px;
    background: var(--mktero-diag-surface);
    color: var(--mktero-diag-text);
    box-shadow: var(--mktero-diag-shadow);
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.mktero-diagnostics-header {
    display: flex;
    min-height: 44px;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid var(--mktero-diag-border);
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
    margin: 0;
    background: transparent;
    color: var(--mktero-diag-muted);
    cursor: pointer;
    padding: 6px;
}
.mktero-diagnostics-close:hover {
    background: var(--mktero-diag-raised);
    color: var(--mktero-diag-text);
}
.mktero-diagnostics-body {
    display: flex;
    min-height: 0;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    padding: 14px 16px 16px;
}
.mktero-diagnostics-note,
.mktero-diagnostics-hint,
.mktero-diagnostics-status {
    margin: 0;
    color: var(--mktero-diag-muted);
    font-size: 12px;
}
.mktero-diagnostics-status {
    color: var(--mktero-diag-text);
    font-weight: 600;
}
.mktero-diagnostics-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.mktero-diagnostics-label {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 0;
    color: var(--mktero-diag-text);
    font-size: 12px;
    font-weight: 600;
}
.mktero-diagnostics-required {
    color: var(--mktero-diag-muted);
    font-weight: 400;
}
.mktero-diagnostics-input {
    min-height: 64px;
    margin: 0;
    resize: vertical;
    border: 1px solid var(--mktero-diag-border);
    border-radius: 6px;
    background: var(--mktero-diag-raised);
    color: inherit;
    font: inherit;
    padding: 8px;
}
.mktero-diagnostics-input::placeholder {
    color: var(--mktero-diag-muted);
}
.mktero-diagnostics-input:focus-visible,
.mktero-diagnostics-button:focus-visible,
.mktero-diagnostics-link:focus-visible,
.mktero-diagnostics-close:focus-visible,
.mktero-diagnostics-preview:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--mktero-diag-accent) 65%, transparent);
    outline-offset: 1px;
}
/* One grid for all rows, so every value starts at the same column. */
.mktero-diagnostics-summary {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 16px;
    margin: 0;
    border: 1px solid var(--mktero-diag-border);
    border-radius: 6px;
    background: var(--mktero-diag-raised);
    padding: 8px 10px;
}
.mktero-diagnostics-summary-row {
    display: contents;
}
.mktero-diagnostics-summary dt {
    color: var(--mktero-diag-muted);
}
.mktero-diagnostics-summary dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
}
.mktero-diagnostics-summary > dd {
    grid-column: 1 / -1;
    color: var(--mktero-diag-muted);
}
.mktero-diagnostics-link {
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    gap: 5px;
    border: none;
    margin: 0;
    background: transparent;
    color: var(--mktero-diag-link);
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 2px 0;
}
.mktero-diagnostics-link:hover {
    text-decoration: underline;
}
.mktero-diagnostics-preview {
    max-height: 180px;
    flex: none;
    overflow: auto;
    margin: 0;
    border: 1px solid var(--mktero-diag-border);
    border-radius: 6px;
    background: var(--mktero-diag-raised);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    line-height: 1.45;
    padding: 8px;
}
.mktero-diagnostics-destination {
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-top: 1px solid var(--mktero-diag-border);
    padding-top: 10px;
}
.mktero-diagnostics-actions {
    display: flex;
    flex: none;
    justify-content: flex-end;
    gap: 8px;
    border-top: 1px solid var(--mktero-diag-border);
    padding: 12px 16px;
}
.mktero-diagnostics-button {
    display: inline-flex;
    min-height: 30px;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--mktero-diag-border);
    border-radius: 6px;
    margin: 0;
    appearance: none;
    background: var(--mktero-diag-raised);
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-weight: 600;
    line-height: 1;
    padding: 6px 12px;
}
.mktero-diagnostics-button--primary {
    border-color: transparent;
    background: var(--mktero-diag-accent);
    color: var(--mktero-diag-accent-text);
}
.mktero-diagnostics-button:disabled {
    cursor: default;
    opacity: 0.5;
}
.mktero-diagnostics-button-icon {
    flex: none;
}
@media (prefers-reduced-motion: reduce) {
    .mktero-diagnostics-backdrop,
    .mktero-diagnostics-dialog {
        transition: none;
    }
}
`;
