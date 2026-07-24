export const CONVERSION_PROGRESS = Object.freeze({
    PREPARING: 2,
    UPLOADING: 5,
    PARSING: 10,
    QUEUED: 12,
    PARSING_MIN: 15,
    PARSING_FALLBACK: 20,
    PARSING_MAX: 90,
    DOWNLOADING: 95,
    COMPLETE: 100,
});

export function normalizeConversionProgress(progress) {
    const value = Number(progress);
    if (!Number.isFinite(value)) return 0;
    return Math.min(CONVERSION_PROGRESS.COMPLETE, Math.max(0, Math.round(value)));
}
