import { createAnchoredPopup } from './anchored-popup.js';
import { createLocalization } from '../i18n/localization.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BACKGROUND_REFRESH_DELAY_MS = 50;
let nextLibraryPickerID = 1;

export function createCitationPopup(parent, {
    localization = createLocalization(),
    setTimer = null,
    clearTimer = null,
} = {}) {
    const t = localization.t.bind(localization);
    const ownerWindow = parent.ownerDocument.defaultView;
    const scheduleTimer = typeof setTimer === 'function'
        ? setTimer
        : ownerWindow.setTimeout.bind(ownerWindow);
    const cancelTimer = typeof clearTimer === 'function'
        ? clearTimer
        : ownerWindow.clearTimeout.bind(ownerWindow);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-citation-popup',
        idPrefix: 'mktero-citation-popup',
    });
    let activeAnchor = null;
    let activeController = null;

    const open = ({
        anchor,
        targets,
        label = t('citation.details'),
        onActivate,
        focusFirst = false,
        sourceItemID = null,
        onListReferenceLibraries,
        onGetReferenceStatus,
        onSearchReferenceMetadata,
        onImportReference,
        onOpenReferenceMatch,
        onSubscribeReferenceUpdates,
        targetLibraryID = null,
    }) => {
        if (!targets?.length) return;
        if (activeAnchor === anchor && anchoredPopup.isOpen()) {
            anchoredPopup.open({
                anchor,
                label,
                renderContent: () => null,
                forceOpen: focusFirst,
                focusContent: focusFirst ? focusFirstItem : null,
            });
            return;
        }
        activeController?.abort?.();
        const controller = createAbortController(parent);
        activeController = controller;
        activeAnchor = anchor;
        let generation = 0;
        let selectedLibraryID = targetLibraryID;
        let libraries = [];
        let rows = [];
        let contentRoot = null;
        let unsubscribeUpdates = null;
        let destroyLibraryPicker = null;
        let libraryPicker = null;
        let backgroundRefreshTimer = null;

        const isCurrent = expectedGeneration => (
            activeController === controller
            && activeAnchor === anchor
            && !controller.signal?.aborted
            && generation === expectedGeneration
        );
        const close = () => anchoredPopup.close();
        const cancelBackgroundRefresh = () => {
            if (backgroundRefreshTimer === null) return;
            cancelTimer(backgroundRefreshTimer);
            backgroundRefreshTimer = null;
        };
        const refreshRows = ({
            showChecking = true,
            targetRows = rows,
        } = {}) => {
            if (showChecking) cancelBackgroundRefresh();
            const currentGeneration = showChecking ? ++generation : generation;
            for (const row of targetRows) {
                void updateReferenceRow({
                    row,
                    target: row.target,
                    selectedLibraryID,
                    generation: currentGeneration,
                    isCurrent,
                    controller,
                    onGetReferenceStatus,
                    onSearchReferenceMetadata,
                    onImportReference,
                    onOpenReferenceMatch,
                    close,
                    showChecking,
                    t,
                });
            }
        };
        const scheduleBackgroundRefresh = () => {
            cancelBackgroundRefresh();
            backgroundRefreshTimer = scheduleTimer(() => {
                backgroundRefreshTimer = null;
                if (controller.signal?.aborted) return;
                const availableRows = rows.filter(row => !isRowActionBusy(row));
                if (availableRows.length) {
                    refreshRows({
                        showChecking: false,
                        targetRows: availableRows,
                    });
                }
            }, BACKGROUND_REFRESH_DELAY_MS);
        };
        const applyReferenceUpdate = event => {
            const updatedRows = rows.filter(row => referencesMatch(
                row.target,
                event?.reference
            ));
            if (!updatedRows.length) return;
            const resultLibraryID = event?.result?.targetLibraryID;
            if (!event?.result || (resultLibraryID !== null
                && resultLibraryID !== undefined
                && String(resultLibraryID) !== String(selectedLibraryID))) {
                refreshRows({
                    showChecking: false,
                    targetRows: updatedRows,
                });
                return;
            }
            for (const row of updatedRows) {
                row.statusRequestVersion++;
                applyStatus(row, event.result, {
                    target: row.target,
                    selectedLibraryID,
                    onSearchReferenceMetadata,
                    onImportReference,
                    onOpenReferenceMatch,
                    close,
                    controller,
                    generation,
                    isCurrent,
                    t,
                });
            }
        };
        const loadLibraries = async () => {
            if (typeof onListReferenceLibraries !== 'function') return;
            try {
                const result = await onListReferenceLibraries({
                    sourceItemID,
                    signal: controller.signal,
                });
                if (controller.signal?.aborted || activeAnchor !== anchor) return;
                libraries = Array.isArray(result) ? result : result?.libraries || [];
                const preferredLibraryID = selectedLibraryID
                    ?? result?.defaultLibraryID;
                selectedLibraryID = libraries.find(library => (
                    String(library.libraryID) === String(preferredLibraryID)
                ))?.libraryID
                    ?? libraries.find(library => library.type === 'user')?.libraryID
                    ?? libraries[0]?.libraryID
                    ?? null;
                libraryPicker?.render?.({
                    libraries,
                    selectedLibraryID,
                    onChange(nextID) {
                        selectedLibraryID = nextID;
                        refreshRows();
                    },
                    t,
                });
                refreshRows();
            }
            catch {
                if (controller.signal?.aborted || activeAnchor !== anchor) return;
                libraryPicker?.renderError?.(t('reference.libraryLoadFailed'));
            }
        };

        anchoredPopup.open({
            anchor,
            label,
            forceOpen: focusFirst,
            onClose() {
                cancelBackgroundRefresh();
                controller.abort?.();
                unsubscribeUpdates?.();
                unsubscribeUpdates = null;
                destroyLibraryPicker?.();
                destroyLibraryPicker = null;
                if (activeController === controller) activeController = null;
                if (activeAnchor === anchor) activeAnchor = null;
            },
            renderContent({ document }) {
                contentRoot = createElement(document, 'div');
                contentRoot.className = 'mktero-citation-popup-content';
                const importable = targets.some(isReferenceTarget);
                if (importable && typeof onListReferenceLibraries === 'function') {
                    const header = createElement(document, 'div');
                    header.className = 'mktero-citation-popup-header';
                    libraryPicker = createLibraryPicker(document, {
                        label: t('reference.targetLibrary'),
                        loadingLabel: t('reference.loadingLibraries'),
                        readOnlyLabel: t('reference.readOnly'),
                    });
                    destroyLibraryPicker = libraryPicker.destroy;
                    header.appendChild(libraryPicker.element);
                    contentRoot.appendChild(header);
                }
                rows = targets.map(target => createCitationItem({
                    document,
                    target,
                    close,
                    onActivate,
                    t,
                    rowOptions: {
                        selectedLibraryID: () => selectedLibraryID,
                        isCurrent,
                        controller,
                        onGetReferenceStatus,
                        onSearchReferenceMetadata,
                        onImportReference,
                        onOpenReferenceMatch,
                        close,
                        t,
                    },
                }));
                for (const row of rows) contentRoot.appendChild(row.element);
                if (importable) void loadLibraries();
                if (importable
                    && typeof onListReferenceLibraries !== 'function'
                    && typeof onGetReferenceStatus === 'function') {
                    refreshRows();
                }
                if (importable
                    && typeof onSubscribeReferenceUpdates === 'function') {
                    unsubscribeUpdates = onSubscribeReferenceUpdates(event => {
                        if (controller.signal?.aborted) return;
                        if (event?.type === 'updated' && event.reference) {
                            applyReferenceUpdate(event);
                            return;
                        }
                        if (event?.type === 'invalidated') {
                            scheduleBackgroundRefresh();
                            return;
                        }
                        refreshRows({ showChecking: false });
                    });
                }
                return contentRoot;
            },
            focusContent: focusFirst ? focusFirstItem : null,
        });
    };

    return {
        open,
        close: anchoredPopup.close,
        scheduleClose: anchoredPopup.scheduleClose,
        cancelClose: anchoredPopup.cancelClose,
        contains: anchoredPopup.contains,
        destroy() {
            activeController?.abort?.();
            activeController = null;
            activeAnchor = null;
            anchoredPopup.destroy();
        },
    };
}

