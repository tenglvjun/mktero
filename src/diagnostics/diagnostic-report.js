import { redactDiagnosticText } from './redact-diagnostics.js';

export const DIAGNOSTIC_REPORT_VERSION = 1;
export const DIAGNOSTIC_NOTE_LIMIT = 4000;

// Where the report was opened. The error card and the document menu know
// the paper; the Help menu reads the current selection.
export const DIAGNOSTIC_SOURCES = Object.freeze({
    ERROR_CARD: 'error-card',
    DOCUMENT_MENU: 'document-menu',
    HELP_MENU: 'help-menu',
});

const SOURCES = new Set(Object.values(DIAGNOSTIC_SOURCES));
const PROVIDERS = new Set(['mktero', 'mineru', 'mistral']);
const ENDPOINTS = new Set(['cloud', 'local']);
const JOB_PROVIDERS = new Set(['mktero', 'mineru', 'mineru-local']);
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const OS_LABELS = Object.freeze({
    Darwin: 'macOS',
    WINNT: 'Windows',
    Linux: 'Linux',
});

// buildDiagnosticReport copies only the fields a maintainer needs. Callers
// cannot add tokens or paths by passing extra environment properties.
export function buildDiagnosticReport({
    environment = {},
    logEntries = [],
    jobs = [],
    note = '',
    source = DIAGNOSTIC_SOURCES.HELP_MENU,
    failure = null,
    generatedAt,
} = {}) {
    const report = {
        schemaVersion: DIAGNOSTIC_REPORT_VERSION,
        generatedAt: normalizeTime(generatedAt),
        source: SOURCES.has(source) ? source : DIAGNOSTIC_SOURCES.HELP_MENU,
        note: clip(redactDiagnosticText(note), DIAGNOSTIC_NOTE_LIMIT),
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
        account: { signedIn: environment.account?.signedIn === true },
        jobs: normalizeJobs(jobs),
        log: normalizeLog(logEntries),
    };
    const context = normalizeContext(environment.context);
    if (context) report.context = context;
    const normalizedFailure = normalizeFailure(failure);
    if (normalizedFailure) report.failure = normalizedFailure;
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

// summarizeDiagnosticReport turns a built report into the few lines a user
// reads before sharing it. It reads only the normalized report.
export function summarizeDiagnosticReport(report, translate) {
    const t = typeof translate === 'function' ? translate : key => key;
    const versions = [
        report?.plugin?.version ? `Mktero ${report.plugin.version}` : '',
        report?.zotero?.version ? `Zotero ${report.zotero.version}` : '',
        osLabel(report?.os),
    ].filter(Boolean).join(' · ');
    const lines = [
        { label: t('diagnostics.summaryVersions'), value: versions || '—' },
        {
            label: t('diagnostics.summaryConverter'),
            value: converterLabel(report?.conversion, t),
        },
        {
            label: t('diagnostics.summaryItem'),
            value: report?.context?.itemKey
                || (report?.context?.itemID ? String(report.context.itemID) : '')
                || t('diagnostics.summaryNoItem'),
        },
    ];
    if (report?.failure?.code) {
        lines.push({
            label: t('diagnostics.summaryError'),
            value: [report.failure.code, report.failure.serviceCode]
                .filter(Boolean)
                .join(' · '),
        });
    }
    const log = Array.isArray(report?.log) ? report.log : [];
    lines.push({
        label: t('diagnostics.summaryActivity'),
        value: t('diagnostics.summaryActivityValue', {
            jobs: Array.isArray(report?.jobs) ? report.jobs.length : 0,
            lines: log.length,
            errors: log.filter(entry => entry.level === 'error').length,
        }),
    });
    return lines;
}

function osLabel(os) {
    const name = OS_LABELS[os?.name] || os?.name || '';
    return [name, os?.version].filter(Boolean).join(' ');
}

function converterLabel(conversion, t) {
    switch (conversion?.provider) {
    case 'mktero':
        return t('diagnostics.converterMktero');
    case 'mineru':
        return conversion.mineruEndpoint === 'local'
            ? t('diagnostics.converterMinerULocal')
            : 'MinerU';
    case 'mistral':
        return 'Mistral OCR';
    default:
        return '—';
    }
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

function normalizeFailure(failure) {
    const code = clean(failure?.code, 80);
    if (!ERROR_CODE.test(code)) return null;
    const result = { code };
    const serviceCode = clean(failure?.serviceCode, 80);
    if (ERROR_CODE.test(serviceCode) && serviceCode !== code) {
        result.serviceCode = serviceCode;
    }
    return result;
}

function normalizeJobs(jobs) {
    if (!Array.isArray(jobs)) return [];
    return jobs.slice(-20).flatMap(job => {
        const provider = String(job?.provider || '');
        const id = String(job?.id || '');
        if (!JOB_PROVIDERS.has(provider)) return [];
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
