import { rootSelectionFor } from './root-selection.js';

const HOVER_OPEN_DELAY_MS = 450;
const HOVER_MOVEMENT_PX = 6;

// Mouse intent belongs to the reader, rather than to each popup. In particular,
// cancelling a timer must also invalidate a callback already queued by Gecko.
export function createReferenceHoverController(view, {
    interactionAt,
    isLocked,
    popups,
    cancelOtherHover,
}) {
    const document = view.dom.ownerDocument;
    const ownerWindow = document.defaultView;
    const root = view.dom.getRootNode();
    const listeners = [];
    let pending = null;
    let hovered = null;
    let visible = null;
    let suppressedAnchor = null;
    let pressed = false;
    let needsMovement = false;
    let destroyed = false;

    const listen = (target, type, handler, capture = true) => {
        target.addEventListener(type, handler, capture);
        listeners.push(() => target.removeEventListener(type, handler, capture));
    };
    const inPopup = event => popups.some(popup => (
        event.composedPath?.().some(node => node?.nodeType && popup.contains(node))
        || popup.contains(event.target)
    ));
    const inReader = event => view.dom.contains(event.target)
        || Boolean(event.composedPath?.().includes(view.dom));
    const cancel = () => {
        if (!pending) return;
        ownerWindow.clearTimeout(pending.timer);
        pending = null;
    };
    const close = () => {
        for (const popup of popups) popup.close();
        visible = null;
    };
    const reset = () => {
        cancel();
        close();
        hovered = null;
        needsMovement = true;
    };
    const blocked = event => destroyed || pressed || Boolean(event?.buttons)
        || isLocked() || hasReaderSelection(view);
    const previewAt = event => {
        const interaction = interactionAt(event);
        return interaction?.hoverPreview ? interaction : null;
    };
    const schedule = (interaction, event) => {
        hovered = interaction;
        cancelOtherHover();
        if (blocked(event) || needsMovement
            || suppressedAnchor === interaction.element) {
            cancel();
            return;
        }
        if (visible?.element === interaction.element
            && interaction.popup.isOpen()) {
            interaction.popup.cancelClose();
            return;
        }
        if (pending?.interaction.element === interaction.element) return;
        cancel();
        if (visible?.element !== interaction.element) close();
        const next = {
            interaction,
            x: event.clientX,
            y: event.clientY,
            timer: null,
        };
        pending = next;
        next.timer = ownerWindow.setTimeout(() => {
            if (pending !== next) return;
            pending = null;
            if (blocked() || needsMovement
                || suppressedAnchor === interaction.element
                || hovered?.element !== interaction.element
                || !interaction.element.isConnected
                || !view.dom.isConnected
                || document.hidden) return;
            interaction.open();
            visible = interaction;
        }, HOVER_OPEN_DELAY_MS);
    };
    const onOver = event => {
        const interaction = previewAt(event);
        if (interaction) schedule(interaction, event);
    };
    const onMove = event => {
        if (suppressedAnchor && !suppressedAnchor.contains(event.target)) {
            suppressedAnchor = null;
        }
        const interaction = previewAt(event);
        if (blocked(event)) {
            cancel();
            return;
        }
        needsMovement = false;
        if (!interaction) return;
        if (pending && Math.hypot(
            event.clientX - pending.x,
            event.clientY - pending.y
        ) > HOVER_MOVEMENT_PX) cancel();
        schedule(interaction, event);
    };
    const onOut = event => {
        const interaction = previewAt(event);
        if (!interaction || interaction.element.contains(event.relatedTarget)) return;
        if (suppressedAnchor === interaction.element) suppressedAnchor = null;
        if (hovered?.element === interaction.element) hovered = null;
        cancel();
        if (interaction.popup.isOpen()
            && !interaction.popup.contains(event.relatedTarget)) {
            interaction.popup.scheduleClose();
        }
    };
    const onPress = event => {
        if (inPopup(event)) return;
        pressed = true;
        cancelOtherHover();
        reset();
    };
    const onRelease = () => {
        pressed = false;
        // A release is not a fresh hover, even when a drag produced no text.
        needsMovement = true;
    };
    const onScroll = event => {
        if (inPopup(event)) return;
        cancelOtherHover();
        reset();
    };
    const onSelection = () => {
        const selection = rootSelectionFor(view.dom);
        if (popups.some(popup => popup.contains(selection?.anchorNode))) return;
        if (hasReaderSelection(view) || isLocked()) reset();
    };
    const onKey = event => {
        if (event.key === 'Tab') suppressedAnchor = null;
        if (event.key !== 'Escape') return;
        const neutralTarget = event.target === document.body
            || event.target === document.documentElement
            || event.target === document;
        if (!inReader(event) && !inPopup(event) && !neutralTarget) return;
        const interaction = pending?.interaction || visible || hovered;
        const open = popups.some(popup => popup.isOpen());
        if (!pending && !open) return;
        suppressedAnchor = interaction?.element || null;
        cancel();
        cancelOtherHover();
        needsMovement = true;
        // Let the popup's Escape handler return keyboard focus to its anchor.
        if (inPopup(event)) return;
        close();
        event.preventDefault();
        event.stopPropagation();
    };
    const onBlur = event => {
        if (event.target !== ownerWindow) return;
        pressed = false;
        reset();
    };
    const onFocusOut = event => {
        if (view.dom.contains(event.relatedTarget)
            || popups.some(popup => popup.contains(event.relatedTarget))) return;
        reset();
    };
    const onFocusIn = event => {
        if (!inReader(event) && !inPopup(event)) reset();
    };

    listen(view.dom, 'mouseover', onOver);
    listen(view.dom, 'mousemove', onMove);
    listen(view.dom, 'mouseout', onOut);
    listen(view.dom, 'focusout', onFocusOut);
    // Capture before CodeMirror or native widgets start a selection. Listening
    // on the root also dismisses previews when the next press is outside text.
    for (const type of ['mousedown', 'pointerdown']) {
        listen(root, type, onPress);
        if (root !== document) listen(document, type, onPress);
    }
    for (const type of ['mouseup', 'pointerup', 'pointercancel']) {
        listen(ownerWindow, type, onRelease);
    }
    for (const type of ['scroll', 'wheel']) listen(root, type, onScroll);
    listen(document, 'focusin', onFocusIn);
    listen(document, 'selectionchange', onSelection);
    listen(document, 'keydown', onKey);
    listen(ownerWindow, 'blur', onBlur);
    listen(document, 'visibilitychange', reset);

    return {
        focus(interaction) {
            cancel();
            if (pressed || suppressedAnchor === interaction.element) return;
            interaction.open();
            visible = interaction;
        },
        cancel,
        reset,
        update(update) {
            if (update.docChanged) reset();
            else if (update.selectionSet) onSelection();
        },
        destroy() {
            destroyed = true;
            cancel();
            close();
            for (const remove of listeners) remove();
            hovered = null;
            visible = null;
            suppressedAnchor = null;
        },
    };
}

function hasReaderSelection(view) {
    const selection = rootSelectionFor(view.dom);
    if (selection && !selection.isCollapsed && (
        view.dom.contains(selection.anchorNode)
        || view.dom.contains(selection.focusNode)
    )) return true;
    return view.state.selection.ranges.some(range => !range.empty);
}