function createCitationItem({
    document,
    target,
    close,
    onActivate,
    t,
    rowOptions,
}) {
    const element = createElement(document, 'div');
    element.className = 'mktero-citation-popup-item';
    const primary = createElement(document, 'button');
    primary.type = 'button';
    primary.className = 'mktero-citation-popup-primary';
    primary.addEventListener('click', event => {
        event.stopPropagation();
        close();
        onActivate?.(target);
    });
    const marker = target.label
        ?? (Number.isInteger(target.number) ? String(target.number) : '');
    if (marker) {
        const number = createElement(document, 'span');
        number.className = 'mktero-citation-popup-number';
        number.textContent = `[${marker}]`;
        primary.appendChild(number);
    }
    const text = createElement(document, 'span');
    text.className = 'mktero-citation-popup-text';
    text.textContent = target.text;
    primary.appendChild(text);

    const controls = createElement(document, 'div');
    controls.className = 'mktero-citation-popup-actions';
    const status = createElement(document, 'span');
    status.className = 'mktero-citation-popup-status';
    status.setAttribute('role', 'status');
    const action = createElement(document, 'button');
    action.type = 'button';
    action.className = 'mktero-citation-popup-action';
    action.hidden = true;
    let row;
    action.addEventListener('click', event => {
        event.stopPropagation();
        void runReferenceAction({
            target,
            row: row || { status, action, target },
            options: rowOptions,
        });
    });
    const candidatePanel = createElement(document, 'div');
    candidatePanel.className = 'mktero-citation-popup-candidates';
    candidatePanel.hidden = true;
    candidatePanel.setAttribute('role', 'listbox');
    candidatePanel.setAttribute(
        'aria-label',
        t('reference.metadataCandidates')
    );
    controls.append(status, action);
    if (!isReferenceTarget(target)) {
        controls.hidden = true;
        candidatePanel.hidden = true;
    }
    row = {
        element,
        target,
        status,
        action,
        candidatePanel,
        revision: 0,
        statusRequestVersion: 0,
    };
    element.append(primary, controls, candidatePanel);
    return row;
}

