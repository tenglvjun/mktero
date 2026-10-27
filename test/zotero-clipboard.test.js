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

function richClipboardComponents({
    setData,
    init,
    missingSupports = false,
    missingTransferable = false,
    missingClipboard = false,
} = {}) {
    const calls = [];
    const copied = [];
    const classes = {
        '@mozilla.org/widget/clipboardhelper;1': {
            getService(interfaceType) {
                assert.equal(interfaceType, 'nsIClipboardHelper');
                calls.push('helper');
                return {
                    copyString(value) {
                        copied.push(value);
                    },
                };
            },
        },
    };
    if (!missingClipboard) {
        classes['@mozilla.org/widget/clipboard;1'] = {
            getService(interfaceType) {
                assert.equal(interfaceType, 'nsIClipboard');
                calls.push('clipboard');
                return {
                    kGlobalClipboard: 42,
                    setData: setData || function setClipboardData(
                        transferable,
                        owner,
                        which
                    ) {
                        calls.push([
                            'setData',
                            owner,
                            which,
                            arguments.length,
                            transferable.flavors.map(flavor => ({
                                flavor: flavor.flavor,
                                data: flavor.supports.data,
                                length: flavor.length,
                            })),
                        ]);
                    },
                };
            },
        };
    }
    if (!missingTransferable) {
        classes['@mozilla.org/widget/transferable;1'] = {
            createInstance(interfaceType) {
                assert.equal(interfaceType, 'nsITransferable');
                calls.push('transferable');
                return {
                    flavors: [],
                    init: init || (context => {
                        calls.push(['init', context]);
                    }),
                    addDataFlavor(flavor) {
                        calls.push(['addDataFlavor', flavor]);
                    },
                    setTransferData(flavor, supports, length) {
                        this.flavors.push({ flavor, supports, length });
                    },
                };
            },
        };
    }
    if (!missingSupports) {
        classes['@mozilla.org/supports-string;1'] = {
            createInstance(interfaceType) {
                assert.equal(interfaceType, 'nsISupportsString');
                calls.push('supports');
                return { data: '' };
            },
        };
    }
    return {
        components: {
            classes,
            interfaces: {
                nsIClipboardHelper: 'nsIClipboardHelper',
                nsIClipboard: 'nsIClipboard',
                nsITransferable: 'nsITransferable',
                nsISupportsString: 'nsISupportsString',
            },
        },
        calls,
        copied,
    };
}

test('writes text and HTML flavors through the transferable clipboard', async () => {
    const text = '公式\nA | B';
    const html = '<table><tr><td>公式</td></tr></table>';
    const { components, calls, copied } = richClipboardComponents();
    const clipboard = createZoteroClipboard(components);

    await clipboard.writeRich({ text, html });

    assert.deepEqual(copied, []);
    assert.deepEqual(calls, [
        'clipboard',
        'transferable',
        ['init', null],
        'supports',
        ['addDataFlavor', 'text/html'],
        'supports',
        ['addDataFlavor', 'text/plain'],
        [
            'setData',
            null,
            42,
            3,
            [
                {
                    flavor: 'text/html',
                    data: html,
                    length: html.length * 2,
                },
                {
                    flavor: 'text/plain',
                    data: text,
                    length: text.length * 2,
                },
            ],
        ],
    ]);
});

test('rejects rich clipboard content that is not text before writing', async () => {
    const { components, calls, copied } = richClipboardComponents();
    const clipboard = createZoteroClipboard(components);

    await assert.rejects(
        () => clipboard.writeRich({ text: '', html: '<p>x</p>' }),
        /clipboard/i
    );
    await assert.rejects(
        () => clipboard.writeRich({ text: '   ', html: '<p>x</p>' }),
        /clipboard/i
    );
    await assert.rejects(
        () => clipboard.writeRich({ text: null, html: '<p>x</p>' }),
        /clipboard/i
    );
    await assert.rejects(
        () => clipboard.writeRich({ text: 'Evidence', html: null }),
        /clipboard/i
    );
    await assert.rejects(
        () => clipboard.writeRich({ text: 'Evidence' }),
        /clipboard/i
    );
    assert.deepEqual(copied, []);
    assert.deepEqual(calls, []);
});

test('copies plain text when the HTML flavor is empty', async () => {
    const { components, calls, copied } = richClipboardComponents();
    const clipboard = createZoteroClipboard(components);

    await clipboard.writeRich({ text: 'Evidence', html: '   ' });

    assert.deepEqual(copied, ['Evidence']);
    assert.deepEqual(calls, ['helper']);
});

test('falls back to plain text when the rich clipboard is unavailable', async () => {
    const missingTransferable = richClipboardComponents({
        missingTransferable: true,
    });
    await createZoteroClipboard(missingTransferable.components)
        .writeRich({ text: 'Evidence', html: '<p>Evidence</p>' });
    assert.deepEqual(missingTransferable.copied, ['Evidence']);
    assert.equal(missingTransferable.calls.includes('setData'), false);

    const missingSupports = richClipboardComponents({ missingSupports: true });
    await createZoteroClipboard(missingSupports.components)
        .writeRich({ text: 'Evidence', html: '<p>Evidence</p>' });
    assert.deepEqual(missingSupports.copied, ['Evidence']);
    assert.equal(
        missingSupports.calls.some(call => Array.isArray(call)
            && call[0] === 'setData'),
        false
    );

    const unavailable = createZoteroClipboard({ classes: {}, interfaces: {} });
    await assert.rejects(
        () => unavailable.writeRich({
            text: 'Evidence',
            html: '<p>Evidence</p>',
        }),
        /clipboard/i
    );
});

test('falls back to plain text when a rich clipboard step throws', async () => {
    const throwingData = richClipboardComponents({
        setData() {
            throw new Error('NS_ERROR_FAILURE');
        },
    });
    await createZoteroClipboard(throwingData.components)
        .writeRich({ text: 'Evidence', html: '<p>Evidence</p>' });
    assert.deepEqual(throwingData.copied, ['Evidence']);

    const throwingInit = richClipboardComponents({
        init() {
            throw new Error('NS_ERROR_FAILURE');
        },
    });
    await createZoteroClipboard(throwingInit.components)
        .writeRich({ text: 'Still here', html: '<p>Still here</p>' });
    assert.deepEqual(throwingInit.copied, ['Still here']);
    assert.equal(
        throwingInit.calls.some(call => Array.isArray(call)
            && call[0] === 'setData'),
        false
    );
});
