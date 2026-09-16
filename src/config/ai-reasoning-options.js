import { AI_PROVIDER_CUSTOM, AI_PROVIDER_OPENAI_COMPATIBLE } from './ai-preferences.js';

export const STATIC_AI_REASONING_LEVELS = Object.freeze([
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
]);

const KNOWN_EFFORT_VALUES = new Set([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]);

export function resolveAIReasoningLevels(settings = {}, catalog) {
    if (!catalog?.providers) return [...STATIC_AI_REASONING_LEVELS];
    const model = String(settings.model || '').trim();
    const providerId = resolveCatalogProviderId(settings, catalog);
    if (providerId) {
        const record = findProviderModel(catalog.providers[providerId], model);
        return record
            ? levelsFromRecord(record)
            : [...STATIC_AI_REASONING_LEVELS];
    }
    return resolveGlobalModelLevels(model, catalog);
}

export function selectAIReasoningValue(levels, current) {
    const available = Array.isArray(levels)
        ? levels
        : STATIC_AI_REASONING_LEVELS;
    if (!available.length) return 'none';
    const value = String(current || '').trim();
    if (available.includes(value)) return value;
    if (available.includes('medium')) return 'medium';
    return available[0] || 'none';
}

function resolveCatalogProviderId(settings, catalog) {
    const provider = String(settings.provider || '').trim();
    if (provider
        && provider !== AI_PROVIDER_CUSTOM
        && provider !== AI_PROVIDER_OPENAI_COMPATIBLE) {
        return Object.hasOwn(catalog.providers, provider) ? provider : '';
    }
    const host = hostnameFromApiBase(settings.apiBase);
    if (!host) return '';
    return catalog.hosts?.[host] || '';
}

function resolveGlobalModelLevels(model, catalog) {
    if (!model) return [...STATIC_AI_REASONING_LEVELS];
    const hits = [];
    for (const [providerId, models] of Object.entries(catalog.providers || {})) {
        const record = findProviderModel(models, model);
        if (record) hits.push({ providerId, record });
    }
    if (!hits.length) return [...STATIC_AI_REASONING_LEVELS];
    const labs = new Set(catalog.labProviders || []);
    const labHits = hits.filter(hit => labs.has(hit.providerId));
    return levelsFromRecord((labHits.length ? labHits : hits)[0].record);
}

function findProviderModel(models, model) {
    if (!models || !model) return null;
    const keys = modelLookupKeys(model);
    const entries = Object.entries(models);
    for (const key of keys) {
        for (const [id, record] of entries) {
            if (id.toLowerCase() === key) return record;
        }
    }
    const leaf = keys[keys.length - 1];
    const leafHits = entries.filter(([id]) => modelLeaf(id) === leaf);
    return leafHits.length === 1 ? leafHits[0][1] : null;
}

function levelsFromRecord(record) {
    if (!record?.reasoning) return ['none'];
    const options = Array.isArray(record.options) ? record.options : [];
    const effort = options.find(option => option?.type === 'effort');
    const hasToggle = options.some(option => option?.type === 'toggle');
    const values = [];
    for (const value of effort?.values || []) {
        const mapped = mapEffortValue(value);
        if (mapped && !values.includes(mapped)) values.push(mapped);
    }
    const canDisable = values.includes('none') || hasToggle;
    if (values.length) {
        if (canDisable && !values.includes('none')) values.unshift('none');
        return moveNoneFirst(values);
    }
    if (hasToggle) return ['none', 'on'];
    return [...STATIC_AI_REASONING_LEVELS];
}

function mapEffortValue(value) {
    if (value == null || value === 'none') return 'none';
    const effort = String(value).trim();
    return KNOWN_EFFORT_VALUES.has(effort) ? effort : '';
}

function moveNoneFirst(values) {
    if (!values.includes('none') || values[0] === 'none') return values;
    return ['none', ...values.filter(value => value !== 'none')];
}

function modelLookupKeys(model) {
    const normalized = String(model || '').trim().toLowerCase();
    if (!normalized) return [];
    const leaf = modelLeaf(normalized);
    return leaf === normalized ? [normalized] : [normalized, leaf];
}

function modelLeaf(value) {
    const normalized = String(value || '').trim().toLowerCase();
    const index = normalized.lastIndexOf('/');
    return index === -1 ? normalized : normalized.slice(index + 1);
}

function hostnameFromApiBase(value) {
    try {
        return new URL(String(value || '').trim()).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}
