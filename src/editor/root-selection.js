// The reader lives in a shadow root. Gecko (Zotero) reports a selection inside
// it through `document.getSelection()` with the real shadow-tree nodes, but
// Blink and WebKit retarget those nodes to the shadow host. Blink exposes the
// real nodes on `ShadowRoot.getSelection()`; WebKit only through
// `Selection.getComposedRanges()`. This returns a Selection-like view whose
// nodes are inside `root` whenever the browser can provide them.

export function rootSelection(root) {
    const document = root?.ownerDocument || root;
    const selection = document?.getSelection?.() || null;
    if (!selection || !isShadowRoot(root) || selectionIsInside(selection, root)) {
        return selection;
    }
    const shadowSelection = typeof root.getSelection === 'function'
        ? root.getSelection()
        : null;
    if (shadowSelection && selectionIsInside(shadowSelection, root)) {
        return shadowSelection;
    }
    return composedSelection(selection, root) || selection;
}

export function rootSelectionFor(node) {
    return rootSelection(node?.getRootNode?.() || node?.ownerDocument);
}

function isShadowRoot(root) {
    return Boolean(root?.host) && root.nodeType === 11;
}

function selectionIsInside(selection, root) {
    const node = selection.anchorNode;
    return Boolean(node) && root.contains(node);
}

// WebKit: rebuild a live Range from the composed boundary points. Direction is
// not exposed, so the start is reported as the anchor. WebKit also reports the
// retargeted selection as collapsed (both ends map to the host), so collapse is
// decided from the composed range, not from `selection.isCollapsed`.
function composedSelection(selection, root) {
    if (typeof selection.getComposedRanges !== 'function'
        || !selection.rangeCount) {
        return null;
    }
    let staticRange;
    try {
        staticRange = selection.getComposedRanges({ shadowRoots: [root] })[0]
            || null;
    }
    catch {
        try {
            // Safari 17 takes the shadow roots as positional arguments.
            staticRange = selection.getComposedRanges(root)[0] || null;
        }
        catch {
            return null;
        }
    }
    if (!staticRange
        || !root.contains(staticRange.startContainer)
        || !root.contains(staticRange.endContainer)) {
        return null;
    }
    const range = root.ownerDocument.createRange();
    try {
        range.setStart(staticRange.startContainer, staticRange.startOffset);
        range.setEnd(staticRange.endContainer, staticRange.endOffset);
    }
    catch {
        return null;
    }
    return {
        anchorNode: range.startContainer,
        anchorOffset: range.startOffset,
        focusNode: range.endContainer,
        focusOffset: range.endOffset,
        isCollapsed: range.collapsed,
        rangeCount: 1,
        getRangeAt: index => {
            if (index !== 0) throw new RangeError('Selection index out of range');
            return range;
        },
        toString: () => selection.toString(),
        removeAllRanges: () => selection.removeAllRanges(),
        setBaseAndExtent: (...args) => selection.setBaseAndExtent(...args),
        addRange: added => selection.addRange(added),
    };
}
