// CodeMirror maps a pointer to a document position through its height map
// (posAtCoords). When that map disagrees with the real layout, a drag lands
// in a later paragraph and selects text the pointer never reached. Block
// widgets whose vertical margins escape their measured box used to cause
// that; ui/markdown.css now keeps that spacing inside the box, and this style
// is the safety net for whatever drift remains. It trusts what the DOM says is
// under the pointer:
// - text, or an empty line, maps through posAtDOM;
// - a widget (CodeMirror marks its root contenteditable=false) snaps to the
//   edge the pointer is nearer, vertically for a block widget and
//   horizontally for an inline one, as CodeMirror itself does;
// - with no hit at all, the element under the pointer picks a side of the
//   line child it is in, or the line's nearer end.

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
// Slack, in CSS pixels, when checking that a reported hit is still under the
// pointer.
const HIT_TOLERANCE = 2;

export function readerPointerSelectionExtension() {
    return EditorView.mouseSelectionStyle.of(readerPointerSelectionStyle);
}

// Double- and triple-click start from the same DOM-resolved press and select
// a word or a whole line, extending by that unit while dragging, as
// CodeMirror's default style does with its height-map position.
export function readerPointerSelectionStyle(view, event) {
    if (!event || event.button !== 0) return null;
    const start = resolvePointerSelectionPoint(view, event);
    if (!start) return null;
    const unit = Math.min(Math.max(event.detail || 1, 1), 3);
    let startPos = start.pos;
    let startSel = view.state.selection;
    return {
        update(update) {
            if (!update.docChanged) return;
            startPos = update.changes.mapPos(startPos);
            startSel = startSel.map(update.changes);
        },
        get(current, extend, multiple) {
            const point = resolvePointerSelectionPoint(view, current) || {
                pos: startPos,
                assoc: start.assoc,
            };
            return selectionFromPointer({
                startPos,
                startSel,
                head: point.pos,
                assoc: point.assoc,
                extend,
                multiple,
                unit,
                state: view.state,
                view,
            });
        },
    };
}

export function resolvePointerSelectionPoint(view, event) {
    const coordinate = coordinatePoint(view, event);
    const hit = pointerHit(view, event);
    if (hit) {
        const widget = widgetRootOf(view, hit.node);
        if (widget) return widgetEdgePoint(view, widget, event) || coordinate;
        const point = documentPoint(view, hit.node, hit.offset);
        if (point) {
            if (!coordinate || !sameLineBlock(view, coordinate.pos, point.pos)) {
                return point;
            }
            return coordinate;
        }
    }
    // No caret hit. The element under the pointer still says which widget or
    // line it is over.
    const element = elementAtPointer(view, event);
    if (!element) return coordinate;
    const widget = widgetRootOf(view, element);
    if (widget) return widgetEdgePoint(view, widget, event) || coordinate;
    const line = element.closest?.('.cm-line');
    if (!line) return coordinate;
    return clampToLine(view, coordinate, line, element, event);
}

// `unit` is the click count: 1 selects characters, 2 words, 3 lines.
export function selectionFromPointer({
    startPos,
    startSel,
    head,
    assoc = 0,
    extend = false,
    multiple = false,
    unit = 1,
    state = null,
    view = null,
}) {
    const range = unit > 1 && state
        ? unitRangeFromPointer(state, startPos, head, assoc, unit, extend, view)
        : characterRange(startPos, head, assoc);
    if (extend && startSel?.main?.extend && startSel.replaceRange) {
        const extended = unit > 1 && state
            ? startSel.main.extend(range.from, range.to, assoc)
            : startSel.main.extend(head, head, assoc);
        return startSel.replaceRange(extended);
    }
    if (multiple && startSel?.addRange) return startSel.addRange(range);
    return EditorSelection.create([range]);
}

function characterRange(startPos, head, assoc) {
    return startPos === head
        ? EditorSelection.cursor(head, assoc)
        : EditorSelection.range(startPos, head);
}

