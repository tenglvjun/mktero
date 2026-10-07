// Date labels for the account conversion counters.

export function formatActivityPeriodLabels(now = new Date(), language = 'en') {
    const date = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
    ));
    const format = (options, fallback) => {
        try {
            return new Intl.DateTimeFormat(language, {
                ...options,
                timeZone: 'UTC',
            }).format(date);
        }
        catch {
            return fallback;
        }
    };
    return {
        month: format({ year: 'numeric', month: 'long' }, date.toISOString().slice(0, 7)),
        today: format({ year: 'numeric', month: 'long', day: 'numeric' }, date.toISOString().slice(0, 10)),
    };
}

// formatMemberSince renders the registration date in the interface language,
// falling back to the raw ISO day when the value cannot be parsed.
export function formatMemberSince(value, language = 'en') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
    try {
        return new Intl.DateTimeFormat(language, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        }).format(date);
    }
    catch {
        return raw.slice(0, 10);
    }
}
