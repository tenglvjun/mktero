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