// The unit at the head, joined with the unit at the press, and directed
// toward the head like CodeMirror's default style.
function unitRangeFromPointer(state, startPos, head, assoc, unit, extend, view = null) {
    const current = unitRangeAt(state, head, assoc, unit, view);
    if (extend || startPos === head) return current;
    const started = unitRangeAt(state, startPos, assoc, unit, view);
    const from = Math.min(started.from, current.from);
    const to = Math.max(started.to, current.to);
    return from < current.from
        ? EditorSelection.range(from, to)
        : EditorSelection.range(to, from);
}

function unitRangeAt(state, pos, assoc, unit, view = null) {
    if (unit === 2) {
        return state.wordAt(pos)
            || characterGroupAt(state, pos)
            || EditorSelection.cursor(pos, assoc);
    }
    // The visual line, as CodeMirror selects it: a block that hides line
    // breaks (a folded section) is one line.
    const line = visualLineAt(state, pos, view);
    const to = line.to < state.doc.length && state.doc.lineAt(line.to).to === line.to
        ? line.to + 1
        : line.to;
    return EditorSelection.range(line.from, to);
}

function visualLineAt(state, pos, view) {
    try {
        const block = view?.lineBlockAt?.(pos);
        if (Number.isSafeInteger(block?.from) && Number.isSafeInteger(block?.to)
            && block.from <= pos && pos <= block.to) {
            return { from: block.from, to: block.to };
        }
    }
    catch {
        // Fall back to the document line.
    }
    const line = state.doc.lineAt(pos);
    return { from: line.from, to: line.to };
}

// A double-click on punctuation or space selects that run, as CodeMirror's
// default does, instead of placing a cursor.
function characterGroupAt(state, pos) {
    const line = state.doc.lineAt(pos);
    if (!line.length) return null;
    const categorize = state.charCategorizer(pos);
    const offset = Math.min(pos - line.from, line.length - 1);
    const at = line.text[offset];
    const category = categorize(at);
    let from = offset;
    let to = offset + 1;
    while (from > 0 && categorize(line.text[from - 1]) === category) from--;
    while (to < line.length && categorize(line.text[to]) === category) to++;
    return EditorSelection.range(line.from + from, line.from + to);
}

function coordinatePoint(view, event) {
    if (!hasPointer(event)) return null;
    const coords = { x: event.clientX, y: event.clientY };
    try {
        if (typeof view?.posAndSideAtCoords === 'function') {
            const point = view.posAndSideAtCoords(coords, false);
            return point && Number.isSafeInteger(point.pos)
                ? { pos: point.pos, assoc: point.assoc || 0 }
                : null;
        }
        if (typeof view?.posAtCoords !== 'function') return null;
        const pos = view.posAtCoords(coords, false);
        return Number.isSafeInteger(pos) ? { pos, assoc: 0 } : null;
    }
    catch {
        return null;
    }
}

function documentPoint(view, node, offset) {
    if (typeof view?.posAtDOM !== 'function') return null;
    try {
        const pos = view.posAtDOM(node, offset);
        if (!Number.isSafeInteger(pos)) return null;
        const length = view.state?.doc?.length;
        const clamped = Number.isSafeInteger(length)
            ? Math.max(0, Math.min(pos, length))
            : pos;
        return { pos: clamped, assoc: 0 };
    }
    catch {
        return null;
    }
}

// The caret query uses the current coordinates, so it wins. Firefox's
// rangeParent is the fallback and can be stale: a drag's autoscroll replays
// the last mousemove after the content has moved under it.
function pointerHit(view, event) {
    return caretHit(view, event) || currentRangeParentHit(view, event);
}

// Inside a shadow root the document-level query may answer with the host, and
// ShadowRoot may not have the query at all. Try each root and keep the first
// answer that lands in the editor content.
function caretHit(view, event) {
    if (!hasPointer(event)) return null;
    for (const root of pointerRoots(view, event)) {
        const caret = caretFrom(root, event);
        if (!caret?.offsetNode) continue;
        const hit = {
            node: caret.offsetNode,
            offset: clampOffset(caret.offsetNode, caret.offset),
        };
        if (insideContent(view, hit.node)) return hit;
    }
    return null;
}

