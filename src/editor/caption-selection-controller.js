import {
    applyCaptionSelectionClamp,
    captionGestureShouldRelease,
    captionPointerPoint,
    figureCaptionOf,
} from './caption-selection-clamp.js';
import { rootSelectionFor } from './root-selection.js';

// A caption is a rendered widget, not an editable CodeMirror text range.
// While it owns a native selection, let its gesture repair the browser's
// leaked anchor before an editor observer can map it to a widget boundary.
export function createCaptionSelectionController({
    parent,
    editorDOM,
    onGestureStart = () => {},
    onSelectionChange = () => {},
}) {
    const document = parent.ownerDocument;
    const window = document.defaultView;
    let gesture = null;
    let retainedCaption = null;
    let focusableCaption = null;
    let changing = false;
    let destroyed = false;

    const releaseCaptionFocus = () => {
        if (focusableCaption?.getAttribute('tabindex') === '-1') {
            focusableCaption.removeAttribute('tabindex');
        }
        focusableCaption = null;
    };
    const clear = () => {
        gesture = null;
        retainedCaption = null;
        releaseCaptionFocus();
    };
    const inside = (selection, caption) => Boolean(caption?.isConnected
        && editorDOM.contains(caption)
        && selection?.rangeCount === 1
        && caption.contains(selection.anchorNode)
        && caption.contains(selection.focusNode));
    const begin = event => {
        if (event.button !== 0) return;
        clear();
        onGestureStart();
        const point = captionPointerPoint(event);
        const caption = figureCaptionOf(event.target) || figureCaptionOf(point?.node);
        if (!caption || !editorDOM.contains(caption)
            || point?.node?.nodeType !== 3 || !caption.contains(point.node)) {
            return;
        }
        // A native press must focus the widget rather than cm-content.
        // CodeMirror's measurement queue reads selections without emitting
        // selectionchange and otherwise writes its widget-edge cursor back.
        if (!caption.hasAttribute('tabindex')) {
            focusableCaption = caption;
            caption.setAttribute('tabindex', '-1');
        }
        gesture = {
            caption,
            startNode: point.node,
            startOffset: point.offset,
            detail: event.detail || 1,
            released: false,
            pointerNode: point.node,
            pointerOffset: point.offset,
        };
    };
    const track = event => {
        if (!gesture || gesture.released) return;
        if (event.type === 'mousemove' && event.buttons !== 1) return;
        if (captionGestureShouldRelease(gesture, event)) {
            gesture.released = true;
            retainedCaption = null;
            releaseCaptionFocus();
            return;
        }
        const point = captionPointerPoint(event);
        if (point && gesture.caption.contains(point.node)) {
            gesture.pointerNode = point.node;
            gesture.pointerOffset = point.offset;
        }
    };
    const clamp = () => {
        if (changing || destroyed || !gesture || gesture.released
            || !gesture.caption.isConnected) {
            return;
        }
        changing = true;
        try {
            applyCaptionSelectionClamp(rootSelectionFor(parent), gesture);
        }
        finally {
            changing = false;
        }
    };
    const prepare = event => {
        track(event);
        clamp();
    };
    const finish = event => {
        if (event.button !== 0) return;
        prepare(event);
        const selection = rootSelectionFor(parent);
        retainedCaption = gesture && !gesture.released
            && !selection?.isCollapsed && inside(selection, gesture.caption)
            ? gesture.caption : null;
        gesture = null;
        if (!retainedCaption) releaseCaptionFocus();
    };
    const selectionChanged = event => {
        const selection = rootSelectionFor(parent);
        const dragging = gesture && !gesture.released
            && gesture.caption.isConnected && editorDOM.contains(gesture.caption);
        if (dragging || (!selection?.isCollapsed && inside(selection, retainedCaption))) {
            // Capture is scoped to this caption's gesture/retained selection.
            // Other editors and ordinary text keep their selection observers.
            event.stopImmediatePropagation();
            clamp();
        }
        else {
            retainedCaption = null;
            releaseCaptionFocus();
        }
        onSelectionChange();
    };
    const outsidePress = event => {
        if (!event.composedPath?.().includes(parent)
            && !parent.contains(event.target)) clear();
    };
    const keyDown = () => clear();
    const focusChanged = event => {
        if (retainedCaption && (event.type === 'blur'
            ? !retainedCaption.contains(event.relatedTarget)
            : !retainedCaption.contains(event.target))) {
            clear();
        }
        if (gesture && !gesture.released && gesture.caption.isConnected
            && editorDOM.contains(gesture.caption) && editorDOM.contains(event.target)) {
            // A delayed editor focus refresh restores its cursor over a native
            // widget range. Only the active caption gesture owns that range;
            // focus notifications resume after mouseup or cancellation.
            event.stopImmediatePropagation();
        }
    };

    parent.addEventListener('focus', focusChanged, true);
    parent.addEventListener('blur', focusChanged, true);
    parent.addEventListener('mousedown', begin, true);
    parent.addEventListener('mousemove', track, true);
    document.addEventListener('mousedown', outsidePress, true);
    document.addEventListener('selectionchange', selectionChanged, true);
    document.addEventListener('keydown', keyDown, true);
    window.addEventListener('mouseup', finish);
    window.addEventListener('blur', clear);
    return {
        prepare,
        clear,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            clear();
            parent.removeEventListener('focus', focusChanged, true);
            parent.removeEventListener('blur', focusChanged, true);
            parent.removeEventListener('mousedown', begin, true);
            parent.removeEventListener('mousemove', track, true);
            document.removeEventListener('mousedown', outsidePress, true);
            document.removeEventListener('selectionchange', selectionChanged, true);
            document.removeEventListener('keydown', keyDown, true);
            window.removeEventListener('mouseup', finish);
            window.removeEventListener('blur', clear);
        },
    };
}
