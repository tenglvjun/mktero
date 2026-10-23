import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoteroClipboard } from '../src/platform/zotero-clipboard.js';

test('writes sourced Markdown through the Firefox clipboard helper', async () => {
    const copied = [];
    const clipboard = createZoteroClipboard({
        classes: {
            '@mozilla.org/widget/clipboardhelper;1': {
                getService(interfaceType) {
                    assert.equal(interfaceType, 'nsIClipboardHelper');
                    return { copyString: value => copied.push(value) };
                },
            },
        },
        interfaces: { nsIClipboardHelper: 'nsIClipboardHelper' },
    });

    await clipboard.writeText('> Evidence\n\nSource: Paper, p. 1');

    assert.deepEqual(copied, ['> Evidence\n\nSource: Paper, p. 1']);
});

test('rejects empty clipboard content and unavailable helpers', async () => {
    let serviceRequests = 0;
    const clipboard = createZoteroClipboard({
        classes: {
            '@mozilla.org/widget/clipboardhelper;1': {
                getService() {
                    serviceRequests++;
                    return { copyString() {} };
                },
            },
        },
        interfaces: { nsIClipboardHelper: 'nsIClipboardHelper' },
    });

    await assert.rejects(() => clipboard.writeText(''), /clipboard/i);
    await assert.rejects(() => clipboard.writeText('   '), /clipboard/i);
    await assert.rejects(() => clipboard.writeText(null), /clipboard/i);
    assert.equal(serviceRequests, 0);

    const unavailable = createZoteroClipboard({ classes: {}, interfaces: {} });
    await assert.rejects(() => unavailable.writeText('Evidence'), /clipboard/i);
});

function readableClipboardComponents({ text = null, getData, missing = false } = {}) {
    const calls = [];
    const components = {
        classes: {
            '@mozilla.org/widget/clipboard;1': {
                getService(interfaceType) {
                    assert.equal(interfaceType, 'nsIClipboard');
                    return {
                        kGlobalClipboard: 1,
                        getData: getData || ((transferable, which) => {
                            calls.push(['getData', which]);
                            transferable.stored = text;
                        }),
                    };
                },
            },
            '@mozilla.org/widget/transferable;1': {
                createInstance(interfaceType) {
                    assert.equal(interfaceType, 'nsITransferable');
                    return {
                        stored: null,
                        init(context) {
                            calls.push(['init', context]);
                        },
                        addDataFlavor(flavor) {
                            calls.push(['addDataFlavor', flavor]);
                        },
                        getTransferData(flavor, out) {
                            if (missing || this.stored === null) {
                                throw new Error('NS_ERROR_FAILURE');
                            }
                            out.value = {
                                QueryInterface: () => ({ data: this.stored }),
                            };
                        },
                    };
                },
            },
        },
        interfaces: {
            nsIClipboard: 'nsIClipboard',
            nsITransferable: 'nsITransferable',
            nsISupportsString: 'nsISupportsString',
        },
    };
    return { components, calls };
}

test('reads the plain text on the system clipboard', async () => {
    const { components, calls } = readableClipboardComponents({
        text: 'Copied passage',
    });
    const clipboard = createZoteroClipboard(components);

    assert.equal(await clipboard.readText(), 'Copied passage');
    assert.deepEqual(calls, [
        ['init', null],
        ['addDataFlavor', 'text/plain'],
        ['getData', 1],
    ]);
});

test('reports a clipboard with no text as null', async () => {
    const { components } = readableClipboardComponents({ missing: true });
    const clipboard = createZoteroClipboard(components);

    assert.equal(await clipboard.readText(), null);
});

test('lets a clipboard that cannot be opened reject the read', async () => {
    const { components } = readableClipboardComponents({
        getData() {
            throw new Error('NS_ERROR_FAILURE');
        },
    });
    const clipboard = createZoteroClipboard(components);

    await assert.rejects(() => clipboard.readText(), /NS_ERROR_FAILURE/);
    const unavailable = createZoteroClipboard({ classes: {}, interfaces: {} });
    await assert.rejects(() => unavailable.readText(), /clipboard/i);
});