async function updateReferenceRow({
    row,
    target,
    selectedLibraryID,
    generation,
    isCurrent,
    controller,
    onGetReferenceStatus,
    onSearchReferenceMetadata,
    onImportReference,
    onOpenReferenceMatch,
    close,
    showChecking = true,
    t,
}) {
    if (!row?.status || !isReferenceTarget(target)) return;
    const requestVersion = ++row.statusRequestVersion;
    if (showChecking) {
        setStatus(row, 'checking', t);
    }
    const expectedRevision = row.revision;
    if (typeof onGetReferenceStatus !== 'function') {
        if (!isRowRefreshCurrent(row, requestVersion, expectedRevision)) return;
        setStatus(row, 'unknown', t);
        return;
    }
    try {
        const result = await onGetReferenceStatus(target, {
            targetLibraryID: selectedLibraryID,
            signal: controller.signal,
        });
        if (!isCurrent(generation)
            || !isRowRefreshCurrent(row, requestVersion, expectedRevision)) {
            return;
        }
        applyStatus(row, result, {
            target,
            selectedLibraryID,
            onSearchReferenceMetadata,
            onImportReference,
            onOpenReferenceMatch,
            close,
            controller,
            generation,
            isCurrent,
            t,
        });
    }
    catch (error) {
        if (!isCurrent(generation)
            || !isRowRefreshCurrent(row, requestVersion, expectedRevision)
            || error?.name === 'AbortError'
            || !showChecking) {
            return;
        }
        beginRowStateChange(row);
        row.status.textContent = errorLabel(error?.code, t);
        row.status.dataset.state = 'failed';
        row.action.hidden = true;
    }
}

function applyStatus(row, result, {
    target,
    selectedLibraryID,
    onSearchReferenceMetadata,
    onImportReference,
    onOpenReferenceMatch,
    close,
    controller,
    generation = null,
    isCurrent = () => true,
    t,
}) {
    beginRowStateChange(row);
    const state = result?.state || result?.status || 'unknown';
    const selectedMatch = result?.match || result?.selectedMatches?.[0] || null;
    const otherLibraries = [...new Set((result?.otherMatches || [])
        .map(match => match?.libraryName || match?.libraryID)
        .filter(Boolean))];
    row.status.textContent = state === 'present-other-library'
        && otherLibraries.length
        ? t('reference.presentOtherLibrary', {
            library: otherLibraries.join(', '),
        })
        : state === 'failed'
            ? errorLabel(result?.errorCode, t)
            : statusLabel(state, t);
    if (result?.targetLibraryEditable === false
        && state !== 'present'
        && state !== 'present-no-pdf') {
        row.status.textContent += ` · ${t('reference.readOnly')}`;
    }
    if (state === 'present-no-pdf'
        && result?.targetLibraryFilesEditable === false) {
        row.status.textContent += ` · ${t('reference.filesReadOnly')}`;
    }
    row.status.dataset.state = state;
    row.action.hidden = true;
    row.action.disabled = false;
    row.action.setAttribute('aria-busy', 'false');
    row.action.textContent = '';
    row.action._mkteroAction = null;
    row.action._mkteroActionKind = null;
    row.action._mkteroActionGeneration = null;
    row.action._mkteroActionIsCurrent = null;
    row.action._mkteroActionLabel = null;
    clearMetadataCandidates(row);
    if ((state === 'present' || state === 'imported')
        && selectedMatch
        && typeof onOpenReferenceMatch === 'function') {
        configureAction(
            row.action,
            t('reference.open'),
            () => onOpenReferenceMatch(selectedMatch),
            'open',
            generation,
            isCurrent
        );
    }
    else if (state === 'present-no-pdf'
        && result?.canImport !== false
        && result?.filesEditable !== false
        && typeof onImportReference === 'function') {
        configureAction(
            row.action,
            t('reference.retryPDF'),
            () => onImportReference(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
                retryPDF: true,
            }),
            'import',
            generation,
            isCurrent
        );
    }
    else if (state === 'present-other-library'
        && result?.canImport !== false
        && typeof onImportReference === 'function') {
        configureAction(
            row.action,
            t('reference.copyToLibrary'),
            () => onImportReference(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
            }),
            'import',
            generation,
            isCurrent
        );
    }
    else if (state === 'failed'
        && result?.canImport !== false
        && typeof onImportReference === 'function') {
        configureAction(
            row.action,
            t('reference.retry'),
            () => onImportReference(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
            }),
            'import',
            generation,
            isCurrent
        );
    }
    else if (state === 'absent'
        && result?.canImport !== false
        && typeof onImportReference === 'function') {
        configureAction(
            row.action,
            t('reference.import'),
            () => onImportReference(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
            }),
            'import',
            generation,
            isCurrent
        );
    }
    else if (state === 'unknown'
        && typeof onSearchReferenceMetadata === 'function') {
        const resolveAndImport = typeof onImportReference === 'function';
        configureAction(
            row.action,
            Array.isArray(result?.candidates) && result.candidates.length
                ? t('reference.reviewMatches')
                : t(resolveAndImport
                    ? 'reference.import'
                    : 'reference.searchMetadata'),
            () => onSearchReferenceMetadata(target, {
                targetLibraryID: selectedLibraryID,
                signal: controller.signal,
            }),
            resolveAndImport ? 'resolve-import' : 'resolve',
            generation,
            isCurrent
        );
    }
}

