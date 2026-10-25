// Firefox places the anchor of a drag that starts in a figure caption before
// the caption's block image, so the selection swallows the previous
// paragraphs while the pointer never leaves the caption. The gesture remembers
// where the drag started. A selection that leaves that caption is pulled back
// unless the pointer has entered other selectable text.

const CAPTION_POINTER_TOLERANCE = 4;
const TEXT_NODE = 3;

export function figureCaptionOf(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const caption = element?.closest?.('figcaption') || null;
    return caption?.closest?.('figure') ? caption : null;
}

// Firefox mouse events carry the hit text on `rangeParent` even inside the
// reader's shadow root. `caretPositionFromPoint` is only the fallback.
export function captionPointerPoint(event) {
    if (!event) return null;
    if (event.rangeParent && Number.isInteger(event.rangeOffset)) {
        return textPoint(event.rangeParent, event.rangeOffset);
    }
    const root = event.target?.getRootNode?.();
    const ownerDocument = event.target?.ownerDocument;
    const caret = caretPoint(root, event) || caretPoint(ownerDocument, event);
    if (!caret?.offsetNode) return null;
    return textPoint(caret.offsetNode, caret.offset);
}

export function captionGestureShouldRelease(gesture, event) {
    if (!gesture?.caption || gesture.released || !event) return false;
    if (pointerHits(event, gesture.caption.getBoundingClientRect?.())) {
        return false;
    }
    const image = gesture.caption.closest('figure')?.querySelector('img');
    if (image && pointerHits(event, image.getBoundingClientRect?.())) {
        return false;
    }
    const point = captionPointerPoint(event);
    if (point && selectableTextOutside(point.node, gesture.caption)) return true;
    return selectableTextOutside(event.target, gesture.caption);
}

// Returns the replacement boundaries, or null when this selection should be
// left alone. A double-click keeps the word around the press; a triple-click
// keeps the caption. A drag keeps the press point and the end that is still
// inside the caption.
export function captionSelectionClamp(selection, gesture) {
    if (!gesture || gesture.released || !selection) return null;
    if (selection.isCollapsed || selection.rangeCount !== 1) return null;
    const caption = gesture.caption;
    const start = pointInside(gesture.startNode, gesture.startOffset, caption);
    if (!start || selectionInsideCaption(selection, caption)) return null;
    const detail = gesture.detail || 1;
    if (detail >= 3) return captionContents(caption);
    if (detail >= 2) {
        const word = wordRange(start.node, start.offset);
        if (word) {
            return boundaries(word.node, word.from, word.node, word.to);
        }
    }
    const focus = pointInside(
        selection.focusNode,
        selection.focusOffset,
        caption
    ) || pointInside(
        gesture.pointerNode,
        gesture.pointerOffset,
        caption
    ) || start;
    return boundaries(start.node, start.offset, focus.node, focus.offset);
}

// One extra write if the browser puts the leaked range back in the same turn.
// A third write would fight the browser forever, so this stops there.
export function applyCaptionSelectionClamp(selection, gesture) {
    const first = captionSelectionClamp(selection, gesture);
    if (!first || typeof selection?.setBaseAndExtent !== 'function') return false;
    if (!writeSelection(selection, first)) return false;
    const second = captionSelectionClamp(selection, gesture);
    if (second) writeSelection(selection, second);
    return true;
}

function writeSelection(selection, boundary) {
    try {
        selection.setBaseAndExtent(
            boundary.anchorNode,
            boundary.anchorOffset,
            boundary.focusNode,
            boundary.focusOffset
        );
        return true;
    }
    catch {
        return false;
    }
}

function selectionInsideCaption(selection, caption) {
    return Boolean(caption?.contains(selection.anchorNode)
        && caption.contains(selection.focusNode));
}