function currentRangeParentHit(view, event) {
    const node = event?.rangeParent;
    if (!node || !Number.isInteger(event.rangeOffset)) return null;
    if (!insideContent(view, node)) return null;
    if (!pointerStillOver(node, event)) return null;
    return { node, offset: clampOffset(node, event.rangeOffset) };
}

function caretFrom(root, event) {
    if (typeof root?.caretPositionFromPoint !== 'function') return null;
    try {
        return root.caretPositionFromPoint(event.clientX, event.clientY);
    }
    catch {
        return null;
    }
}

function elementAtPointer(view, event) {
    if (!hasPointer(event)) return null;
    for (const root of pointerRoots(view, event)) {
        if (typeof root?.elementFromPoint !== 'function') continue;
        let element = null;
        try {
            element = root.elementFromPoint(event.clientX, event.clientY);
        }
        catch {
            element = null;
        }
        if (element && insideContent(view, element)) return element;
    }
    return null;
}

function pointerRoots(view, event) {
    const roots = [
        event?.target?.getRootNode?.(),
        view?.dom?.getRootNode?.(),
        event?.target?.ownerDocument,
        view?.dom?.ownerDocument,
    ];
    return roots.filter((root, index) => (
        root && roots.indexOf(root) === index
    ));
}

function contentOf(view) {
    return view?.contentDOM || view?.dom || null;
}

function insideContent(view, node) {
    const content = contentOf(view);
    if (!node || typeof content?.contains !== 'function') return false;
    try {
        return content.contains(node);
    }
    catch {
        return false;
    }
}

// A hit is current when the node still occupies the pointer's line. A node
// that cannot be measured here is accepted, since there is nothing better.
function pointerStillOver(node, event) {
    const rects = clientRectsOf(node);
    if (!rects?.length) return true;
    return rects.some(rect => (
        event.clientY >= rect.top - HIT_TOLERANCE
        && event.clientY <= rect.bottom + HIT_TOLERANCE
    ));
}

function clientRectsOf(node) {
    try {
        if (node.nodeType === ELEMENT_NODE) {
            return typeof node.getClientRects === 'function'
                ? Array.from(node.getClientRects())
                : null;
        }
        const range = node.ownerDocument?.createRange?.();
        if (!range || typeof range.getClientRects !== 'function') return null;
        range.selectNodeContents(node);
        return Array.from(range.getClientRects());
    }
    catch {
        return null;
    }
}

// The outermost widget root between the node and the content element.
// CodeMirror marks a widget's root contenteditable=false; table cells inside
// one carry the attribute too, so keep walking up.
function widgetRootOf(view, node) {
    const content = contentOf(view);
    let element = node?.nodeType === ELEMENT_NODE ? node : node?.parentElement;
    let root = null;
    while (element && element !== content) {
        if (isUneditable(element)) root = element;
        element = element.parentElement;
    }
    return element === content ? root : null;
}

function isUneditable(element) {
    return element.contentEditable === 'false'
        || element.getAttribute?.('contenteditable') === 'false';
}

function widgetEdgePoint(view, widget, event) {
    if (typeof view?.posAtDOM !== 'function') return null;
    try {
        const block = widget.parentNode === contentOf(view);
        const from = view.posAtDOM(widget, 0);
        if (!Number.isSafeInteger(from)) return null;
        const to = block
            ? blockWidgetEnd(view, from)
            : inlineWidgetEnd(view, widget, from);
        const rect = widget.getBoundingClientRect?.();
        const measured = rect && (rect.width > 0 || rect.height > 0);
        const after = measured && (block
            ? event.clientY > (rect.top + rect.bottom) / 2
            : event.clientX > (rect.left + rect.right) / 2);
        return after
            ? { pos: Math.max(from, to), assoc: -1 }
            : { pos: Math.min(from, to), assoc: 1 };
    }
    catch {
        return null;
    }
}

