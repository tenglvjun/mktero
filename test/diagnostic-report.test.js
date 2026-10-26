import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDiagnosticReport,
    diagnosticReportFileName,
    serializeDiagnosticReport,
    summarizeDiagnosticReport,
} from '../src/diagnostics/diagnostic-report.js';
import { translateEnglish } from '../src/i18n/localization.js';
import { readDiagnosticEnvironment } from '../src/platform/zotero-diagnostic-snapshot.js';

function environment(overrides = {}) {
    return {
        pluginVersion: '0.6.11',
        build: 'release',
        zoteroVersion: '10.0.6',
        locale: 'zh-CN',
        osName: 'Darwin',
        osVersion: '15.6.0',
        arch: 'arm64-gcc3',
        conversion: {
            provider: 'mineru',
            mineruEndpoint: 'local',
            localEndpointOrigin: 'http://user:pass@127.0.0.1:8000',
            credentialsConfigured: {
                mineruCloud: true,
                mineruLocal: false,
                mistral: false,
                ai: true,
            },
            parser: {
                figurePipeline: 'figure-region-v17',
                documentPipeline: 'mineru-document-ir-v8',
                profileSha256: '0123456789ab',
            },
        },
        account: { signedIn: true, email: 'reader@example.com' },
        context: { itemID: 42, libraryID: 1, itemKey: 'ABCD2345', title: 'Secret title' },
        accessToken: 'must-not-leak',
        ...overrides,
    };
}

test('builds a redacted report that never includes the account email', () => {
    const report = buildDiagnosticReport({
        generatedAt: '2026-10-26T15:30:45.000Z',
        source: 'error-card',
        failure: { code: 'MKTERO_CONVERSION_FAILED', serviceCode: 'MINERU_TASK_FAILED' },
        environment: environment(),
        logEntries: [{
            level: 'error',
            message: 'Bearer session-token /Users/ada/paper.pdf',
            at: '2026-10-26T15:30:40.000Z',
        }],
        jobs: [{
            provider: 'mktero',
            id: 'job-1',
            status: 'failed',
            at: '2026-10-26T15:30:41.000Z',
        }],
        note: 'Failed after upload. Contact reader@example.com. apiKey=abcd1234',
    });
    const text = serializeDiagnosticReport(report);

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.source, 'error-card');
    assert.deepEqual(report.failure, {
        code: 'MKTERO_CONVERSION_FAILED',
        serviceCode: 'MINERU_TASK_FAILED',
    });
    assert.deepEqual(report.account, { signedIn: true });
    assert.equal(report.conversion.mineruEndpoint, 'local');
    assert.equal(report.conversion.localEndpointOrigin.includes('user:pass'), false);
    assert.equal(report.context.itemKey, 'ABCD2345');
    assert.equal(report.context.title, undefined);
    assert.equal(report.expected, undefined);
    for (const secret of [
        'must-not-leak', 'Secret title', 'session-token', '/Users/ada',
        'abcd1234', 'reader@example.com',
    ]) {
        assert.equal(text.includes(secret), false, secret);
    }
    assert.equal(
        diagnosticReportFileName(report.generatedAt),
        'mktero-diagnostics-20261026-153045.json'
    );
});

test('drops an unknown source and a malformed failure code', () => {
    const report = buildDiagnosticReport({
        source: 'toolbar',
        failure: { code: 'not a code\nwith lines', serviceCode: 'MINERU_TASK_FAILED' },
        environment: environment({ context: null }),
    });

    assert.equal(report.source, 'help-menu');
    assert.equal(report.failure, undefined);
    assert.equal(report.context, undefined);
});

test('summarizes the report in readable lines', () => {
    const report = buildDiagnosticReport({
        failure: { code: 'MKTERO_CONVERSION_FAILED', serviceCode: 'MINERU_TASK_FAILED' },
        environment: environment({
            conversion: { provider: 'mktero' },
        }),
        jobs: [{ provider: 'mktero', id: 'job-1', status: 'failed' }],
        logEntries: [
            { level: 'debug', message: 'Mktero: started' },
            { level: 'error', message: 'The Mktero conversion failed' },
        ],
    });
    const summary = summarizeDiagnosticReport(report, translateEnglish);

    assert.deepEqual(summary, [
        { label: 'Versions', value: 'Mktero 0.6.11 · Zotero 10.0.6 · macOS 15.6.0' },
        { label: 'Converter', value: 'Mktero hosted' },
        { label: 'Paper', value: 'ABCD2345' },
        { label: 'Error', value: 'MKTERO_CONVERSION_FAILED · MINERU_TASK_FAILED' },
        {
            label: 'Recent activity',
            value: 'Conversion jobs: 1 · Log lines: 2 · Errors: 1',
        },
    ]);
    const empty = summarizeDiagnosticReport(
        buildDiagnosticReport({ environment: environment({ context: null }) }),
        translateEnglish
    );
    assert.equal(empty.find(line => line.label === 'Paper').value, 'None selected');
    assert.equal(empty.some(line => line.label === 'Error'), false);
});

test('reads a Zotero environment without copying credentials or the email', async () => {
    const prefs = new Map([
        ['extensions.mktero.conversionProvider', 'mktero'],
        ['extensions.mktero.mineruApiKey', 'mineru-secret'],
        ['extensions.mktero.accountEmail', 'reader@example.com'],
        ['extensions.mktero.accountRefreshToken', 'refresh-secret'],
        ['extensions.mktero.aiApiKey', 'ai-secret'],
    ]);
    const read = await readDiagnosticEnvironment({
        zotero: {
            version: '8.0',
            locale: 'en-US',
            Prefs: { get: key => prefs.get(key) },
            Items: { get: () => ({ libraryID: 2, key: 'ITEMKEY1', getField: () => 'Title' }) },
        },
        services: { appinfo: { OS: 'Darwin', macOSVersion: '15.6', XPCOMABI: 'arm64-gcc3' } },
        context: { itemID: 7 },
        hash: async () => 'abcdef1234567890',
        pluginVersion: '0.6.11',
        build: 'debug',
    });
    const text = JSON.stringify(read);

    assert.equal(read.conversion.provider, 'mktero');
    assert.equal(read.conversion.credentialsConfigured.mineruCloud, true);
    assert.equal(read.conversion.credentialsConfigured.ai, true);
    assert.deepEqual(read.account, { signedIn: true });
    assert.deepEqual(read.context, {
        itemID: 7,
        libraryID: 2,
        itemKey: 'ITEMKEY1',
    });
    assert.equal(read.conversion.parser.profileSha256, 'abcdef123456');
    for (const secret of ['mineru-secret', 'refresh-secret', 'ai-secret', 'reader@example.com', 'Title']) {
        assert.equal(text.includes(secret), false, secret);
    }
});
