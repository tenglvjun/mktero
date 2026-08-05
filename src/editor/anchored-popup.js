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

    const cancelClose = () => {
        if (closeTimer === null) return;
        ownerWindow.clearTimeout(closeTimer);
        closeTimer = null;
    };

    const close = () => {
        cancelClose();
        if (anchor && popup
            && anchor.getAttribute?.('aria-describedby') === popup.id) {
            anchor.removeAttribute?.('aria-describedby');
        }
        popup?.remove();
        popup = null;
        anchor = null;
    };

    const scheduleClose = () => {
        cancelClose();
        const root = parent.getRootNode?.();
        const activeElement = root?.activeElement || document.activeElement;
        if (popup?.contains(activeElement)) return;
        closeTimer = ownerWindow.setTimeout(close, 120);
    };

    const reposition = () => {
        if (!popup || !anchor) return;
        positionPopup(popup, anchor, ownerWindow, viewportPadding);
    };

    const open = ({
        anchor: nextAnchor,
        label,
        renderContent,
        focusContent,
        popupClassName,
        dismissOnMouseLeave = true,
    }) => {
        if (!nextAnchor || typeof renderContent !== 'function') return;
        if (ignoredOpenAnchor === nextAnchor) {
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
        popup.addEventListener('mouseenter', cancelClose);
        if (dismissOnMouseLeave) {
            popup.addEventListener('mouseleave', scheduleClose);
        }
        popup.addEventListener('focusin', cancelClose);
        popup.addEventListener('focusout', event => {
            if (!popup?.contains(event.relatedTarget)) scheduleClose();
        });
        popup.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            const returnFocus = anchor;
            event.preventDefault();
            event.stopPropagation();
            close();
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

function positionPopup(popup, anchor, ownerWindow, viewportPadding) {
    const gap = 10;
    const anchorRect = anchor.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const viewportWidth = ownerWindow.innerWidth || 1024;
    const viewportHeight = ownerWindow.innerHeight || 768;
    const width = Math.min(popupRect.width, viewportWidth - viewportPadding * 2);
    const preferredLeft = anchorRect.left + anchorRect.width / 2 - width / 2;
    const left = clamp(
        preferredLeft,
        viewportPadding,
        Math.max(viewportPadding, viewportWidth - width - viewportPadding)
    );
    const above = anchorRect.top - popupRect.height - gap;
    const below = anchorRect.bottom + gap;
    const placeAbove = above >= viewportPadding
        || below + popupRect.height > viewportHeight;
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
        placeAbove ? Math.max(viewportPadding, above) : below
    )}px`;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}