function clearMetadataCandidates(row) {
    if (!row?.candidatePanel) return;
    row.candidatePanel.replaceChildren();
    row.candidatePanel.hidden = true;
}

function renderMetadataCandidates(row, candidates, options) {
    clearMetadataCandidates(row);
    const values = Array.isArray(candidates) ? candidates.slice(0, 20) : [];
    if (!values.length || !row?.candidatePanel) return;
    for (const candidate of values) {
        const button = row.candidatePanel.ownerDocument.createElementNS(
            XHTML_NAMESPACE,
            'button'
        );
        button.type = 'button';
        button.className = 'mktero-citation-popup-candidate';
        button.setAttribute('role', 'option');
        const title = row.candidatePanel.ownerDocument.createElementNS(
            XHTML_NAMESPACE,
            'span'
        );
        title.className = 'mktero-citation-popup-candidate-title';
        title.textContent = candidate.title || tFallback(options.t);
        const details = row.candidatePanel.ownerDocument.createElementNS(
            XHTML_NAMESPACE,
            'span'
        );
        details.className = 'mktero-citation-popup-candidate-details';
        const source = candidate.source === 'zotero'
            ? options.t('reference.localCandidate')
            : options.t('reference.onlineCandidate');
        const year = candidate.year ? String(candidate.year) : '';
        const identifier = firstCandidateIdentifier(candidate.identifiers);
        details.textContent = [source, year, identifier]
            .filter(Boolean)
            .join(' · ');
        button.append(title, details);
        button.addEventListener('click', event => {
            event.stopPropagation();
            void confirmMetadataCandidate(candidate, options);
        });
        row.candidatePanel.appendChild(button);
    }
    row.candidatePanel.hidden = false;
}

async function confirmMetadataCandidate(candidate, {
    row,
    target,
    selectedLibraryID,
    controller,
    generation,
    rowRevision,
    isCurrent,
    onGetReferenceStatus,
    onSearchReferenceMetadata,
    onImportReference,
    onOpenReferenceMatch,
    importAfterConfirm = false,
    t,
}) {
    if (!isCurrent?.(generation)
        || !isRowRevisionCurrent(row, rowRevision)
        || controller.signal?.aborted) {
        return;
    }
    const confirmationRevision = beginRowStateChange(row);
    applyMetadataCandidate(target, candidate);
    clearMetadataCandidates(row);
    if (importAfterConfirm && typeof onImportReference === 'function') {
        await importResolvedReference({
            row,
            target,
            selectedLibraryID,
            controller,
            generation,
            rowRevision: confirmationRevision,
            isCurrent,
            onSearchReferenceMetadata,
            onImportReference,
            onOpenReferenceMatch,
            t,
        });
        return;
    }
    setActionBusy(row, true);
    row.status.textContent = t('reference.checking');
    row.status.dataset.state = 'checking';
    await updateReferenceRow({
        row,
        target,
        selectedLibraryID: selectedLibraryID(),
        generation,
        isCurrent,
        controller,
        onGetReferenceStatus,
        onSearchReferenceMetadata,
        onImportReference,
        onOpenReferenceMatch,
        close: () => {},
        t,
    });
}

function applyMetadataCandidate(target, candidate) {
    const identifiers = candidate?.identifiers || {};
    target.identifiers = {
        ...(target.identifiers || {}),
        ...Object.fromEntries([
            'doi',
            'arxivID',
            'pmid',
            'openAlexID',
            'pdfURL',
        ].map(type => [type, identifiers[type] || target.identifiers?.[type] || ''])),
    };
    if (candidate?.metadata) target.metadata = candidate.metadata;
}

