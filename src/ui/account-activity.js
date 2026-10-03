// Pure helpers behind the account activity heat map. They mirror the website
// profile page (mktero-web/profile.js) so both surfaces describe the same
// conversion history the same way.

// The grid covers 53 weeks so the first column can start on a Sunday.
export const ACTIVITY_WINDOW_DAYS = 371;

const MAX_LEVEL = 4;

// activityLevel maps a day's conversion count onto one of five heat levels.
export function activityLevel(count) {
    const value = Number(count);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value === 1) return 1;
    if (value === 2) return 2;
    if (value <= 4) return 3;
    return MAX_LEVEL;
}

// buildActivityGrid turns the server's daily counts into a column-major grid
// padded so that the first cell is a Sunday. Each cell is either a real day or
// a leading pad, which keeps the calendar aligned without date arithmetic in
// the renderer.
export function buildActivityGrid(days) {
    const entries = normalizeDays(days);
    if (!entries.length) return { cells: [], weeks: 0, total: 0 };

    const first = parseDay(entries[0].date);
    const lead = first ? first.getUTCDay() : 0;
    const cells = [];
    for (let index = 0; index < lead; index++) {
        cells.push({ pad: true, date: '', count: 0, level: 0 });
    }

    let total = 0;
    for (const entry of entries) {
        total += entry.count;
        cells.push({
            pad: false,
            date: entry.date,
            count: entry.count,
            level: activityLevel(entry.count),
        });
    }
    return {
        cells,
        weeks: Math.ceil(cells.length / 7),
        total,
    };
}

// activitySummaryText renders the "{total} conversions in the last year" line.
// The localized template keeps the count formatting in the caller's language.
export function activitySummaryText(template, { total, language = 'en' } = {}) {
    const pattern = String(template || '');
    if (!pattern) return '';
    const value = Number.isFinite(Number(total)) && Number(total) > 0
        ? Math.floor(Number(total))
        : 0;
    return pattern.replace(/\{total\}/g, formatCount(value, language));
}

// formatStreakLabel renders a streak count with its localized day form.
export function formatStreakLabel(value, { one = '', other = '' } = {}) {
    const count = Number.isFinite(Number(value)) && Number(value) > 0
        ? Math.floor(Number(value))
        : 0;
    const template = count === 1 ? one : other;
    return String(template || '').replace(/\{count\}/g, String(count));
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

// activityCellTitle is the hover tooltip for one day: "2026-10-03: 3".
export function activityCellTitle(cell) {
    if (!cell || cell.pad) return '';
    return `${cell.date}: ${cell.count}`;
}

function normalizeDays(days) {
    if (!Array.isArray(days)) return [];
    const entries = [];
    for (const day of days) {
        const date = String(day?.date || '').trim();
        if (!date) continue;
        const count = Number(day?.count);
        entries.push({
            date,
            count: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
        });
    }
    return entries.sort((left, right) => left.date.localeCompare(right.date));
}

function parseDay(value) {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatCount(value, language) {
    try {
        return new Intl.NumberFormat(language).format(value);
    }
    catch {
        return String(value);
    }
}