function pointInside(node, offset, caption) {
    if (!node || !caption?.contains(node)) return null;
    if (node.nodeType === TEXT_NODE) {
        const length = node.textContent?.length || 0;
        return {
            node,
            offset: Math.max(0, Math.min(Number(offset) || 0, length)),
        };
    }
    const point = textPoint(node, offset);
    return point && caption.contains(point.node) ? point : null;
}

function textPoint(node, offset) {
    if (!node) return null;
    if (node.nodeType === TEXT_NODE) {
        const length = node.textContent?.length || 0;
        return {
            node,
            offset: Math.max(0, Math.min(Number(offset) || 0, length)),
        };
    }
    if (node.nodeType !== 1) return null;
    const children = node.childNodes || [];
    const index = Number(offset) || 0;
    const child = children[index] || children[index - 1] || null;
    const text = firstTextNode(child);
    if (!text) return null;
    return {
        node: text,
        offset: index < children.length ? 0 : text.textContent.length,
    };
}

function firstTextNode(node) {
    if (!node) return null;
    if (node.nodeType === TEXT_NODE) return node.textContent ? node : null;
    for (const child of node.childNodes || []) {
        const text = firstTextNode(child);
        if (text) return text;
    }
    return null;
}

function caretPoint(root, event) {
    if (typeof root?.caretPositionFromPoint !== 'function') return null;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        return null;
    }
    try {
        return root.caretPositionFromPoint(event.clientX, event.clientY);
    }
    catch {
        return null;
    }
}

function pointerHits(pointer, rect) {
    const clientX = Number(pointer?.clientX);
    const clientY = Number(pointer?.clientY);
    return Number.isFinite(clientX)
        && Number.isFinite(clientY)
        && rect?.width > 0
        && rect?.height > 0
        && clientX >= rect.left - CAPTION_POINTER_TOLERANCE
        && clientX <= rect.right + CAPTION_POINTER_TOLERANCE
        && clientY >= rect.top - CAPTION_POINTER_TOLERANCE
        && clientY <= rect.bottom + CAPTION_POINTER_TOLERANCE;
}

function selectableTextOutside(node, caption) {
    if (!node || caption.contains(node)) return false;
    const otherCaption = figureCaptionOf(node);
    if (otherCaption) return otherCaption !== caption;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return false;
    if (element.closest?.('img, .cm-widgetBuffer')) return false;
    if (node.nodeType === TEXT_NODE) return Boolean(node.textContent?.trim());
    const block = element.closest?.(
        'p, li, td, th, h1, h2, h3, h4, h5, h6, .cm-line'
    );
    if (!block || caption.contains(block) || block.contains(caption)) {
        return false;
    }
    return Boolean(block.textContent?.trim());
}

function wordRange(node, offset) {
    if (node?.nodeType !== TEXT_NODE) return null;
    const text = node.textContent || '';
    if (!text) return null;
    let index = Math.max(0, Math.min(offset, text.length));
    if (index === text.length || /\s/u.test(text[index] || '')) {
        if (index === 0 || /\s/u.test(text[index - 1] || '')) return null;
        index -= 1;
    }
    let from = index;
    let to = index + 1;
    while (from > 0 && !/\s/u.test(text[from - 1])) from -= 1;
    while (to < text.length && !/\s/u.test(text[to])) to += 1;
    return to > from ? { node, from, to } : null;
}

function captionContents(caption) {
    let first = null;
    let last = null;
    for (const child of caption.childNodes || []) {
        const text = firstTextNode(child);
        if (!text) continue;
        if (!first) first = text;
        last = lastTextNode(child) || text;
    }
    if (!first || !last) return null;
    return boundaries(first, 0, last, last.textContent.length);
}

function lastTextNode(node) {
    if (!node) return null;
    if (node.nodeType === TEXT_NODE) return node.textContent ? node : null;
    const children = node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
        const text = lastTextNode(children[index]);
        if (text) return text;
    }
    return null;
}

function boundaries(anchorNode, anchorOffset, focusNode, focusOffset) {
    return { anchorNode, anchorOffset, focusNode, focusOffset };
}
