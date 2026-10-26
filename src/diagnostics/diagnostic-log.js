import { redactDiagnosticText } from './redact-diagnostics.js';

export const DIAGNOSTIC_LOG_CAPACITY = 200;
export const DIAGNOSTIC_JOB_CAPACITY = 20;
export const DIAGNOSTIC_MESSAGE_LIMIT = 2000;

const LEVELS = new Set(['debug', 'error']);
const JOB_PROVIDERS = new Set(['mktero', 'mineru', 'mineru-local']);

export function createDiagnosticLog({
    capacity = DIAGNOSTIC_LOG_CAPACITY,
    jobCapacity = DIAGNOSTIC_JOB_CAPACITY,
    now = () => new Date().toISOString(),
    redact = redactDiagnosticText,
} = {}) {
    if (!Number.isInteger(capacity) || capacity < 1) {
        throw new TypeError('Diagnostic log capacity must be a positive integer');
    }
    if (!Number.isInteger(jobCapacity) || jobCapacity < 1) {
        throw new TypeError('Diagnostic job capacity must be a positive integer');
    }
    if (typeof now !== 'function' || typeof redact !== 'function') {
        throw new TypeError('Diagnostic log clock and redactor are required');
    }
    const entries = [];
    const jobs = [];

    return {
        record(level, message, at = now()) {
            const text = clip(redact(message), DIAGNOSTIC_MESSAGE_LIMIT);
            if (!text) return false;
            pushRing(entries, {
                level: LEVELS.has(level) ? level : 'debug',
                message: text,
                at: normalizeTime(at),
            }, capacity);
            return true;
        },
        recordError(error, at = now()) {
            return this.record('error', formatDiagnosticError(error), at);
        },
        recordJob(job, at = now()) {
            const record = normalizeJob(job, at, redact);
            if (!record) return false;
            const index = jobs.findIndex(existing => (
                existing.provider === record.provider && existing.id === record.id
            ));
            if (index >= 0) jobs.splice(index, 1);
            pushRing(jobs, record, jobCapacity);
            return true;
        },
        entries() {
            return entries.map(entry => ({ ...entry }));
        },
        jobs() {
            return jobs.map(job => ({ ...job }));
        },
        clear() {
            entries.length = 0;
            jobs.length = 0;
        },
    };
}

// notifyDiagnosticJob reports a conversion id without letting a diagnostic
// failure change the conversion itself.
export function notifyDiagnosticJob(onJob, job) {
    if (typeof onJob !== 'function') return;
    try {
        onJob(job);
    }
    catch {
        // The conversion result is the caller's contract. Diagnostics are not.
    }
}

function formatDiagnosticError(error) {
    if (error == null) return 'Unknown error';
    if (typeof error !== 'object') return String(error);
    const name = cleanToken(error.name, 80) || 'Error';
    const code = cleanToken(error.code, 80);
    const message = error.message == null ? String(error) : String(error.message);
    const stack = typeof error.stack === 'string'
        ? error.stack.split('\n').slice(0, 8).join('\n')
        : '';
    return `${name}${code ? ` [${code}]` : ''}: ${message}${stack ? `\n${stack}` : ''}`;
}

function normalizeJob(job, at, redact) {
    const provider = String(job?.provider || '');
    if (!JOB_PROVIDERS.has(provider)) return null;
    const id = String(job?.id || '').trim();
    if (!id || id.length > 128 || /[\s/?#]/.test(id) || id.includes('://')) {
        return null;
    }
    if (redact(id) !== id) return null;
    return {
        provider,
        id,
        status: cleanToken(job?.status, 32) || 'unknown',
        at: normalizeTime(job?.at || at),
    };
}

function pushRing(items, item, capacity) {
    items.push(item);
    if (items.length > capacity) items.splice(0, items.length - capacity);
}

function clip(value, limit) {
    const text = String(value || '').trim();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 1)}…`;
}

function cleanToken(value, limit) {
    const text = String(value || '').trim();
    if (!text || /[\r\n\0]/.test(text)) return '';
    return text.slice(0, limit);
}

function normalizeTime(value) {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)
        ? text
        : new Date(0).toISOString();
}