async function importResolvedReference({
    row,
    target,
    selectedLibraryID,
    controller,
    generation,
    rowRevision,
    isCurrent,
    onSearchReferenceMetadata,
    onImportReference,
    onOpenReferenceMatch,
    t,
}) {
    const libraryID = selectedLibraryID();
    setActionBusy(row, true);
    row.action.textContent = t('reference.importing');
    row.status.textContent = t('reference.importing');
    row.status.dataset.state = 'importing';
    try {
        const result = await onImportReference(target, {
            targetLibraryID: libraryID,
            signal: controller.signal,
        });
        if (!isCurrent?.(generation)
            || !isRowRevisionCurrent(row, rowRevision)) {
            return;
        }
        applyStatus(row, result || { state: 'imported' }, {
            target,
            selectedLibraryID: libraryID,
            onSearchReferenceMetadata,
            onImportReference,
            onOpenReferenceMatch,
            close: () => {},
            controller,
            generation,
            isCurrent,
            t,
        });
    }
    catch (error) {
        if (error?.name === 'AbortError'
            || !isCurrent?.(generation)
            || !isRowRevisionCurrent(row, rowRevision)) {
            return;
        }
        applyStatus(row, {
            state: 'failed',
            canImport: true,
            errorCode: error?.code,
        }, {
            target,
            selectedLibraryID: libraryID,
            onSearchReferenceMetadata,
            onImportReference,
            onOpenReferenceMatch,
            close: () => {},
            controller,
            generation,
            isCurrent,
            t,
        });
    }
}

function setActionBusy(row, busy) {
    row.action.disabled = busy;
    row.action.setAttribute('aria-busy', String(busy));
}

function firstCandidateIdentifier(identifiers) {
    return identifiers?.doi
        || identifiers?.arxivID
        || identifiers?.pmid
        || identifiers?.openAlexID
        || '';
}

function tFallback(t) {
    return typeof t === 'function' ? t('document.untitled') : '';
}

async function runReferenceAction({ target, row, options }) {
    const {
        selectedLibraryID,
        onGetReferenceStatus,
        onSearchReferenceMetadata,
        onImportReference,
        onOpenReferenceMatch,
        close,
        controller,
        t,
    } = options;
    if (typeof row.action._mkteroAction !== 'function') return;
    const actionGeneration = row.action._mkteroActionGeneration;
    if (actionGeneration !== null
        && actionGeneration !== undefined
        && !options.isCurrent?.(actionGeneration)) return;
    let actionRevision = null;
    const isActionCurrent = () => (
        (actionGeneration === null
            || actionGeneration === undefined
            || options.isCurrent?.(actionGeneration))
        && isRowRevisionCurrent(row, actionRevision)
    );
    try {
        if (row.action._mkteroActionKind === 'open') {
            await row.action._mkteroAction();
            options.close?.();
            return;
        }
        actionRevision = beginRowStateChange(row);
        if (row.action._mkteroActionKind === 'resolve'
            || row.action._mkteroActionKind === 'resolve-import') {
            const resolveAndImport = row.action._mkteroActionKind
                === 'resolve-import';
            setActionBusy(row, true);
            row.action.textContent = t('reference.searchingMetadata');
            row.status.textContent = t('reference.searchingMetadata');
            row.status.dataset.state = 'checking';
            const result = await row.action._mkteroAction({
                target,
                targetLibraryID: selectedLibraryID(),
                signal: controller.signal,
            });
            if (!isActionCurrent()) return;
            const candidateOptions = {
                row,
                target,
                selectedLibraryID,
                controller,
                generation: actionGeneration,
                rowRevision: actionRevision,
                isCurrent: options.isCurrent,
                onGetReferenceStatus,
                onSearchReferenceMetadata,
                onImportReference,
                onOpenReferenceMatch,
                importAfterConfirm: resolveAndImport,
                t,
            };
            if (resolveAndImport && result?.automaticCandidate) {
                await confirmMetadataCandidate(
                    result.automaticCandidate,
                    candidateOptions
                );
                return;
            }
            setActionBusy(row, false);
            renderMetadataCandidates(row, result?.candidates, candidateOptions);
            if (result?.candidates?.length) {
                row.status.textContent = t('reference.chooseMetadata');
                row.status.dataset.state = 'unknown';
                row.action.textContent = t('reference.reviewMatches');
                row.action._mkteroActionLabel = row.action.textContent;
            }
            else {
                row.status.textContent = t('reference.noMetadataMatches');
                row.status.dataset.state = 'unknown';
                row.action.textContent = t(resolveAndImport
                    ? 'reference.import'
                    : 'reference.searchMetadata');
            }
            return;
        }
        setActionBusy(row, true);
        row.action.textContent = t('reference.importing');
        row.status.textContent = t('reference.importing');
        row.status.dataset.state = 'importing';
        const result = await row.action._mkteroAction({
            target,
            targetLibraryID: selectedLibraryID(),
            signal: controller.signal,
        });
        if (result) {
            if (!isActionCurrent()) return;
            applyStatus(row, result, {
                target,
                selectedLibraryID: selectedLibraryID(),
                onSearchReferenceMetadata,
                onImportReference,
                onOpenReferenceMatch,
                close: () => {},
                controller,
                generation: actionGeneration,
                isCurrent: options.isCurrent,
                t,
            });
        }
    }
    catch (error) {
        if (error?.name === 'AbortError') return;
        if (!isActionCurrent()) return;
        beginRowStateChange(row);
        setActionBusy(row, false);
        row.action.hidden = false;
        row.action.textContent = row.action._mkteroActionLabel
            || t('reference.retry');
        row.status.textContent = errorLabel(error?.code, t);
        row.status.dataset.state = 'failed';
    }
}

