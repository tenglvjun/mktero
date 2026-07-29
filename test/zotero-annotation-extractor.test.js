import test from 'node:test';
import assert from 'node:assert/strict';
import { ZoteroAnnotationExtractor } from '../src/extractors/zotero-annotation-extractor.js';

function extractorForAnnotations(annotations) {
    const attachment = {
        isPDFAttachment: () => true,
        getAnnotations: () => annotations,
    };
    return new ZoteroAnnotationExtractor({
        Items: {
            getAsync: async () => attachment,
            loadDataTypes: async () => {},
        },
    });
}

test('reads supported PDF text annotations in document order', async () => {
    let childItemsLoaded = false;
    let annotationDataLoaded = false;
    const annotations = [
        {
            id: 103,
            key: 'NOTE0001',
            annotationType: 'note',
            annotationSortIndex: '00003',
        },
        {
            id: 102,
            key: 'UNDER001',
            annotationType: 'underline',
            annotationText: 'underlined text',
            annotationComment: '',
            annotationColor: '#2EA8E5',
            annotationPageLabel: '8',
            annotationSortIndex: '00002',
            annotationPosition: JSON.stringify({ pageIndex: 7, rects: [] }),
        },
        {
            id: 101,
            key: 'HIGH0001',
            annotationType: 'highlight',
            annotationText: 'important result',
            annotationComment: 'Review this argument',
            annotationColor: '#FFD400',
            annotationPageLabel: '7',
            annotationSortIndex: '00001',
            annotationPosition: JSON.stringify({ pageIndex: 6, rects: [] }),
        },
    ];
    const attachment = {
        isPDFAttachment: () => true,
        getAnnotations(includeTrashed) {
            assert.equal(childItemsLoaded, true);
            assert.equal(includeTrashed, false);
            return annotations;
        },
    };
    const zotero = {
        Items: {
            getAsync: async id => id === 42 ? attachment : null,
            async loadDataTypes(items, dataTypes) {
                if (items[0] === attachment) {
                    assert.deepEqual(dataTypes, ['childItems']);
                    childItemsLoaded = true;
                    return;
                }
                assert.deepEqual(items, annotations);
                assert.deepEqual(dataTypes, ['annotation', 'annotationDeferred']);
                annotationDataLoaded = true;
            },
        },
    };

    const result = await new ZoteroAnnotationExtractor(zotero).extract(42);

    assert.equal(annotationDataLoaded, true);
    assert.deepEqual(result, [
        {
            id: 'HIGH0001',
            type: 'highlight',
            text: 'important result',
            comment: 'Review this argument',
            color: '#ffd400',
            pageLabel: '7',
            pageIndex: 6,
            sortIndex: '00001',
        },
        {
            id: 'UNDER001',
            type: 'underline',
            text: 'underlined text',
            comment: '',
            color: '#2ea8e5',
            pageLabel: '8',
            pageIndex: 7,
            sortIndex: '00002',
        },
    ]);
});

test('rejects annotation text that exceeds the local safety budget', async () => {
    const annotation = {
        id: 101,
        key: 'HIGH0001',
        annotationType: 'highlight',
        annotationText: 'x'.repeat(100_001),
        annotationComment: '',
        annotationColor: '#ffd400',
        annotationPageLabel: '1',
        annotationSortIndex: '00001',
        annotationPosition: JSON.stringify({ pageIndex: 0 }),
    };
    const attachment = {
        isPDFAttachment: () => true,
        getAnnotations: () => [annotation],
    };
    const zotero = {
        Items: {
            getAsync: async () => attachment,
            loadDataTypes: async () => {},
        },
    };

    await assert.rejects(
        () => new ZoteroAnnotationExtractor(zotero).extract(42),
        /annotation text exceeds the local safety limit/i
    );
});

test('rejects a PDF whose text annotation count exceeds the safety budget', async () => {
    const annotations = Array.from({ length: 5_001 }, (_, index) => ({
        id: index + 1,
        annotationType: 'highlight',
    }));

    await assert.rejects(
        () => extractorForAnnotations(annotations).extract(42),
        /annotation count exceeds the local safety limit/i
    );
});

test('rejects aggregate annotation text above the safety budget', async () => {
    const annotations = Array.from({ length: 21 }, (_, index) => ({
        id: index + 1,
        annotationType: 'highlight',
        annotationText: 'x'.repeat(100_000),
        annotationComment: '',
        annotationColor: '#ffd400',
        annotationPageLabel: '1',
        annotationSortIndex: String(index).padStart(5, '0'),
        annotationPosition: JSON.stringify({ pageIndex: 0 }),
    }));

    await assert.rejects(
        () => extractorForAnnotations(annotations).extract(42),
        /annotation text exceeds the local safety limit/i
    );
});

test('replaces an untrusted Zotero annotation color with the safe default', async () => {
    const result = await extractorForAnnotations([{
        id: 101,
        key: 'HIGH0003',
        annotationType: 'highlight',
        annotationText: 'Visible',
        annotationComment: '',
        annotationColor: '#fff; background: red',
        annotationPageLabel: '1',
        annotationSortIndex: '00001',
        annotationPosition: JSON.stringify({ pageIndex: 0 }),
    }]).extract(42);

    assert.equal(result[0].color, '#ffd400');
});
