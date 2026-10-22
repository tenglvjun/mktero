let nextPopupID = 1;
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function createAnchoredPopup(parent, {
    className,
    idPrefix,
    viewportPadding = 12,
}) {
    const document = parent.ownerDocument;
    const ownerWindow = document.defaultView;
    let popup = null;
    let anchor = null;
    let ignoredOpenAnchor = null;
    let closeTimer = null;
    let closeHandler = null;
    // Where each anchor element last was. An editor rebuild can replace the
    // rendered element an open popup points at, and a detached element
    // reports an empty rect at the window origin.
    const anchorRects = new WeakMap();

    const anchorRect = target => {
        const isElement = typeof target?.nodeType === 'number';
        if (isElement && target.isConnected === false) {
            const last = anchorRects.get(target);
            if (last) return last;
        }
        const rect = target.getBoundingClientRect();
        if (isElement) anchorRects.set(target, rect);
        return rect;
    };

    const cancelClose = () => {
        if (closeTimer === null) return;
        ownerWindow.clearTimeout(closeTimer);
        closeTimer = null;
    };

    // `reason` is 'escape' or 'dismiss' when the popup closes itself, and
    // undefined when its owner calls close().
    const close = reason => {
        cancelClose();
        const onClose = closeHandler;
        closeHandler = null;
        if (anchor && popup
            && anchor.getAttribute?.('aria-describedby') === popup.id) {
            anchor.removeAttribute?.('aria-describedby');
        }
        popup?.remove();
        popup = null;
        anchor = null;
        onClose?.(reason);
    };

    const scheduleClose = () => {
        cancelClose();
        const root = parent.getRootNode?.();
        const activeElement = root?.activeElement || document.activeElement;
        if (popup?.contains(activeElement)) return;
        closeTimer = ownerWindow.setTimeout(() => close('dismiss'), 120);
    };

    const reposition = () => {
        if (!popup || !anchor) return;
        positionPopup(
            popup,
            anchorRect(anchor),
            popupBoundary(parent, ownerWindow),
            viewportPadding
        );
    };

    const open = ({
        anchor: nextAnchor,
        label,
        renderContent,
        focusContent,
        popupClassName,
        dismissOnMouseLeave = true,
        onClose,
        forceOpen = false,
    }) => {
        if (!nextAnchor || typeof renderContent !== 'function') return;
        if (ignoredOpenAnchor === nextAnchor && !forceOpen) {
            ignoredOpenAnchor = null;
            return;
        }
        if (anchor === nextAnchor && popup) {
            cancelClose();
            focusContent?.(popup);
            return;
        }
        close();
        anchor = nextAnchor;
        closeHandler = typeof onClose === 'function' ? onClose : null;
        popup = document.createElementNS(XHTML_NAMESPACE, 'div');
        popup.id = `${idPrefix}-${nextPopupID++}`;
        popup.className = [className, popupClassName]
            .filter(Boolean)
            .join(' ');
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-label', label);
        const content = renderContent({ document, close, reposition });
        if (!content) {
            close();
            return;
        }
        popup.appendChild(content);
        popup.addEventListener('mousedown', event => {
            event.stopPropagation();
        });
        popup.addEventListener('mouseenter', cancelClose);
        if (dismissOnMouseLeave) {
            popup.addEventListener('mouseleave', scheduleClose);
        }
        popup.addEventListener('focusin', cancelClose);
        popup.addEventListener('focusout', event => {
            if (popup?.contains(event.relatedTarget)) return;
            if (!event.relatedTarget
                && lostFocusToPopupState(popup, event.target)) {
                return;
            }
            scheduleClose();
        });
        popup.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            const returnFocus = anchor;
            event.preventDefault();
            event.stopPropagation();
            close('escape');
            ignoredOpenAnchor = returnFocus;
            returnFocus?.focus?.();
            ownerWindow.setTimeout(() => {
                if (ignoredOpenAnchor === returnFocus) {
                    ignoredOpenAnchor = null;
                }
            }, 0);
        });
        parent.appendChild(popup);
        anchor.setAttribute?.('aria-describedby', popup.id);
        reposition();
        focusContent?.(popup);
    };

    return {
        open,
        close,
        scheduleClose,
        cancelClose,
        isOpen() {
            return Boolean(popup);
        },
        contains(element) {
            return Boolean(element && popup?.contains(element));
        },
        destroy: close,
    };
}

// The visible area a popup may occupy: the window viewport intersected with
// the shadow host that holds the reader. Zotero lays the item pane and other
// chrome over the window beside the tab, so clamping to the window alone lets
// a popup slide underneath them.
function popupBoundary(parent, ownerWindow) {
    const viewport = {
        left: 0,
        top: 0,
        right: ownerWindow.innerWidth || 1024,
        bottom: ownerWindow.innerHeight || 768,
    };
    const host = parent.getRootNode?.()?.host;
    const rect = host?.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return viewport;
    const boundary = {
        left: Math.max(viewport.left, rect.left),
        top: Math.max(viewport.top, rect.top),
        right: Math.min(viewport.right, rect.right),
        bottom: Math.min(viewport.bottom, rect.bottom),
    };
    if (boundary.right <= boundary.left || boundary.bottom <= boundary.top) {
        return viewport;
    }
    return boundary;
}

function positionPopup(popup, anchorRect, boundary, viewportPadding) {
    const gap = 10;
    const available = Math.max(
        0,
        boundary.right - boundary.left - viewportPadding * 2
    );
    popup.style.maxWidth = `${Math.floor(available)}px`;
    const popupRect = popup.getBoundingClientRect();
    const width = Math.min(popupRect.width, available);
    const minLeft = boundary.left + viewportPadding;
    const minTop = boundary.top + viewportPadding;
    const preferredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
    const left = clamp(
        preferredLeft,
        minLeft,
        Math.max(minLeft, boundary.right - width - viewportPadding)
    );
    const above = anchorRect.top - popupRect.height - gap;
    const below = anchorRect.bottom + gap;
    const placeAbove = above >= minTop
        || below + popupRect.height > boundary.bottom;
    const arrowLeft = clamp(
        anchorRect.left + anchorRect.width / 2 - left,
        12,
        Math.max(12, width - 12)
    );
    popup.dataset.placement = placeAbove ? 'top' : 'bottom';
    popup.style.setProperty(
        '--anchored-popup-arrow-left',
        `${Math.round(arrowLeft)}px`
    );
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(
        placeAbove ? Math.max(minTop, above) : below
    )}px`;
}

// Gecko and Blink blur a focused control that becomes disabled or hidden and
// report no relatedTarget. That is the popup changing its own state, such as a
// button starting async work, not the user leaving the popup.
function lostFocusToPopupState(popup, target) {
    if (!popup || !target?.isConnected || !popup.contains(target)) {
        return false;
    }
    return Boolean(target.disabled || target.closest?.('[hidden]'));
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}
