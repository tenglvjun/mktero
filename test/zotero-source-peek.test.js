import test from 'node:test';
import assert from 'node:assert/strict';
import {
    captureReaderPageCrop,
    createZoteroSourcePeekRenderer,
} from '../src/platform/zotero-source-peek.js';

function createCanvas(width, height) {
    const draws = [];
    return {
        width: width || 0,
        height: height || 0,
        draws,
        getContext() {
            return {
                drawImage(
                    source,
                    sx,
                    sy,
                    sw,
                    sh
                ) {
                    draws.push({ source, sx, sy, sw, sh });
                },
            };
        },
        toDataURL() {
            return `data:image/jpeg;base64,${this.width}x${this.height}`;
        },
    };
}

test('thumbnails an already rendered Zotero PDF page canvas', () => {
    const pageCanvas = createCanvas(400, 600);
    const zotero = {
        Reader: {
            _readers: [{
                itemID: 42,
                type: 'pdf',
                _internalReader: {
                    _primaryView: {
                        _iframeWindow: {
                            document: { createElement() { return createCanvas(); } },
                            PDFViewerApplication: {
                                pdfViewer: {
                                    getPageView(pageIndex) {
                                        assert.equal(pageIndex, 1);
                                        return { canvas: pageCanvas };
                                    },
                                },
                            },
                        },
                    },
                },
            }],
        },
    };

    const result = captureReaderPageCrop(
        zotero,
        42,
        { pageIndex: 1, bbox: [250, 250, 750, 750] },
        createCanvas
    );

    assert.equal(result.pageIndex, 1);
    assert.match(result.dataURL, /^data:image\/jpeg;base64,/);
});

test('falls back to the PDF.js crop renderer when no page canvas exists', async () => {
    const calls = [];
    const renderer = createZoteroSourcePeekRenderer({
        zotero: { Reader: { _readers: [] } },
        cropRenderer: {
            async render(itemID, location, options) {
                calls.push({ itemID, location, options });
                return { dataURL: 'data:image/jpeg;base64,ZmFsbGJhY2s=', pageIndex: 0 };
            },
        },
    });
    const location = { pageIndex: 0, bbox: [100, 100, 200, 200] };
    const result = await renderer.render(7, location, {
        createCanvas,
    });

    assert.equal(result.dataURL, 'data:image/jpeg;base64,ZmFsbGJhY2s=');
    assert.equal(calls[0].itemID, 7);
    assert.equal(calls[0].location, location);
});