function blockWidgetEnd(view, from) {
    try {
        const block = view.lineBlockAt?.(from);
        return Number.isSafeInteger(block?.to) && block.to >= from
            ? block.to
            : from;
    }
    catch {
        return from;
    }
}

function inlineWidgetEnd(view, widget, from) {
    const parent = widget.parentNode;
    const index = parent
        ? Array.prototype.indexOf.call(parent.childNodes, widget)
        : -1;
    if (index < 0) return from;
    try {
        const to = view.posAtDOM(parent, index + 1);
        return Number.isSafeInteger(to) && to >= from ? to : from;
    }
    catch {
        return from;
    }
}

function sameLineBlock(view, left, right) {
    if (typeof view?.lineBlockAt !== 'function') return left === right;
    try {
        const start = view.lineBlockAt(left);
        const end = view.lineBlockAt(right);
        return Boolean(start && end && start.from === end.from);
    }
    catch {
        return false;
    }
}

function clampOffset(node, offset) {
    const length = node.nodeType === TEXT_NODE
        ? node.textContent?.length || 0
        : node.childNodes?.length || 0;
    return Math.max(0, Math.min(Number(offset) || 0, length));
}

function hasPointer(event) {
    return Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY);
}

// Last resort when no caret position is available: keep the coordinate if it
// is already inside the line under the pointer. Otherwise the element under
// the pointer decides: the line child holding it maps to its nearer side by
// its horizontal midpoint. Only when nothing there maps does the pointer fall
// to the line's nearer end.
function clampToLine(view, coordinate, line, element, event) {
    if (typeof view?.posAtDOM !== 'function' || typeof view?.lineBlockAt !== 'function') {
        return coordinate;
    }
    try {
        const lineStart = view.posAtDOM(line, 0);
        const lineEnd = view.posAtDOM(line, line.childNodes.length);
        if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)) {
            return coordinate;
        }
        const block = view.lineBlockAt(lineStart);
        if (!block || block.from !== view.lineBlockAt(lineEnd)?.from) {
            return coordinate;
        }
        if (coordinate && Number.isSafeInteger(coordinate.pos)
            && coordinate.pos >= block.from && coordinate.pos <= block.to) {
            return coordinate;
        }
        return lineChildPoint(view, line, element, event, block)
            || lineEndPoint(line, event, block, coordinate, lineStart);
    }
    catch {
        return coordinate;
    }
}

function lineChildPoint(view, line, element, event, block) {
    let child = element;
    while (child && child.parentNode !== line) child = child.parentNode;
    if (!child) return null;
    const index = Array.prototype.indexOf.call(line.childNodes, child);
    const rect = child.getBoundingClientRect?.();
    if (index < 0 || !rect || !(rect.width > 0)) return null;
    const after = event.clientX > (rect.left + rect.right) / 2;
    const pos = positionInLine(view, line, after ? index + 1 : index, block);
    return pos === null ? null : { pos, assoc: after ? -1 : 1 };
}

function positionInLine(view, line, offset, block) {
    try {
        const pos = view.posAtDOM(line, offset);
        return Number.isSafeInteger(pos) && pos >= block.from && pos <= block.to
            ? pos
            : null;
    }
    catch {
        return null;
    }
}

function lineEndPoint(line, event, block, coordinate, lineStart) {
    const rect = line.getBoundingClientRect?.();
    if (rect && rect.width > 0 && hasPointer(event)) {
        const after = event.clientX > (rect.left + rect.right) / 2;
        return { pos: after ? block.to : block.from, assoc: 0 };
    }
    if (!coordinate || !Number.isSafeInteger(coordinate.pos)) {
        return { pos: lineStart, assoc: 0 };
    }
    const clamped = Math.max(block.from, Math.min(coordinate.pos, block.to));
    return { pos: clamped, assoc: 0 };
}
