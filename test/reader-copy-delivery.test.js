import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import { VERIFY_DELAYS_MS } from '../src/editor/copy-delivery.js';

const MARKDOWN = 'Plain **bold** words here.\n\nSecond paragraph.';
const MARKDOWN_SOURCE = 'Plain **bold** words here.';
const RENDERED_TEXT = 'Plain bold words here.';
// The verification checks plus the 200 ms Ctrl+C grace period.
const DELIVERY_DELAYS = new Set([...VERIFY_DELAYS_MS, 200]);

const settle = () => new Promise(resolve => {
    setImmediate(resolve);
});

// Only the copy-delivery timers are held; the editor's other timers keep
// running on the real clock so CodeMirror behaves as it normally does.
function holdDeliveryTimers(window) {
    const held = [];
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => {
        if (!DELIVERY_DELAYS.has(delay)) {
            return realSetTimeout(callback, delay, ...args);
        }
        const timer = { callback, delay, cleared: false };
        held.push(timer);
        return timer;
    };
    window.clearTimeout = timer => {
        if (timer && typeof timer === 'object' && 'cleared' in timer) {
            timer.cleared = true;
            return;
        }
        realClearTimeout(timer);
    };
    return {
        pendingDelays: () => held
            .filter(timer => !timer.cleared)
            .map(timer => timer.delay),
        async fire(delay) {
            await settle();
            const timer = held.find(candidate => (
                !candidate.cleared && candidate.delay === delay
            ));
            assert.ok(timer, `expected a pending ${delay} ms timer`);
            timer.cleared = true;
            timer.callback();
            await settle();
        },
    };
}

function createCopyEditor({
    reads = [],
    deliverCopy: provided = true,
    isCopyDeliveryActive,
} = {}) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const timers = holdDeliveryTimers(window);
    const requests = [];
    const failures = [];
    const editor = createInlineMarkdownEditor({
        parent: window.document.querySelector('#editor'),
        initialMarkdown: '',
        deliverCopy: provided
            ? async request => {
                requests.push(request);
                if (request.action !== 'read') return undefined;
                const next = reads.shift();
                if (next instanceof Error) throw next;
                return next ?? null;
            }
            : null,
        isCopyDeliveryActive,
        onCopyDeliveryFailed: () => failures.push('failed'),
    });
    editor.setDocument({ markdown: MARKDOWN });
    return {
        dom,
        window,
        document: window.document,
        editor,
        timers,
        failures,
        writes: () => requests
            .filter(request => request.action === 'write')
            .map(request => request.text),
        reads: () => requests.filter(request => request.action === 'read').length,
        requests: () => [...requests],
    };
}

// Selects the first paragraph the way a drag would, and lets CodeMirror read
// the new DOM selection into its state.
async function selectFirstParagraph({ window, document }) {
    const line = document.querySelector('.cm-line');
    const walker = document.createTreeWalker(line, window.NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push(node);
    }
    const range = document.createRange();
    range.setStart(nodes[0], 0);
    range.setEnd(nodes.at(-1), nodes.at(-1).textContent.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new window.Event('selectionchange'));
    await new Promise(resolve => {
        setTimeout(resolve, 30);
    });
    return nodes[0];
}

// What Firefox does for Ctrl+C: a copy event at the selection, whose
// clipboardData the handlers fill in.
function dispatchCopy(window, target) {
    const data = new Map();
    const event = new window.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
        value: {
            clearData: () => data.clear(),
            setData: (type, value) => data.set(type, value),
            getData: type => data.get(type) || '',
        },
    });
    target.dispatchEvent(event);
    return { event, data };
}

