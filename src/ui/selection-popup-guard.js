import {
    intersectRects,
    selectionPopupShift,
    translateClientRects,
} from './selection-popup-placement.js';

const POPUP_SELECTOR = '.selection-popup';
const TRANSLATE = /translate\(\s*(-?(?:\d+\.?\d*|\.\d+))px\s*,\s*(-?(?:\d+\.?\d*|\.\d+))px\s*\)/;

// Zotero writes the popup position as translate() on an absolutely positioned
// element whose static top is not the viewport origin. A correction therefore
// has to be a delta from the popup's current border box, and only while that
// box actually covers selected text. Otherwise a later Zotero reposition (scroll,
// resize, or its own setTimeout) would be fighting a placement that was fine.
// The extension sandbox does not define queueMicrotask; looking it up as a
// default parameter throws while a PDF reader is opening.
export function installSelectionPopupGuard({
    document,
    selectionRects,
    viewRect,
    scrollTarget = null,
    schedule = null,
    onDispose = null,
} = {}) {
    const scheduleSoon = typeof schedule === 'function'
        ? schedule
        : callback => scheduleReaderTurn(document, callback);
    if (!document?.querySelector || typeof selectionRects !== 'function') {
        return () => {};
    }
    let disposed = false;
    let queued = false;
    let applying = false;
    const scrollTargets = new Set();
    const Observer = readerMutationObserver(document);
    const observer = Observer ? new Observer(request) : null;

    function request() {
        if (disposed) return;
        if (!document.defaultView || document.defaultView.closed) {
            dispose();
            return;
        }
        bindScrollTargets();
        if (queued) return;
        queued = true;
        scheduleSoon(() => {
            queued = false;
            if (!disposed) correct();
        });
    }

    function correct() {
        if (disposed || applying) return;
        try {
            const popup = document.querySelector(POPUP_SELECTOR);
            if (!popup?.isConnected || typeof popup.getBoundingClientRect !== 'function') {
                return;
            }
            const popupRect = popup.getBoundingClientRect();
            const lines = safeCall(selectionRects) || [];
            const view = safeCall(viewRect, popup);
            const shift = selectionPopupShift(popupRect, lines, view);
            if (!shift) return;
            applying = true;
            try {
                if (!applyTranslateShift(popup, shift.dx, shift.dy)) return;
                setPointerSide(popup, shift.side);
            }
            finally {
                applying = false;
            }
        }
        catch {
            applying = false;
        }
    }

    function bindScrollTargets() {
        watchScroll(document);
        watchScroll(document.defaultView);
        watchScroll(safeCall(scrollTarget));
    }

    function watchScroll(target) {
        if (!target?.addEventListener || scrollTargets.has(target)) return;
        scrollTargets.add(target);
        target.addEventListener('scroll', request, true);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        observer?.disconnect();
        for (const target of scrollTargets) {
            target.removeEventListener?.('scroll', request, true);
        }
        scrollTargets.clear();
        onDispose?.();
    }

    try {
        observer?.observe(document.documentElement || document, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['style', 'class'],
        });
    }
    catch {
        // A reader document that cannot be observed still gets the correction
        // scheduled below. Later Zotero repositions will not be followed.
    }
    request();
    return dispose;
}

export function readPdfSelectionRects(iframeWindow) {
    try {
        const selection = iframeWindow?.getSelection?.();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
        const frame = iframeWindow.frameElement;
        const origin = frame?.getBoundingClientRect?.();
        if (!origin || !Number.isFinite(origin.left) || !Number.isFinite(origin.top)
            || !origin.width || !origin.height) {
            return [];
        }
        const rects = [];
        for (let index = 0; index < selection.rangeCount; index += 1) {
            const range = selection.getRangeAt(index);
            const clientRects = range?.getClientRects?.();
            if (!clientRects) continue;
            for (const rect of clientRects) rects.push(rect);
        }
        return translateClientRects(rects, {
            left: origin.left,
            top: origin.top,
            scaleX: frameScale(origin.width, frame.clientWidth),
            scaleY: frameScale(origin.height, frame.clientHeight),
        });
    }
    catch {
        return [];
    }
}

export function pdfSelectionViewRect(popup, iframeWindow) {
    try {
        const parent = popup?.parentElement?.getBoundingClientRect?.();
        const frame = iframeWindow?.frameElement?.getBoundingClientRect?.();
        return intersectRects(parent, frame);
    }
    catch {
        return null;
    }
}

function scheduleReaderTurn(document, callback) {
    const view = document?.defaultView;
    if (typeof view?.queueMicrotask === 'function') {
        view.queueMicrotask(callback);
        return;
    }
    if (typeof view?.Promise?.resolve === 'function') {
        view.Promise.resolve().then(callback);
        return;
    }
    Promise.resolve().then(callback);
}

function readerMutationObserver(document) {
    const Observer = document?.defaultView?.MutationObserver;
    if (typeof Observer === 'function') return Observer;
    return typeof MutationObserver === 'function' ? MutationObserver : null;
}

function applyTranslateShift(popup, dx, dy) {
    const match = TRANSLATE.exec(popup.style?.transform || '');
    if (!match) return false;
    const left = roundPx(Number(match[1]) + dx);
    const top = roundPx(Number(match[2]) + dy);
    popup.style.transform = `translate(${left}px, ${top}px)`;
    return true;
}

function setPointerSide(popup, side) {
    if ((side !== 'top' && side !== 'bottom') || !popup.classList) return;
    const next = `page-popup-${side}-center`;
    if (popup.classList.contains(next)
        && ![...popup.classList].some(name => name.startsWith('page-popup-') && name !== next)) {
        return;
    }
    for (const name of [...popup.classList]) {
        if (name.startsWith('page-popup-')) popup.classList.remove(name);
    }
    popup.classList.add(next);
}

function frameScale(visualSize, clientSize) {
    if (!clientSize || !Number.isFinite(visualSize) || visualSize <= 0) return 1;
    const scale = visualSize / clientSize;
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function safeCall(fn, arg) {
    if (typeof fn !== 'function') return null;
    try {
        return fn(arg);
    }
    catch {
        return null;
    }
}

function roundPx(value) {
    return Math.round(value * 10) / 10;
}
