import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import {
    getMkteroAccount,
    getMkteroConversionStats,
    loginMkteroAccount,
    logoutMkteroAccount,
    refreshMkteroAccount,
    registerMkteroAccount,
    reportMkteroClientVersion,
    requestPasswordReset,
    sendSignupCode,
    updateMkteroNickname,
} from '../src/account/account-client.js';
import { MkteroConversionClient } from '../src/mktero/mktero-conversion-client.js';
import { mkteroVersion } from '../src/config/runtime-config.js';

// The extension reports its own build to mktero-server on the account API so
// the operator can see which builds are still in the field. Two properties are
// locked here: every Mktero API request carries the header, and no request to a
// third party does.

const API_BASE = 'http://127.0.0.1:8080';
const VERSION_HEADER = 'X-Mktero-Version';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        async json() {
            return body;
        },
        async arrayBuffer() {
            return strToU8(JSON.stringify(body)).buffer;
        },
    };
}

function archiveResponse(bytes) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async arrayBuffer() {
            return bytes.slice().buffer;
        },
    };
}

function createTestPNG() {
    return new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
    ]);
}

function resultArchive() {
    return zipSync({
        'result/full.md': strToU8('# Converted\n\nBody text.'),
        'result/images/figure.png': createTestPNG(),
    });
}

// headerRecorder captures the headers of every request and answers with a
// queued response, so one helper serves all the account-client calls.
function headerRecorder(response) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return response;
    };
    return { calls, fetchImpl };
}

test('mkteroVersion reports a build identifier and falls back when unbundled', () => {
    const version = mkteroVersion();
    assert.equal(typeof version, 'string');
    assert.ok(version.length > 0, 'the reported version must not be empty');
    assert.ok(version.length <= 32, 'the reported version must fit the server column');
    // esbuild injects __MKTERO_VERSION__ from manifest.json. Source imported
    // directly by the tests is not bundled, so it reports the debug fallback
    // rather than throwing on an undeclared global.
    assert.equal(version, 'dev');
});

test('every Mktero account request reports the extension version', async () => {
    const sessionResponse = jsonResponse(200, {
        user: { email: 'user@example.com', nickname: 'reader' },
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
    });
    const cases = [
        ['sendSignupCode', fetchImpl => sendSignupCode({
            apiBase: API_BASE,
            email: 'user@example.com',
            fetchImpl,
        })],
        ['registerMkteroAccount', fetchImpl => registerMkteroAccount({
            apiBase: API_BASE,
            email: 'user@example.com',
            password: 'password123',
            code: '123456',
            fetchImpl,
        })],
        ['loginMkteroAccount', fetchImpl => loginMkteroAccount({
            apiBase: API_BASE,
            email: 'user@example.com',
            password: 'password123',
            fetchImpl,
        })],
        ['refreshMkteroAccount', fetchImpl => refreshMkteroAccount({
            apiBase: API_BASE,
            refreshToken: 'refresh',
            fetchImpl,
        })],
        ['requestPasswordReset', fetchImpl => requestPasswordReset({
            apiBase: API_BASE,
            email: 'user@example.com',
            fetchImpl,
        })],
        ['logoutMkteroAccount', fetchImpl => logoutMkteroAccount({
            apiBase: API_BASE,
            refreshToken: 'refresh',
            fetchImpl,
        })],
        ['getMkteroAccount', fetchImpl => getMkteroAccount({
            apiBase: API_BASE,
            accessToken: 'access',
            fetchImpl,
        })],
        ['getMkteroConversionStats', fetchImpl => getMkteroConversionStats({
            apiBase: API_BASE,
            accessToken: 'access',
            fetchImpl,
        })],
        ['updateMkteroNickname', fetchImpl => updateMkteroNickname({
            apiBase: API_BASE,
            accessToken: 'access',
            nickname: 'reader',
            fetchImpl,
        })],
    ];

    for (const [name, call] of cases) {
        const { calls, fetchImpl } = headerRecorder(sessionResponse);
        await call(fetchImpl);
        assert.ok(calls.length >= 1, `${name} issued no request`);
        for (const recorded of calls) {
            assert.ok(
                recorded.url.startsWith(API_BASE),
                `${name} called ${recorded.url}, which is not the Mktero API`
            );
            assert.equal(
                recorded.options.headers[VERSION_HEADER],
                mkteroVersion(),
                `${name} did not report the extension version`
            );
        }
    }
});

test('the account client reports a version heartbeat with the access token', async () => {
    const { calls, fetchImpl } = headerRecorder(jsonResponse(204, null));
    await reportMkteroClientVersion({
        apiBase: API_BASE,
        accessToken: 'access',
        fetchImpl,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${API_BASE}/api/v1/me/client-version`);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers[VERSION_HEADER], mkteroVersion());
    assert.equal(calls[0].options.headers.Authorization, 'Bearer access');
    assert.equal(calls[0].options.body, '{}');
});

// The account client has no third-party code path, so an assertion that the
// header is present everywhere is also the assertion that it is nowhere else.
test('the account client sends no other custom header', async () => {
    const { calls, fetchImpl } = headerRecorder(jsonResponse(200, { nickname: 'reader' }));
    await updateMkteroNickname({
        apiBase: API_BASE,
        accessToken: 'access',
        nickname: 'reader',
        fetchImpl,
    });
    assert.deepEqual(Object.keys(calls[0].options.headers).sort(), [
        'Accept',
        'Authorization',
        'Content-Type',
        VERSION_HEADER,
    ].sort());
});

// This is the regression that would take the product down: the PDF upload and
// the result download go to presigned R2 URLs, where a header the signature
// does not cover invalidates the request and provokes a preflight the bucket
// does not answer. The header belongs to the Mktero API calls only.
test('conversion reports the version to the API but never to object storage', async () => {
    const requests = [];
    const responses = [
        jsonResponse(201, {
            job_id: 'job-1',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
            upload_method: 'PUT',
        }),
        { ok: true, status: 200, headers: { get: () => null } },
        jsonResponse(202, { job_id: 'job-1', status: 'queued' }),
        jsonResponse(200, { job_id: 'job-1', status: 'succeeded', progress: 100 }),
        jsonResponse(200, {
            result_url: 'https://r2.example/result.zip',
            method: 'GET',
        }),
        archiveResponse(resultArchive()),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
    });

    await client.convert({
        apiBase: API_BASE,
        getAccessToken: () => 'access-token',
        fileName: 'paper.pdf',
        fileData: PDF_BYTES,
    });

    const apiCalls = requests.filter(item => item.url.startsWith(API_BASE));
    const storageCalls = requests.filter(item => !item.url.startsWith(API_BASE));
    assert.ok(apiCalls.length >= 3, `expected API calls, saw ${requests.length}`);
    assert.equal(storageCalls.length, 2, 'expected the presigned upload and download');

    for (const call of apiCalls) {
        assert.equal(
            call.options.headers[VERSION_HEADER],
            mkteroVersion(),
            `${call.url} did not report the extension version`
        );
        assert.equal(call.options.headers.Authorization, 'Bearer access-token');
    }
    for (const call of storageCalls) {
        assert.equal(
            call.options.headers[VERSION_HEADER],
            undefined,
            `${call.url} is a presigned object-storage URL and must not carry the version header`
        );
        assert.equal(
            call.options.headers.Authorization,
            undefined,
            `${call.url} must not carry a bearer token either`
        );
    }
});
