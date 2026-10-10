import { ZOTERO_ANNOTATION_COLORS } from '../core/pdf-annotation.js';

const DEFAULT_NOTE_COLOR = '#ffd400';
const COLOR_NAME_BY_VALUE = new Map(
    ZOTERO_ANNOTATION_COLORS.map(option => [option.value, option.name])
);

export function createEmptyNoteListFilter() {
    return {
        query: '',
        colors: [],
        commentsOnly: false,
    };
}

export function filterNoteList(entries, filter = createEmptyNoteListFilter()) {
    const population = (Array.isArray(entries) ? entries : []).filter(isEntry);
    const criteria = normalizeNoteListFilter(filter);
    const needle = normalizeNoteSearchText(criteria.query);
    const selected = new Set(criteria.colors);
    const populationColorCounts = new Map();
    let commentCount = 0;
    for (const entry of population) {
        if (noteHasComment(entry.annotation)) commentCount += 1;
        addCount(populationColorCounts, noteColor(entry.annotation));
    }

    const base = population.filter(entry => (
        matchesComments(entry, criteria.commentsOnly)
        && matchesQuery(entry, needle)
    ));
    const facetCounts = new Map();
    for (const entry of base) {
        addCount(facetCounts, noteColor(entry.annotation));
    }
    const visible = criteria.colors.length
        ? base.filter(entry => selected.has(noteColor(entry.annotation)))
        : base;
    const populationColors = orderedNoteColors(populationColorCounts);
    const queryActive = needle.length > 0;
    const filterActive = queryActive
        || criteria.colors.length > 0
        || criteria.commentsOnly;

    return {
        entries: visible,
        totalCount: population.length,
        shownCount: visible.length,
        commentCount,
        showSearch: population.length >= 1,
        showCommentsToggle: criteria.commentsOnly
            || (commentCount > 0 && commentCount < population.length),
        showColorFilter: population.length >= 1,
        colors: orderedFilterColors(populationColorCounts).map(value => ({
            value,
            name: COLOR_NAME_BY_VALUE.get(value) || '',
            count: facetCounts.get(value) || 0,
            selected: selected.has(value),
        })),
        populationColors,
        queryActive,
        filterActive,
    };
}

export function reconcileNoteListFilter(filter, result) {
    const criteria = normalizeNoteListFilter(filter);
    const available = new Set(result?.populationColors || []);
    return {
        query: typeof filter?.query === 'string' ? filter.query : '',
        commentsOnly: criteria.commentsOnly,
        colors: criteria.colors.filter(color => available.has(color)),
    };
}

export function findActiveNoteOffset(offsets, readingOffset) {
    const target = Number(readingOffset);
    if (!Number.isFinite(target)) return null;
    let active = null;
    for (const value of offsets || []) {
        const offset = Number(value);
        if (!Number.isFinite(offset) || offset > target) continue;
        if (active === null || offset >= active) active = offset;
    }
    return active;
}

function normalizeNoteListFilter(filter) {
    return {
        query: typeof filter?.query === 'string' ? filter.query : '',
        colors: normalizeSelectedColors(filter?.colors),
        commentsOnly: Boolean(filter?.commentsOnly),
    };
}

function normalizeSelectedColors(colors) {
    if (!Array.isArray(colors)) return [];
    const selected = [];
    for (const color of colors) {
        const value = String(color || '').trim().toLowerCase();
        if (!/^#[0-9a-f]{6}$/.test(value) || selected.includes(value)) continue;
        selected.push(value);
    }
    return selected;
}

function noteColor(annotation) {
    const value = String(annotation?.color || '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(value) ? value : DEFAULT_NOTE_COLOR;
}

function noteHasComment(annotation) {
    return String(annotation?.comment || '').trim().length > 0;
}

function matchesComments(entry, commentsOnly) {
    return !commentsOnly || noteHasComment(entry.annotation);
}

function matchesQuery(entry, needle) {
    if (!needle) return true;
    const annotation = entry.annotation;
    return normalizeNoteSearchText(annotation?.text).includes(needle)
        || normalizeNoteSearchText(annotation?.comment).includes(needle);
}

function normalizeNoteSearchText(value) {
    return String(value || '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function addCount(counts, color) {
    counts.set(color, (counts.get(color) || 0) + 1);
}

function orderedNoteColors(counts) {
    const known = ZOTERO_ANNOTATION_COLORS
        .map(option => option.value)
        .filter(value => counts.has(value));
    return [...known, ...extraNoteColors(counts)];
}

function orderedFilterColors(counts) {
    return [
        ...ZOTERO_ANNOTATION_COLORS.map(option => option.value),
        ...extraNoteColors(counts),
    ];
}

function extraNoteColors(counts) {
    return [...counts.keys()]
        .filter(value => !COLOR_NAME_BY_VALUE.has(value))
        .sort();
}

function isEntry(entry) {
    return Boolean(entry && typeof entry === 'object' && entry.annotation);
}
