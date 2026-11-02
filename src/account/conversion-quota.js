export const CONVERSION_QUOTA_CHANGED_TOPIC = 'mktero-conversion-quota-changed';

export function notifyConversionQuotaChanged(services) {
    services?.obs?.notifyObservers?.(null, CONVERSION_QUOTA_CHANGED_TOPIC);
}

export function observeConversionQuotaChanged(services, listener) {
    if (!services?.obs?.addObserver || !services?.obs?.removeObserver) return () => {};
    const observer = { observe(_subject, topic) {
        if (topic === CONVERSION_QUOTA_CHANGED_TOPIC) listener();
    } };
    services.obs.addObserver(observer, CONVERSION_QUOTA_CHANGED_TOPIC);
    return () => services.obs.removeObserver(observer, CONVERSION_QUOTA_CHANGED_TOPIC);
}

// A quota response is untrusted. Only display complete, internally coherent snapshots.
export function parseConversionQuota(value) {
    const numbers = ['limit', 'used', 'reserved', 'remaining'];
    if (!value || numbers.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) {
        return null;
    }
    if (value.limit === 0 || value.remaining > value.limit
        || value.remaining !== Math.max(0, value.limit - value.used - value.reserved)) {
        return null;
    }
    const resetAt = validInstant(value.reset_at);
    const serverTime = validInstant(value.server_time);
    if (!resetAt || !serverTime || !['off', 'shadow', 'enforce'].includes(value.mode)) {
        return null;
    }
    return {
        mode: value.mode,
        limit: value.limit,
        used: value.used,
        reserved: value.reserved,
        remaining: value.remaining,
        resetAt,
        serverTime,
    };
}

function validInstant(value) {
    if (typeof value !== 'string'
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
        return null;
    }
    const day = Number(value.slice(8, 10));
    const month = Number(value.slice(5, 7));
    const daysInMonth = new Date(Date.UTC(Number(value.slice(0, 4)), month, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth || month < 1 || month > 12) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function formatQuotaReset(instant, language = 'en') {
    if (!instant) return '';
    const date = new Date(instant);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en', {
        dateStyle: 'medium', timeStyle: 'short',
    }).format(date);
}