function beginRowStateChange(row) {
    row.revision = (row.revision || 0) + 1;
    return row.revision;
}

function isRowRevisionCurrent(row, revision) {
    return revision === null
        || revision === undefined
        || row.revision === revision;
}

function isRowRefreshCurrent(row, requestVersion, revision) {
    return row.statusRequestVersion === requestVersion
        && isRowRevisionCurrent(row, revision);
}

function isRowActionBusy(row) {
    return row.action?.getAttribute('aria-busy') === 'true';
}

function referencesMatch(left, right) {
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.id && right.id && String(left.id) === String(right.id)) return true;
    return ['doi', 'arxivID', 'pmid', 'openAlexID'].some(type => {
        const leftValue = String(left.identifiers?.[type] || '')
            .trim()
            .toLowerCase();
        const rightValue = String(right.identifiers?.[type] || '')
            .trim()
            .toLowerCase();
        return Boolean(leftValue && leftValue === rightValue);
    });
}

function configureAction(
    button,
    label,
    action,
    kind = 'import',
    generation = null,
    isCurrent = () => true
) {
    button.hidden = false;
    button.textContent = label;
    button.setAttribute('aria-busy', 'false');
    button._mkteroAction = action;
    button._mkteroActionKind = kind;
    button._mkteroActionGeneration = generation;
    button._mkteroActionIsCurrent = isCurrent;
    button._mkteroActionLabel = label;
}

function setStatus(row, state, t) {
    beginRowStateChange(row);
    row.status.textContent = statusLabel(state, t);
    row.status.dataset.state = state;
    row.action.hidden = true;
    row.action.setAttribute('aria-busy', 'false');
    row.action._mkteroAction = null;
    row.action._mkteroActionKind = null;
    row.action._mkteroActionGeneration = null;
    row.action._mkteroActionIsCurrent = null;
    row.action._mkteroActionLabel = null;
}

function statusLabel(state, t) {
    const keys = {
        checking: 'reference.checking',
        present: 'reference.present',
        'present-no-pdf': 'reference.presentNoPDF',
        'present-other-library': 'reference.presentOtherLibrary',
        absent: 'reference.absent',
        ambiguous: 'reference.ambiguous',
        unknown: 'reference.unknown',
        importing: 'reference.importing',
        imported: 'reference.imported',
        failed: 'reference.failed',
    };
    return t(keys[state] || keys.unknown);
}

function errorLabel(errorCode, t) {
    const keys = {
        REFERENCE_IDENTIFIER_UNSUPPORTED: 'reference.errorUnsupported',
        REFERENCE_LIBRARY_READ_ONLY: 'reference.errorLibraryReadOnly',
        REFERENCE_FILES_READ_ONLY: 'reference.errorFilesReadOnly',
        REFERENCE_TRANSLATOR_UNAVAILABLE: 'reference.errorTranslator',
        REFERENCE_TRANSLATOR_NOT_FOUND: 'reference.errorTranslator',
        REFERENCE_TRANSLATOR_EMPTY: 'reference.errorTranslator',
        REFERENCE_METADATA_INVALID: 'reference.errorTranslator',
        REFERENCE_METADATA_IMPORT_UNAVAILABLE: 'reference.errorTranslator',
        REFERENCE_DUPLICATE_RACE: 'reference.errorDuplicate',
        REFERENCE_NETWORK_FAILED: 'reference.errorNetwork',
        REFERENCE_PDF_FAILED: 'reference.errorPDF',
        OPENALEX_NETWORK_ERROR: 'reference.errorNetwork',
        OPENALEX_REQUEST_TIMEOUT: 'reference.errorNetwork',
        OPENALEX_HTTP_ERROR: 'reference.errorNetwork',
        OPENALEX_RESPONSE_TOO_LARGE: 'reference.errorNetwork',
        OPENALEX_INVALID_RESPONSE: 'reference.errorNetwork',
    };
    return t(keys[errorCode] || 'reference.errorImport');
}

