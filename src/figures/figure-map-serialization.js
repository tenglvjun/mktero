import { FIGURE_LIMITS } from './figure-limits.js';
import { assertFigureJSONBudget, validateFigureMap } from './figure-model.js';
import { sha256Hex } from '../core/sha256.js';

export async function serializeFigureMap(map, document, { hash = sha256Hex,
    maxBytes = FIGURE_LIMITS.maxMapBytes } = {}) {
    if (map === null || map === undefined) return null;
    assertFigureJSONBudget(map, { maxBytes });
    const markdownHash = await hash(new TextEncoder().encode(document.markdown));
    validateFigureMap(map, { ...document, markdownHash });
    const value = { ...map, markdownHash };
    validateFigureMap(value, { ...document, markdownHash, persisted: true });
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > maxBytes) throw new RangeError('Figure map exceeds the storage budget');
    return { map: value, json, bytes };
}

export async function parseFigureMapJSON(json, document, { hash = sha256Hex,
    maxBytes = FIGURE_LIMITS.maxMapBytes } = {}) {
    if (typeof json !== 'string' || new TextEncoder().encode(json).length > maxBytes) {
        throw new RangeError('Figure map exceeds the storage budget');
    }
    const map = JSON.parse(json);
    assertFigureJSONBudget(map, { maxBytes });
    const markdownHash = await hash(new TextEncoder().encode(document.markdown));
    return validateFigureMap(map, { ...document, markdownHash, persisted: true });
}
