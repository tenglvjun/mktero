import { redactDiagnosticText } from './redact-diagnostics.js';

export const DIAGNOSTIC_REPORT_VERSION = 1;
export const DIAGNOSTIC_NOTE_LIMIT = 4000;

const PROVIDERS = new Set(['mktero', 'mineru', 'mistral']);
const ENDPOINTS = new Set(['cloud', 'local']);

// buildDiagnosticReport copies only the fields a maintainer needs. Callers
// cannot add tokens or paths by passing extra environment properties.
export function buildDiagnosticReport({
    environment = {},
    logEntries = [],
    jobs = [],
    note = '',
    expected = '',
    generatedAt,
} = {}) {
    const report = {
        schemaVersion: DIAGNOSTIC_REPORT_VERSION,
        generatedAt: normalizeTime(generatedAt),
        plugin: {
            version: clean(environment.pluginVersion, 32),
            build: clean(environment.build, 16),
        },
        zotero: {
            version: clean(environment.zoteroVersion, 32),
            locale: clean(environment.locale, 32),
        },
        os: {
            name: clean(environment.osName, 32),
            version: clean(environment.osVersion, 64),
            arch: clean(environment.arch, 32),
        },
        conversion: normalizeConversion(environment.conversion),
        account: normalizeAccount(environment.account),
        jobs: normalizeJobs(jobs),
        log: normalizeLog(logEntries),
        note: clip(redactDiagnosticText(note), DIAGNOSTIC_NOTE_LIMIT),
    };
    const expectedText = clip(redactDiagnosticText(expected), DIAGNOSTIC_NOTE_LIMIT);
    if (expectedText) report.expected = expectedText;
    const context = normalizeContext(environment.context);
    if (context) report.context = context;
    return report;
}

export function serializeDiagnosticReport(report) {
    return `${JSON.stringify(report, null, 2)}\n`;
}

export function diagnosticReportFileName(generatedAt) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(
        String(generatedAt || '')
    );
    const stamp = match
        ? `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`
        : 'report';
    return `mktero-diagnostics-${stamp}.json`;
}

function normalizeConversion(conversion) {
    const provider = PROVIDERS.has(conversion?.provider)
        ? conversion.provider
        : 'unknown';
    const parser = conversion?.parser || {};
    const result = {
        provider,
        credentialsConfigured: {
            mineruCloud: conversion?.credentialsConfigured?.mineruCloud === true,
            mineruLocal: conversion?.credentialsConfigured?.mineruLocal === true,
            mistral: conversion?.credentialsConfigured?.mistral === true,
            ai: conversion?.credentialsConfigured?.ai === true,
        },
        parser: {
            figurePipeline: clean(parser.figurePipeline, 64),
            documentPipeline: clean(parser.documentPipeline, 64),
        },
    };
    const profileSha256 = clean(parser.profileSha256, 12);
    if (/^[a-f0-9]{12}$/.test(profileSha256)) {
        result.parser.profileSha256 = profileSha256;
    }
    if (provider === 'mineru' && ENDPOINTS.has(conversion?.mineruEndpoint)) {
        result.mineruEndpoint = conversion.mineruEndpoint;
    }
    const origin = clean(conversion?.localEndpointOrigin, 200);
    if (origin && /^https?:\/\/[^/?#\s]+$/.test(origin)) {
        result.localEndpointOrigin = redactDiagnosticText(origin);
    }
    return result;
}

function normalizeAccount(account) {
    const result = { signedIn: account?.signedIn === true };
    const email = typeof account?.email === 'string' ? account.email.trim() : '';
    if (email && email.length <= 254 && !/[\s/\\]/.test(email)) {
        result.email = email;
    }
    return result;
}

function normalizeContext(context) {
    const itemID = Number(context?.itemID);
    if (!Number.isSafeInteger(itemID) || itemID <= 0) return null;
    const result = { itemID };
    const libraryID = Number(context?.libraryID);
    if (Number.isSafeInteger(libraryID) && libraryID >= 0) {
        result.libraryID = libraryID;
    }
    const itemKey = clean(context?.itemKey, 32);
    if (/^[A-Za-z0-9]+$/.test(itemKey)) result.itemKey = itemKey;
    return result;
}

function normalizeJobs(jobs) {
    if (!Array.isArray(jobs)) return [];
    return jobs.slice(-20).flatMap(job => {
        const provider = String(job?.provider || '');
        const id = String(job?.id || '');
        if (!['mktero', 'mineru', 'mineru-local'].includes(provider)) return [];
        if (!id || id.length > 128 || redactDiagnosticText(id) !== id) return [];
        return [{
            provider,
            id,
            status: clean(job.status, 32) || 'unknown',
            at: normalizeTime(job.at),
        }];
    });
}

function normalizeLog(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.slice(-200).flatMap(entry => {
        const message = clip(redactDiagnosticText(entry?.message), 2000);
        if (!message) return [];
        return [{
            level: entry?.level === 'error' ? 'error' : 'debug',
            message,
            at: normalizeTime(entry?.at),
        }];
    });
}

function clean(value, limit) {
    const text = String(value || '').trim();
    if (!text || /[\r\n\0]/.test(text)) return '';
    return text.slice(0, limit);
}

function clip(value, limit) {
    const text = String(value || '').trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 1)}…`;
}

function normalizeTime(value) {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)
        ? text
        : new Date(0).toISOString();
}
