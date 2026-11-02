import { translateEnglish } from '../i18n/localization.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';
import { resolvePDFCandidates } from './pdf-item-targets.js';

const ITEM_MENU_ID = 'zotero-itemmenu';
const IMPORT_ITEM_ID = 'mktero-import-llm-cache';
const IMPORT_OPTIONS_ID = 'mktero-import-llm-cache-options';
const PROBE_CONCURRENCY = 3;
const registrations = new WeakMap();

export function registerLLMCacheImportMenu({
    zotero,
    window,
    probeCandidate,
    onImport,
    isPreparing = () => false,
    onError = error => zotero?.logError?.(error),
    translate = translateEnglish,
} = {}) {
    const document = window?.document;
    const menu = document?.getElementById?.(ITEM_MENU_ID);
    if (!menu) return null;
    registrations.get(menu)?.();
    if (typeof probeCandidate !== 'function' || typeof onImport !== 'function') return null;

    document.getElementById(IMPORT_ITEM_ID)?.remove();
    document.getElementById(IMPORT_OPTIONS_ID)?.remove();
    const directItem = createElement('menuitem', IMPORT_ITEM_ID);
    const optionsItem = createElement('menu', IMPORT_OPTIONS_ID);
    const optionsPopup = createElement('menupopup');
    optionsItem.append(optionsPopup);
    menu.append(directItem, optionsItem);

    let active = true;
    let showing = false;
    let generation = 0;
    let probeController = null;
    const commands = new Map();
    const choiceElements = new Map();
    let commandListeners = [];

    function createElement(tagName, id) {
        const element = document.createXULElement?.(tagName) || document.createElement(tagName);
        if (id) element.id = id;
        if (tagName !== 'menupopup') {
            element.hidden = true;
            element.setAttribute('label', translate('menu.importLLMCache'));
        }
        return element;
    }

    function abortProbes() {
        generation++;
        probeController?.abort();
        probeController = null;
    }

    function clearChoices() {
        for (const removeListener of commandListeners) removeListener();
        commandListeners = [];
        choiceElements.clear();
        directItem.hidden = true;
        optionsItem.hidden = true;
        optionsPopup.replaceChildren();
    }

    function selectionIdentity() {
        const selected = window.ZoteroPane?.getSelectedItems?.();
        if (!Array.isArray(selected) || selected.length !== 1 || selected[0]?.deleted) return null;
        const item = selected[0];
        if (!Number.isSafeInteger(item?.id) || item.id <= 0) return null;
        return JSON.stringify([item.id, item.libraryID ?? null, item.key ?? null]);
    }

    function currentTarget(target, selection) {
        if (!active || selectionIdentity() !== selection) return null;
        const candidate = resolvePDFCandidates(zotero, window.ZoteroPane?.getSelectedItems?.())
            .find(value => sameIdentity(value, target));
        if (!candidate) return null;
        const item = typeof zotero?.Items?.get === 'function'
            ? zotero.Items.get(target.itemID)
            : candidate.item;
        return item && !item.deleted && item.isPDFAttachment?.()
            && item.id === target.itemID && item.key === target.attachmentKey
            && item.libraryID === target.libraryID ? item : null;
    }

    function busy(itemID) {
        try {
            return Boolean(isPreparing(itemID));
        }
        catch {
            return true;
        }
    }

    function setDisabled(element, disabled) {
        element.disabled = disabled;
        if (disabled) element.setAttribute('disabled', 'true');
        else element.removeAttribute('disabled');
    }

    function attachCommand(element, target, selection) {
        choiceElements.set(target.itemID, element);
        const handler = () => {
            if (commands.has(target.itemID) || !currentTarget(target, selection)) return;
            const controller = createRuntimeAbortController({ globalObject: window, zotero });
            commands.set(target.itemID, controller);
            setDisabled(element, true);
            void (async () => {
                if (busy(target.itemID)) throw importError('BUSY', 'busy');
                const item = currentTarget(target, selection);
                if (!item) return;
                const available = await probeCandidate(item, { signal: controller.signal });
                if (!active || controller.signal.aborted || !currentTarget(target, selection)) return;
                if (!available) throw importError('UNAVAILABLE', 'unavailable');
                if (busy(target.itemID)) throw importError('BUSY', 'busy');
                await onImport(target.itemID, {
                    libraryID: target.libraryID,
                    attachmentKey: target.attachmentKey,
                });
            })().catch(error => {
                if (active && !controller.signal.aborted && error?.name !== 'AbortError') onError?.(error);
            }).finally(() => {
                if (commands.get(target.itemID) === controller) commands.delete(target.itemID);
                const choice = choiceElements.get(target.itemID);
                if (active && choice) setDisabled(choice, busy(target.itemID) || commands.has(target.itemID));
            });
        };
        element.addEventListener('command', handler);
        commandListeners.push(() => element.removeEventListener('command', handler));
    }

    function importError(code, key) {
        const error = new Error(translate(`importLLM.${key}`));
        error.code = `LLM_CACHE_IMPORT_${code}`;
        return error;
    }

    function render(targets, selection) {
        clearChoices();
        if (targets.length === 1) {
            const target = targets[0];
            setDisabled(directItem, busy(target.itemID) || commands.has(target.itemID));
            attachCommand(directItem, target, selection);
            directItem.hidden = false;
        }
        else if (targets.length > 1) {
            const labels = targets.map(attachmentLabel);
            for (let index = 0; index < targets.length; index++) {
                const target = targets[index];
                const item = createElement('menuitem');
                const label = labels[index];
                item.setAttribute('label', labels.filter(value => value === label).length > 1
                    ? `${label} [${target.itemID}]` : label);
                setDisabled(item, busy(target.itemID) || commands.has(target.itemID));
                attachCommand(item, target, selection);
                item.hidden = false;
                optionsPopup.append(item);
            }
            optionsItem.hidden = false;
        }
    }

    function canRender(currentGeneration, selection) {
        return active && showing && generation === currentGeneration
            && selectionIdentity() === selection
            && (typeof menu.state !== 'string' || ['showing', 'open'].includes(menu.state));
    }

    const handlePopupShowing = event => {
        if (event.target !== menu || !active) return;
        abortProbes();
        clearChoices();
        showing = true;
        const selection = selectionIdentity();
        if (!selection) return;
        const targets = resolvePDFCandidates(zotero, window.ZoteroPane?.getSelectedItems?.());
        if (!targets.length) return;
        const controller = createRuntimeAbortController({ globalObject: window, zotero });
        probeController = controller;
        const currentGeneration = generation;
        const available = new Set();
        let cursor = 0;
        const probeNext = async () => {
            while (!controller.signal.aborted && cursor < targets.length) {
                const target = targets[cursor++];
                try {
                    if (await probeCandidate(target.item, { signal: controller.signal })) available.add(target.itemID);
                }
                catch {
                    // Discovery is advisory. A failed candidate stays hidden.
                }
            }
        };
        void Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, probeNext))
            .then(() => {
                if (!canRender(currentGeneration, selection) || controller.signal.aborted) return;
                render(targets.filter(target => available.has(target.itemID)
                    && currentTarget(target, selection)), selection);
            });
    };
    const handlePopupHidden = event => {
        if (event.target !== menu) return;
        showing = false;
        abortProbes();
        // Keep command listeners until the next opening: native menus may hide
        // before dispatching the command for the chosen item.
    };
    const dispose = () => {
        if (!active) return;
        active = false;
        showing = false;
        abortProbes();
        for (const controller of commands.values()) controller.abort();
        commands.clear();
        clearChoices();
        menu.removeEventListener('popupshowing', handlePopupShowing);
        menu.removeEventListener('popuphidden', handlePopupHidden);
        window.removeEventListener?.('unload', dispose);
        directItem.remove();
        optionsItem.remove();
        if (registrations.get(menu) === dispose) registrations.delete(menu);
    };
    menu.addEventListener('popupshowing', handlePopupShowing);
    menu.addEventListener('popuphidden', handlePopupHidden);
    window.addEventListener?.('unload', dispose);
    registrations.set(menu, dispose);
    return dispose;
}

function sameIdentity(first, second) {
    return first.itemID === second.itemID && first.libraryID === second.libraryID
        && first.attachmentKey === second.attachmentKey;
}

function attachmentLabel(target) {
    const title = target.attachmentTitle;
    const fileName = target.fileName;
    if (title === 'PDF') return fileName;
    if (fileName === 'PDF' || title === fileName) return title;
    return `${title} (${fileName})`;
}
