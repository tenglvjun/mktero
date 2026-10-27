import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createPDFPageLimitGuard,
    HOSTED_MINERU_MAX_PAGES,
    PDF_PAGE_LIMIT_ERROR_CODE,
    PDFPageLimitError,
} from '../src/core/pdf-page-limit.js';

test('the hosted MinerU limit is 200 pages', () => {
    assert.equal(HOSTED_MINERU_MAX_PAGES, 200);
});

test('lets a PDF at the page limit through', async () => {
    const fileData = new Uint8Array([1]);
    const calls = [];
    const guard = createPDFPageLimitGuard({
        countPages: async (value, options) => {
            calls.push([value, options]);
            return 200;
        },
    });
    const controller = new AbortController();

    await guard(fileData, { signal: controller.signal });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], fileData);
    assert.equal(calls[0][1].signal, controller.signal);
});

test('rejects a PDF over the page limit with its page count', async () => {
    const guard = createPDFPageLimitGuard({ countPages: async () => 201 });

    await assert.rejects(guard(new Uint8Array([1])), error => {
        assert.ok(error instanceof PDFPageLimitError);
        assert.equal(error.code, PDF_PAGE_LIMIT_ERROR_CODE);
        assert.equal(error.pages, 201);
        assert.equal(error.limit, 200);
        return true;
    });
});

test('honours a configured page limit', async () => {
    const guard = createPDFPageLimitGuard({ countPages: async () => 11, maxPages: 10 });

    await assert.rejects(guard(new Uint8Array([1])), { code: PDF_PAGE_LIMIT_ERROR_CODE, limit: 10 });
});

test('lets a PDF through when its page count cannot be read', async () => {
    const reported = [];
    const failure = new Error('No password given');
    failure.name = 'PasswordException';
    const guard = createPDFPageLimitGuard({
        countPages: async () => { throw failure; },
        onError: error => reported.push(error),
    });

    await guard(new Uint8Array([1]));

    assert.deepEqual(reported, [failure]);
});

test('a failing error reporter does not stop the PDF', async () => {
    const guard = createPDFPageLimitGuard({
        countPages: async () => { throw new Error('broken xref'); },
        onError: () => { throw new Error('reporter failed'); },
    });

    await guard(new Uint8Array([1]));
});

test('ignores a page count that is not a whole number', async () => {
    for (const pages of [Number.NaN, 250.5, '500', null, undefined]) {
        const guard = createPDFPageLimitGuard({ countPages: async () => pages });
        await guard(new Uint8Array([1]));
    }
});

test('passes cancellation through instead of letting the PDF through', async () => {
    const controller = new AbortController();
    const reported = [];
    const guard = createPDFPageLimitGuard({
        countPages: async () => {
            controller.abort();
            throw new Error('loading task destroyed');
        },
        onError: error => reported.push(error),
    });

    await assert.rejects(guard(new Uint8Array([1]), { signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(reported, []);
});

test('does not count pages for an already cancelled conversion', async () => {
    const controller = new AbortController();
    controller.abort();
    let counted = false;
    const guard = createPDFPageLimitGuard({
        countPages: async () => {
            counted = true;
            return 1;
        },
    });

    await assert.rejects(guard(new Uint8Array([1]), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(counted, false);
});

test('requires a page counter and a positive limit', () => {
    assert.throws(() => createPDFPageLimitGuard({}), TypeError);
    assert.throws(() => createPDFPageLimitGuard({ countPages: async () => 1, maxPages: 0 }), TypeError);
});