test('leaves a reader copy alone once the clipboard holds it', async () => {
    const reader = createCopyEditor({ reads: [MARKDOWN_SOURCE] });
    try {
        const target = await selectFirstParagraph(reader);
        const { event, data } = dispatchCopy(reader.window, target);
        // CodeMirror still copies the Markdown source; delivery only checks.
        assert.equal(event.defaultPrevented, true);
        assert.equal(data.get('text/plain'), MARKDOWN_SOURCE);

        await reader.timers.fire(40);
        assert.equal(reader.reads(), 1);
        assert.deepEqual(reader.writes(), []);
        assert.deepEqual(reader.failures, []);
        assert.deepEqual(reader.timers.pendingDelays(), []);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('writes a reader copy again when the clipboard kept the previous text', async () => {
    const reader = createCopyEditor({
        reads: ['previous copy', MARKDOWN_SOURCE],
    });
    try {
        const target = await selectFirstParagraph(reader);
        dispatchCopy(reader.window, target);

        await reader.timers.fire(40);
        assert.deepEqual(reader.writes(), [MARKDOWN_SOURCE]);
        await reader.timers.fire(80);
        assert.deepEqual(reader.writes(), [MARKDOWN_SOURCE]);
        assert.deepEqual(reader.failures, []);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('a rewrite keeps the note HTML of a reader copy', async () => {
    const source = 'Mean $\\mu$ at locus $i$.';
    const reader = createCopyEditor({ reads: ['previous copy', source] });
    try {
        reader.editor.setDocument({ markdown: `${source}\n\nSecond paragraph.` });
        const target = await selectFirstParagraph(reader);
        const { data } = dispatchCopy(reader.window, target);
        assert.equal(data.get('text/plain'), source);
        assert.match(data.get('text/html'), /<span class="math">\$i\$<\/span>/u);

        await reader.timers.fire(40);
        const write = reader.requests().find(request => request.action === 'write');
        assert.equal(write.text, source);
        assert.equal(write.html, data.get('text/html'));
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('reports a reader copy that never reaches the clipboard', async () => {
    const reader = createCopyEditor({
        reads: VERIFY_DELAYS_MS.map(() => 'previous copy'),
    });
    try {
        const target = await selectFirstParagraph(reader);
        dispatchCopy(reader.window, target);

        for (const delay of VERIFY_DELAYS_MS) {
            await reader.timers.fire(delay);
        }
        assert.deepEqual(reader.failures, ['failed']);
        assert.equal(reader.writes().length, VERIFY_DELAYS_MS.length - 1);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('copies the reader selection when Ctrl+C produced no copy event', async () => {
    const reader = createCopyEditor({ reads: [MARKDOWN_SOURCE] });
    try {
        await selectFirstParagraph(reader);
        reader.editor.watchCopyShortcut();
        assert.deepEqual(reader.writes(), []);

        await reader.timers.fire(200);
        // Same text a normal copy puts on the clipboard: the Markdown source.
        assert.deepEqual(reader.writes(), [MARKDOWN_SOURCE]);
        await reader.timers.fire(40);
        assert.deepEqual(reader.failures, []);
        // The text CodeMirror supplied is not taken for a reader copy.
        assert.equal(reader.reads(), 1);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('does not copy again when Ctrl+C did produce a copy event', async () => {
    const reader = createCopyEditor({ reads: [MARKDOWN_SOURCE] });
    try {
        const target = await selectFirstParagraph(reader);
        reader.editor.watchCopyShortcut();
        dispatchCopy(reader.window, target);

        await reader.timers.fire(200);
        await reader.timers.fire(40);
        assert.deepEqual(reader.writes(), []);
        assert.equal(reader.reads(), 1);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('a copy elsewhere stops a reader delivery that is still checking', async () => {
    const reader = createCopyEditor({ reads: ['previous copy'] });
    try {
        const target = await selectFirstParagraph(reader);
        dispatchCopy(reader.window, target);
        reader.editor.cancelCopyDelivery();

        assert.deepEqual(reader.timers.pendingDelays(), []);
        assert.equal(reader.reads(), 0);
        assert.deepEqual(reader.writes(), []);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('a selection outside the reader is not checked', async () => {
    const reader = createCopyEditor();
    try {
        const outside = reader.document.createElement('p');
        outside.textContent = 'Outside text';
        reader.document.body.appendChild(outside);
        const range = reader.document.createRange();
        range.selectNodeContents(outside);
        reader.window.getSelection().removeAllRanges();
        reader.window.getSelection().addRange(range);

        reader.editor.watchCopyShortcut();
        dispatchCopy(reader.window, outside);
        assert.deepEqual(reader.timers.pendingDelays(), []);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('copies as before when the platform does not check copies', async () => {
    const reader = createCopyEditor({ deliverCopy: false });
    try {
        const target = await selectFirstParagraph(reader);
        reader.editor.watchCopyShortcut();
        const { event, data } = dispatchCopy(reader.window, target);

        assert.equal(event.defaultPrevented, true);
        assert.equal(data.get('text/plain'), MARKDOWN_SOURCE);
        assert.deepEqual(reader.timers.pendingDelays(), []);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('destroying the reader stops its copy checks', async () => {
    const reader = createCopyEditor({ reads: ['previous copy'] });
    const target = await selectFirstParagraph(reader);
    reader.editor.watchCopyShortcut();
    dispatchCopy(reader.window, target);
    reader.editor.destroy();

    assert.deepEqual(reader.timers.pendingDelays(), []);
    assert.equal(reader.reads(), 0);
    reader.dom.window.close();
});

test('a rendered-text copy is matched as rendered text', async () => {
    const reader = createCopyEditor({ reads: [`  ${RENDERED_TEXT}\r\n`] });
    try {
        await selectFirstParagraph(reader);
        // CodeMirror listens on .cm-content, so a copy that reaches only the
        // editor frame is left to Firefox, which copies the rendered text.
        const { event } = dispatchCopy(
            reader.window,
            reader.document.querySelector('.cm-editor')
        );
        assert.equal(event.defaultPrevented, false);

        await reader.timers.fire(40);
        assert.deepEqual(reader.writes(), []);
        assert.deepEqual(reader.failures, []);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

// A copy made inside a note or the PDF happens in another frame and may not
// reach the reader's window listener. Moving the keyboard there still stops
// a reader delivery before it writes, so it cannot overwrite that copy.
test('a reader delivery does not write once another frame has the keyboard', async () => {
    let readerHasKeyboard = true;
    const reader = createCopyEditor({
        reads: ['copied in the note'],
        isCopyDeliveryActive: () => readerHasKeyboard,
    });
    try {
        const target = await selectFirstParagraph(reader);
        dispatchCopy(reader.window, target);
        readerHasKeyboard = false;

        await reader.timers.fire(40);
        assert.deepEqual(reader.writes(), []);
        assert.deepEqual(reader.failures, []);
        assert.deepEqual(reader.timers.pendingDelays(), []);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});
