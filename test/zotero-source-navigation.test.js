import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroSourceNavigation,
    normalizedBBoxToPDFRect,
} from '../src/platform/zotero-source-navigation.js';

test('converts MinerU coordinates through a cropped PDF.js viewport', () => {
    const viewport = {
        width: 600,
        height: 800,
        convertToPdfPoint(x, y) {
            return [10 + x, 820 - y];
        },
    };

    assert.deepEqual(
        normalizedBBoxToPDFRect([100, 200, 900, 300], viewport),
        [70, 580, 550, 660]
    );
});

test('converts MinerU coordinates through a rotated PDF.js viewport', () => {
    const viewport = {
        width: 800,
        height: 600,
        convertToPdfPoint(x, y) {
            return [20 + y, 30 + x];
        },
    };

    assert.deepEqual(
        normalizedBBoxToPDFRect([100, 200, 900, 300], viewport),
        [140, 110, 200, 750]
    );
});

test('rejects malformed source coordinates and PDF.js viewport geometry', () => {
    const viewport = {
        width: 600,
        height: 800,
        convertToPdfPoint: () => [Number.NaN, 0],
    };

    assert.throws(
        () => normalizedBBoxToPDFRect([100, 100, 1001, 200], viewport),
        /geometry/i
    );
    assert.throws(
        () => normalizedBBoxToPDFRect([100, 100, 200, 200], viewport),
        /geometry/i
    );
});

test('opens the Zotero PDF and navigates to the mapped source rectangle', async () => {
    const calls = [];
    const viewport = {
        width: 600,
        height: 800,
        convertToPdfPoint: (x, y) => [10 + x, 820 - y],
    };
    const reader = {
        itemID: 42,
        _initPromise: Promise.resolve(),
        _internalReader: {
            _primaryView: {
                initializedPromise: Promise.resolve(),
                _iframeWindow: {
                    PDFViewerApplication: {
                        pdfViewer: {
                            getPageView(pageIndex) {
                                assert.equal(pageIndex, 2);
                                return { viewport };
                            },
                        },
                    },
                },
            },
        },
        async navigate(location) {
            calls.push({ navigated: location });
        },
    };
    const zotero = {
        Items: {
            get: itemID => itemID === 42
                ? { isPDFAttachment: () => true }
                : null,
        },
        Reader: {
            _readers: [],
            async open(itemID) {
                calls.push({ opened: itemID });
                this._readers.push(reader);
                return reader;
            },
        },
    };
    const navigation = createZoteroSourceNavigation(zotero);

    await navigation.open(42, {
        pageIndex: 2,
        bbox: [100, 200, 900, 300],
    });

    assert.deepEqual(calls, [
        { opened: 42 },
        {
            navigated: {
                position: {
                    pageIndex: 2,
                    rects: [[70, 580, 550, 660]],
                },
            },
        },
    ]);
});

test('finds a reader registered after Zotero selects an unloaded PDF tab', async () => {
    const readers = [];
    let delayCalls = 0;
    let navigated;
    const viewport = {
        width: 1000,
        height: 1000,
        convertToPdfPoint: (x, y) => [x, 1000 - y],
    };
    const reader = {
        itemID: 42,
        _initPromise: Promise.resolve(),
        _internalReader: {
            _primaryView: {
                initializedPromise: Promise.resolve(),
                _iframeWindow: {
                    PDFViewerApplication: {
                        pdfViewer: {
                            getPageView: () => ({ viewport }),
                        },
                    },
                },
            },
        },
        navigate: async location => { navigated = location; },
    };
    const zotero = {
        Items: { get: () => ({ isPDFAttachment: () => true }) },
        Reader: {
            _readers: readers,
            open: async () => undefined,
        },
    };
    const navigation = createZoteroSourceNavigation(zotero, {
        now: () => delayCalls * 25,
        async delay() {
            delayCalls++;
            readers.push(reader);
        },
        initializationTimeout: 1000,
    });

    await navigation.open(42, {
        pageIndex: 0,
        bbox: [100, 100, 200, 200],
    });

    assert.equal(delayCalls, 1);
    assert.deepEqual(navigated.position, {
        pageIndex: 0,
        rects: [[100, 800, 200, 900]],
    });
});

test('selects the reader for the requested attachment when several are open', async () => {
    let selectedReaderNavigated = false;
    let otherReaderNavigated = false;
    const createReader = (itemID, onNavigate) => ({
        itemID,
        _initPromise: Promise.resolve(),
        _internalReader: {
            _primaryView: {
                initializedPromise: Promise.resolve(),
                _iframeWindow: {
                    PDFViewerApplication: {
                        pdfViewer: {
                            getPageView: () => ({
                                viewport: {
                                    width: 1000,
                                    height: 1000,
                                    convertToPdfPoint: (x, y) => [x, 1000 - y],
                                },
                            }),
                        },
                    },
                },
            },
        },
        navigate: async () => { onNavigate(); },
    });
    const zotero = {
        Items: { get: () => ({ isPDFAttachment: () => true }) },
        Reader: {
            _readers: [
                createReader(7, () => { otherReaderNavigated = true; }),
                createReader(42, () => { selectedReaderNavigated = true; }),
            ],
            open: async () => undefined,
        },
    };

    await createZoteroSourceNavigation(zotero).open(42, {
        pageIndex: 0,
        bbox: [100, 100, 200, 200],
    });

    assert.equal(selectedReaderNavigated, true);
    assert.equal(otherReaderNavigated, false);
});

test('times out without navigating when the Zotero reader never initializes', async () => {
    let ticks = 0;
    const zotero = {
        Items: { get: () => ({ isPDFAttachment: () => true }) },
        Reader: {
            _readers: [],
            open: async () => undefined,
        },
    };
    const navigation = createZoteroSourceNavigation(zotero, {
        now: () => ticks * 25,
        delay: async () => { ticks++; },
        initializationTimeout: 1000,
    });

    await assert.rejects(() => navigation.open(42, {
        pageIndex: 0,
        bbox: [100, 100, 200, 200],
    }), /timed out/i);
    assert.ok(ticks >= 40);
});
