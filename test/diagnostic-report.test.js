import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildDiagnosticReport,
    diagnosticReportFileName,
    serializeDiagnosticReport,
} from '../src/diagnostics/diagnostic-report.js';
import { readDiagnosticEnvironment } from '../src/platform/zotero-diagnostic-snapshot.js';

test('builds a redacted report and omits secrets that were not requested', () => {
    const report = buildDiagnosticReport({
        generatedAt: '2026-10-26T15:30:45.000Z',
        environment: {
            pluginVersion: '0.6.11',
            build: 'release',
            zoteroVersion: '8.0.1',
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
        },
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
        expected: 'Markdown should open',
    });
    const text = serializeDiagnosticReport(report);

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.plugin.version, '0.6.11');
    assert.equal(report.conversion.mineruEndpoint, 'local');
    assert.equal(report.conversion.localEndpointOrigin.includes('user:pass'), false);
    assert.equal(report.account.email, 'reader@example.com');
    assert.equal(report.context.itemKey, 'ABCD2345');
    assert.equal(report.context.title, undefined);
    assert.equal(text.includes('must-not-leak'), false);
    assert.equal(text.includes('Secret title'), false);
    assert.equal(text.includes('session-token'), false);
    assert.equal(text.includes('/Users/ada'), false);
    assert.equal(text.includes('abcd1234'), false);
    assert.equal(text.includes('reader@example.com'), true);
    assert.equal(
        diagnosticReportFileName(report.generatedAt),
        'mktero-diagnostics-20261026-153045.json'
    );
});

test('reads a Zotero environment without copying credentials', async () => {
    const prefs = new Map([
        ['extensions.mktero.conversionProvider', 'mktero'],
        ['extensions.mktero.mineruApiKey', 'mineru-secret'],
        ['extensions.mktero.accountEmail', 'reader@example.com'],
        ['extensions.mktero.accountRefreshToken', 'refresh-secret'],
        ['extensions.mktero.aiApiKey', 'ai-secret'],
    ]);
    const environment = await readDiagnosticEnvironment({
        zotero: {
            version: '8.0',
            locale: 'en-US',
            Prefs: { get: key => prefs.get(key) },
            Items: { get: () => ({ libraryID: 2, key: 'ITEMKEY1', getField: () => 'Title' }) },
        },
        services: { appinfo: { OS: 'Darwin', macOSVersion: '15.6', XPCOMABI: 'arm64-gcc3' } },
        context: { itemID: 7 },
        includeAccountEmail: false,
        hash: async () => 'abcdef1234567890',
        pluginVersion: '0.6.11',
        build: 'debug',
    });
    const text = JSON.stringify(environment);

    assert.equal(environment.conversion.provider, 'mktero');
    assert.equal(environment.conversion.credentialsConfigured.mineruCloud, true);
    assert.equal(environment.conversion.credentialsConfigured.ai, true);
    assert.equal(environment.account.signedIn, true);
    assert.equal(environment.account.email, undefined);
    assert.deepEqual(environment.context, {
        itemID: 7,
        libraryID: 2,
        itemKey: 'ITEMKEY1',
    });
    assert.equal(environment.conversion.parser.profileSha256, 'abcdef123456');
    assert.equal(text.includes('mineru-secret'), false);
    assert.equal(text.includes('refresh-secret'), false);
    assert.equal(text.includes('ai-secret'), false);
    assert.equal(text.includes('Title'), false);
});