function createLibraryPicker(document, {
    label,
    loadingLabel,
    readOnlyLabel,
}) {
    const pickerID = `mktero-citation-library-picker-${nextLibraryPickerID++}`;
    const picker = createElement(document, 'div');
    picker.className = 'mktero-citation-popup-library-picker';
    const trigger = createElement(document, 'button');
    trigger.id = `${pickerID}-trigger`;
    trigger.type = 'button';
    trigger.className = 'mktero-citation-popup-library-select';
    trigger.disabled = true;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', `${pickerID}-options`);
    trigger.setAttribute('aria-busy', 'true');
    trigger.setAttribute('aria-label', label);
    const current = createElement(document, 'span');
    current.className = 'mktero-citation-popup-library-current';
    current.textContent = loadingLabel;
    const chevron = createLucideIcon(
        document,
        LUCIDE_ICONS.chevronDown,
        {
            className: 'mktero-citation-popup-library-chevron',
            size: 14,
        }
    );
    trigger.append(current, chevron);
    const options = createElement(document, 'div');
    options.id = `${pickerID}-options`;
    options.className = 'mktero-citation-popup-library-options';
    options.setAttribute('role', 'listbox');
    options.setAttribute('aria-label', label);
    options.hidden = true;
    appendLibraryPlaceholder(options, loadingLabel, document);
    picker.append(trigger, options);

    let availableLibraries = [];
    let selectedLibraryID = null;
    let onChange = null;
    let open = false;

    const optionButtons = () => [...options.querySelectorAll(
        '.mktero-citation-popup-library-option'
    )];
    const selectedLibrary = () => availableLibraries.find(library => (
        String(library.libraryID) === String(selectedLibraryID)
    )) || availableLibraries[0] || null;
    const updateTrigger = () => {
        const library = selectedLibrary();
        const text = library
            ? libraryLabel(library, readOnlyLabel)
            : current.textContent;
        current.textContent = text;
        trigger.setAttribute('aria-label', `${label}: ${text}`);
        trigger.title = text;
        for (const option of optionButtons()) {
            const selected = String(option.dataset.libraryId)
                === String(library?.libraryID);
            option.setAttribute('aria-selected', String(selected));
            option.classList.toggle('is-selected', selected);
            option.setAttribute('tabindex', open && selected ? '0' : '-1');
        }
    };
    const focusOption = libraryID => {
        const option = optionButtons().find(button => (
            String(button.dataset.libraryId) === String(libraryID)
        )) || optionButtons()[0];
        if (!option) return;
        for (const button of optionButtons()) {
            button.setAttribute('tabindex', button === option ? '0' : '-1');
        }
        option.focus?.();
    };
    const setOpen = (nextOpen, { focusLibraryID = null } = {}) => {
        const visible = Boolean(nextOpen) && !trigger.disabled;
        open = visible;
        trigger.setAttribute('aria-expanded', String(visible));
        options.hidden = !visible;
        picker.classList.toggle('is-open', visible);
        updateTrigger();
        if (visible) positionOptions();
        if (visible && focusLibraryID !== null) focusOption(focusLibraryID);
    };
    const syncDisabled = () => {
        trigger.disabled = !availableLibraries.length;
        if (trigger.disabled) setOpen(false);
    };

    function positionOptions() {
        if (!open) return;
        const rect = trigger.getBoundingClientRect?.();
        const ownerWindow = document.defaultView;
        if (!rect || !ownerWindow) return;
        const viewportWidth = ownerWindow.innerWidth || 1024;
        const viewportHeight = ownerWindow.innerHeight || 768;
        const width = Math.min(
            Math.max(rect.width, 220),
            Math.max(220, viewportWidth - 24)
        );
        const menuHeight = options.getBoundingClientRect?.().height
            || options.offsetHeight
            || 0;
        const left = Math.min(
            Math.max(12, rect.left),
            Math.max(12, viewportWidth - width - 12)
        );
        const below = rect.bottom + 6;
        const top = below + menuHeight <= viewportHeight - 12
            || rect.top < menuHeight + 18
            ? below
            : Math.max(12, rect.top - menuHeight - 6);
        options.style.width = `${Math.round(width)}px`;
        options.style.left = `${Math.round(left)}px`;
        options.style.top = `${Math.round(top)}px`;
    }

    trigger.addEventListener('click', () => {
        setOpen(!open);
    });
    trigger.addEventListener('keydown', event => {
        if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.focus?.();
            return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        setOpen(true, { focusLibraryID: selectedLibrary()?.libraryID });
    });
    options.addEventListener('click', event => {
        const option = event.target?.closest?.(
            '.mktero-citation-popup-library-option'
        );
        if (!option || !options.contains(option)) return;
        event.stopPropagation();
        const nextID = option.dataset.libraryId;
        const changed = String(nextID) !== String(selectedLibraryID);
        selectedLibraryID = availableLibraries.find(library => (
            String(library.libraryID) === String(nextID)
        ))?.libraryID ?? nextID;
        setOpen(false);
        trigger.focus?.();
        if (changed) onChange?.(selectedLibraryID);
    });
    options.addEventListener('keydown', event => {
        const option = event.target?.closest?.(
            '.mktero-citation-popup-library-option'
        );
        if (!option || !options.contains(option)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            trigger.focus?.();
            return;
        }
        if (event.key === 'Tab') {
            setOpen(false);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            option.click();
            return;
        }
        const optionList = optionButtons();
        const index = optionList.indexOf(option);
        let nextIndex;
        if (event.key === 'ArrowDown') {
            nextIndex = (index + 1) % optionList.length;
        }
        else if (event.key === 'ArrowUp') {
            nextIndex = (index - 1 + optionList.length) % optionList.length;
        }
        else if (event.key === 'Home') {
            nextIndex = 0;
        }
        else if (event.key === 'End') {
            nextIndex = optionList.length - 1;
        }
        else {
            return;
        }
        event.preventDefault();
        focusOption(optionList[nextIndex].dataset.libraryId);
    });
    const closeOnOutsidePress = event => {
        if (!open) return;
        const path = event.composedPath?.() || [];
        if (!path.includes(picker)) setOpen(false);
    };
    document.defaultView?.addEventListener(
        'pointerdown',
        closeOnOutsidePress,
        { capture: true }
    );
    document.defaultView?.addEventListener(
        'mousedown',
        closeOnOutsidePress,
        { capture: true }
    );

    const render = ({
        libraries,
        selectedLibraryID: nextID,
        onChange: nextOnChange,
        t,
    }) => {
        availableLibraries = Array.isArray(libraries) ? libraries : [];
        onChange = nextOnChange;
        selectedLibraryID = availableLibraries.find(library => (
            String(library.libraryID) === String(nextID)
        ))?.libraryID ?? availableLibraries[0]?.libraryID ?? null;
        clearChildren(options);
        if (!availableLibraries.length) {
            appendLibraryPlaceholder(
                options,
                t('reference.noLibraries'),
                document
            );
            syncDisabled();
            trigger.setAttribute('aria-busy', 'false');
            current.textContent = t('reference.noLibraries');
            trigger.title = t('reference.noLibraries');
            setOpen(false);
            return;
        }
        for (const library of availableLibraries) {
            const option = createElement(document, 'button');
            option.type = 'button';
            option.className = 'mktero-citation-popup-library-option';
            option.dataset.libraryId = String(library.libraryID);
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.setAttribute('tabindex', '-1');
            if (!library.editable) {
                option.title = t('reference.errorLibraryReadOnly');
            }
            const optionLabel = createElement(document, 'span');
            optionLabel.className = 'mktero-citation-popup-library-option-label';
            optionLabel.textContent = libraryLabel(
                library,
                t('reference.readOnly')
            );
            option.append(
                createLucideIcon(document, LUCIDE_ICONS.check, {
                    className: 'mktero-citation-popup-library-option-check',
                    size: 14,
                }),
                optionLabel
            );
            options.appendChild(option);
        }
        syncDisabled();
        trigger.setAttribute('aria-busy', 'false');
        trigger.title = '';
        updateTrigger();
    };
    const renderError = message => {
        availableLibraries = [];
        selectedLibraryID = null;
        clearChildren(options);
        appendLibraryPlaceholder(options, message, document);
        syncDisabled();
        trigger.setAttribute('aria-busy', 'false');
        current.textContent = message;
        trigger.setAttribute('aria-label', `${label}: ${message}`);
        trigger.title = message;
        setOpen(false);
    };
    const destroy = () => {
        document.defaultView?.removeEventListener(
            'pointerdown',
            closeOnOutsidePress,
            { capture: true }
        );
        document.defaultView?.removeEventListener(
            'mousedown',
            closeOnOutsidePress,
            { capture: true }
        );
        document.defaultView?.removeEventListener('resize', positionOptions);
        document.defaultView?.removeEventListener(
            'scroll',
            positionOptions,
            true
        );
    };

    document.defaultView?.addEventListener('resize', positionOptions);
    document.defaultView?.addEventListener('scroll', positionOptions, true);

    return {
        element: picker,
        trigger,
        render,
        renderError,
        destroy,
    };
}

function clearChildren(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
}

function appendLibraryPlaceholder(options, text, document) {
    const option = createElement(document, 'div');
    option.className = 'mktero-citation-popup-library-placeholder';
    option.textContent = text;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-disabled', 'true');
    option.setAttribute('tabindex', '-1');
    options.appendChild(option);
}

function libraryLabel(library, readOnlyLabel) {
    return library?.editable
        ? library.name
        : `${library?.name} — ${readOnlyLabel}`;
}

function createElement(document, name) {
    return document.createElementNS?.(XHTML_NAMESPACE, name)
        || document.createElement(name);
}

function isReferenceTarget(target) {
    return Boolean(target)
        && !target.affiliation
        && !String(target.id || '').startsWith('affiliation:');
}

function createAbortController(parent) {
    const AbortControllerClass = parent.ownerDocument?.defaultView?.AbortController
        || globalThis.AbortController;
    return typeof AbortControllerClass === 'function'
        ? new AbortControllerClass()
        : { signal: {}, abort() {} };
}

function focusFirstItem(popup) {
    popup.querySelector('.mktero-citation-popup-primary')?.focus();
}
